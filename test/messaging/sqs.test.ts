import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroOrmUnitOfWork } from "../../src/database/mikro-orm-unit-of-work";
import { EventPublisher } from "../../src/messaging/application/ports";
import { PublishOutbox } from "../../src/messaging/application/publish-outbox";
import type { OutboxMessage } from "../../src/messaging/domain/outbox-message";
import { SqsEventPublisher } from "../../src/messaging/infrastructure/sqs";
import { PinoLogger } from "../../src/observability/logger";
import { Telemetry, type ProcessingSource } from "../../src/shared/application/ports";
import { SystemClock } from "../../src/shared/infrastructure/system";
import { expectLedgerConsistent } from "../support/database";
import {
  createTestEnvironment,
  drainQueue,
  openWallet,
  queueIsEmpty,
  scalar,
  sendRawMessage,
  sendWagerMessage,
  submitWager,
  waitFor,
  type Instance,
  type TestEnvironment,
} from "../support/harness";

class SilentTelemetry extends Telemetry {
  transactionSettled(_status: string, _source: ProcessingSource, _durationSeconds: number): void {}
  duplicateDetected(): void {}
  idempotencyConflict(): void {}
  retry(): void {}
  lockConflict(): void {}
  deadLettered(): void {}
  reconciliationDivergence(): void {}
  outboxPublished(): void {}
}

class RecordingPublisher extends EventPublisher {
  readonly published: string[] = [];

  constructor(private readonly inner: EventPublisher) {
    super();
  }

  async publish(message: OutboxMessage): Promise<void> {
    await this.inner.publish(message);
    this.published.push(message.id);
  }
}

let env: TestEnvironment;
let api: Instance;

const transactionsFor = (externalTransactionId: string) =>
  scalar<number>(env.orm, "select count(*)::int from wager_transactions where external_transaction_id = ?", [externalTransactionId]);
const statusOf = (externalTransactionId: string) =>
  scalar<string | undefined>(env.orm, "select status from wager_transactions where external_transaction_id = ?", [externalTransactionId]);

beforeAll(async () => {
  env = await createTestEnvironment("messaging");
  api = await env.startInstance("api", { WORKERS: "none" });
}, 60_000);

afterAll(async () => {
  await env?.close();
});

describe("consumidor SQS", () => {
  test("processa a mensagem e deduplica a redelivery pelo inbox", async () => {
    const worker = await env.startInstance("consumer-1", { WORKERS: "consumer" });
    const wallet = await openWallet(api.baseUrl, "100.00");
    const message = await sendWagerMessage(env, { walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "30.00" });
    await sendWagerMessage(env, { walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "30.00", ...message });

    await waitFor(async () => (await statusOf(message.externalTransactionId)) === "PROCESSED");
    await waitFor(async () => (await scalar<number>(env.orm, "select count(*)::int from inbox_messages where message_id = ?", [message.messageId])) === 1);
    await Bun.sleep(1_500);

    expect(await transactionsFor(message.externalTransactionId)).toBe(1);
    expect(await scalar(env.orm, "select balance::text from wallets where id = ?", [wallet.id])).toBe("70.00");
    await worker.stop();
  }, 60_000);

  test("mensagem malformada e payload inválido vão direto para a DLQ", async () => {
    const worker = await env.startInstance("consumer-2", { WORKERS: "consumer" });
    const wallet = await openWallet(api.baseUrl, "10.00");
    await sendRawMessage(env, "{isto não é json");
    await sendWagerMessage(env, { walletId: wallet.id, playerId: wallet.playerId, kind: "OPENING", amount: "10.00" });

    const deadLetters = await waitFor(async () => {
      const collected = await drainQueue(env.sqs, env.queues.wagerDlq, { idleRounds: 1 });
      return collected.length > 0 ? collected : undefined;
    });
    const more = await drainQueue(env.sqs, env.queues.wagerDlq, { idleRounds: 2 });
    const reasons = [...deadLetters, ...more].map((message) => message.MessageAttributes?.deadLetterReason?.StringValue).sort();

    expect(reasons).toEqual(["invalid_payload", "malformed_message"]);
    await worker.stop();
  }, 60_000);

  test("falha transitória (lock ocupado) é refeita com backoff e processada quando o lock libera", async () => {
    const worker = await env.startInstance("consumer-3", { WORKERS: "consumer", LOCK_TIMEOUT_MS: "300" });
    const wallet = await openWallet(api.baseUrl, "100.00");
    const em = env.orm.em.fork();
    await em.begin();
    await em.execute("select * from wallets where id = ? for update", [wallet.id]);

    const message = await sendWagerMessage(env, { walletId: wallet.id, playerId: wallet.playerId, kind: "WIN", amount: "5.00" });
    await waitFor(() => Bun.file(worker.logFile).text().then((log) => log.includes("falha transitória")), { timeoutMs: 10_000 });
    await em.rollback();

    await waitFor(async () => (await statusOf(message.externalTransactionId)) === "PROCESSED", { timeoutMs: 20_000 });
    expect(await transactionsFor(message.externalTransactionId)).toBe(1);
    await worker.stop();
  }, 60_000);

  test("tentativas esgotadas: a redrive policy move a mensagem para a DLQ", async () => {
    const worker = await env.startInstance("consumer-4", { WORKERS: "consumer", LOCK_TIMEOUT_MS: "200" });
    const wallet = await openWallet(api.baseUrl, "100.00");
    const em = env.orm.em.fork();
    await em.begin();
    await em.execute("select * from wallets where id = ? for update", [wallet.id]);
    try {
      const message = await sendWagerMessage(env, { walletId: wallet.id, playerId: wallet.playerId, kind: "WIN", amount: "5.00" });
      const deadLetters = await waitFor(
        async () => {
          const collected = await drainQueue(env.sqs, env.queues.wagerDlq, { idleRounds: 1 });
          return collected.find((item) => item.Body?.includes(message.messageId));
        },
        { timeoutMs: 45_000, intervalMs: 500 },
      );
      expect(deadLetters).toBeDefined();
      expect(await transactionsFor(message.externalTransactionId)).toBe(0);
    } finally {
      await em.rollback();
      await worker.stop();
    }
  }, 60_000);

  test("worker morto depois do commit e antes do ack: outra instância recebe de novo e o inbox evita o efeito duplicado", async () => {
    const wallet = await openWallet(api.baseUrl, "100.00");
    const crashing = env.spawnInstance("crash", { WORKERS: "consumer" }, "test/support/crash-after-commit.ts");
    const message = await sendWagerMessage(env, { walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "10.00" });

    expect(await crashing.process.exited).toBe(86);
    expect(await statusOf(message.externalTransactionId)).toBe("PROCESSED");

    const recovered = await env.startInstance("recovery", { WORKERS: "consumer" });
    await waitFor(() => Bun.file(recovered.logFile).text().then((log) => log.includes(`"messageId":"${message.messageId}"`)), {
      timeoutMs: 20_000,
    });
    const log = await Bun.file(recovered.logFile).text();

    expect(log).toContain('"idempotentReplay":true');
    expect(await transactionsFor(message.externalTransactionId)).toBe(1);
    expect(await scalar(env.orm, "select balance::text from wallets where id = ?", [wallet.id])).toBe("90.00");
    await recovered.stop();
  }, 60_000);

  test("ROLLBACK entregue antes da BET pela fila é aplicado quando a BET chega", async () => {
    const worker = await env.startInstance("consumer-5", {
      WORKERS: "consumer,references",
      REFERENCE_RETRY_MAX_ATTEMPTS: "20",
      REFERENCE_RETRY_MAX_MS: "500",
    });
    const wallet = await openWallet(api.baseUrl, "100.00");
    const base = { walletId: wallet.id, playerId: wallet.playerId };

    const rollback = await sendWagerMessage(env, { ...base, kind: "ROLLBACK", amount: "20.00", referenceExternalTransactionId: "queued-bet" });
    await waitFor(async () => (await statusOf(rollback.externalTransactionId)) === "PENDING_REFERENCE");
    await sendWagerMessage(env, { ...base, kind: "BET", amount: "20.00", externalTransactionId: "queued-bet" });

    await waitFor(async () => (await statusOf(rollback.externalTransactionId)) === "PROCESSED", { timeoutMs: 20_000 });
    expect(await scalar(env.orm, "select balance::text from wallets where id = ?", [wallet.id])).toBe("100.00");
    await worker.stop();
  }, 60_000);

  test("reinício no meio do processamento: tudo processado exatamente uma vez", async () => {
    const wallets = await Promise.all(Array.from({ length: 3 }, () => openWallet(api.baseUrl, "100.00")));
    const sent: { messageId: string; externalTransactionId: string }[] = [];
    for (let i = 0; i < 30; i++) {
      const wallet = wallets[i % wallets.length]!;
      sent.push(await sendWagerMessage(env, { walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "1.00" }));
    }

    const first = await env.startInstance("restart-1", { WORKERS: "consumer" });
    await waitFor(async () => (await scalar<number>(env.orm, "select count(*)::int from inbox_messages")) >= 5);
    await first.stop("SIGKILL");
    const second = await env.startInstance("restart-2", { WORKERS: "consumer" });

    await waitFor(
      async () => {
        const processed = await scalar<number>(
          env.orm,
          `select count(*)::int from wager_transactions where external_transaction_id in (?)`,
          [sent.map((item) => item.externalTransactionId)],
        );
        return processed === sent.length;
      },
      { timeoutMs: 30_000 },
    );
    for (const wallet of wallets) {
      expect(await scalar(env.orm, "select balance::text from wallets where id = ?", [wallet.id])).toBe("90.00");
    }
    await second.stop();
  }, 90_000);

  test("atomicidade pela fila: falha na outbox desfaz transação, lançamento, saldo e inbox, e a mensagem é reprocessada uma vez", async () => {
    const worker = await env.startInstance("consumer-atomic", { WORKERS: "consumer" });
    const wallet = await openWallet(api.baseUrl, "100.00");
    const em = env.orm.em.fork();
    await em.execute(`
      create or replace function test_fail_outbox_sqs() returns trigger language plpgsql as $$
      begin
        if new.event_type = 'WalletBalanceChanged' and new.payload -> 'data' ->> 'walletId' = '${wallet.id}' then
          raise exception 'falha simulada na outbox';
        end if;
        return new;
      end;
      $$`);
    await em.execute(
      "create trigger test_fail_outbox_sqs before insert on outbox_messages for each row execute function test_fail_outbox_sqs()",
    );

    let message: { messageId: string; externalTransactionId: string };
    try {
      message = await sendWagerMessage(env, { walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "10.00" });
      await waitFor(
        () =>
          Bun.file(worker.logFile)
            .text()
            .then((log) => log.split("\n").some((line) => line.includes(message.messageId) && line.includes("nova tentativa"))),
        { timeoutMs: 15_000 },
      );

      expect(await transactionsFor(message.externalTransactionId)).toBe(0);
      expect(await scalar(env.orm, "select count(*)::int from inbox_messages where message_id = ?", [message.messageId])).toBe(0);
      expect(await scalar(env.orm, "select count(*)::int from wallet_ledger_entries where wallet_id = ?", [wallet.id])).toBe(1);
      expect(await scalar(env.orm, "select balance::text from wallets where id = ?", [wallet.id])).toBe("100.00");
    } finally {
      await em.execute("drop trigger if exists test_fail_outbox_sqs on outbox_messages");
      await em.execute("drop function if exists test_fail_outbox_sqs()");
    }

    await waitFor(async () => (await statusOf(message.externalTransactionId)) === "PROCESSED", { timeoutMs: 20_000 });
    expect(await transactionsFor(message.externalTransactionId)).toBe(1);
    expect(await scalar(env.orm, "select count(*)::int from inbox_messages where message_id = ?", [message.messageId])).toBe(1);
    expect(await scalar(env.orm, "select balance::text from wallets where id = ?", [wallet.id])).toBe("90.00");
    await worker.stop();
  }, 60_000);

  test("três consumidores, grupos FIFO diferentes e mensagens duplicadas na mesma wallet: o saldo nunca fica negativo", async () => {
    const wallet = await openWallet(api.baseUrl, "30.00");
    const sent: { messageId: string; externalTransactionId: string }[] = [];
    for (let i = 0; i < 60; i++) {
      const message = await sendWagerMessage(env, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: "BET",
        amount: "1.00",
        groupId: `grupo-${i % 6}`,
      });
      sent.push(message);
      await sendWagerMessage(env, { walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "1.00", groupId: `grupo-${(i + 3) % 6}`, ...message });
    }

    const consumers = await Promise.all(
      ["c1", "c2", "c3"].map((name) => env.startInstance(`multi-${name}`, { WORKERS: "consumer" })),
    );
    await waitFor(
      async () =>
        (await scalar<number>(env.orm, "select count(*)::int from wager_transactions where wallet_id = ? and kind = 'BET'", [wallet.id])) ===
          sent.length && (await queueIsEmpty(env.sqs, env.queues.wager)),
      { timeoutMs: 45_000, intervalMs: 250 },
    );

    const logs = await Promise.all(consumers.map((consumer) => Bun.file(consumer.logFile).text()));
    const processedBy = logs.map((log) => log.split("\n").filter((line) => line.includes(`"walletId":"${wallet.id}"`)).length);
    expect(processedBy.filter((count) => count > 0).length).toBeGreaterThanOrEqual(2);

    expect(
      await scalar(env.orm, "select count(*)::int from wager_transactions where wallet_id = ? and status = 'PROCESSED' and kind = 'BET'", [wallet.id]),
    ).toBe(30);
    expect(
      await scalar(env.orm, "select count(*)::int from wager_transactions where wallet_id = ? and failure_code = 'INSUFFICIENT_FUNDS'", [wallet.id]),
    ).toBe(30);
    expect(await scalar(env.orm, "select balance::text from wallets where id = ?", [wallet.id])).toBe("0.00");
    expect(await scalar(env.orm, "select version from wallets where id = ?", [wallet.id])).toBe(31);
    expect(
      await scalar(env.orm, "select count(*)::int from inbox_messages where message_id in (?)", [sent.map((message) => message.messageId)]),
    ).toBe(60);
    await Promise.all(consumers.map((consumer) => consumer.stop()));
  }, 90_000);

  test.skipIf(process.platform === "win32")("SIGTERM conclui ou devolve as mensagens em voo antes de encerrar", async () => {
    const wallet = await openWallet(api.baseUrl, "100.00");
    const worker = await env.startInstance("graceful", { WORKERS: "consumer" });
    const sent: { messageId: string; externalTransactionId: string }[] = [];
    for (let i = 0; i < 10; i++) {
      sent.push(await sendWagerMessage(env, { walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "1.00" }));
    }
    await waitFor(async () => (await scalar<number>(env.orm, "select count(*)::int from wager_transactions where wallet_id = ? and kind = 'BET'", [wallet.id])) >= 1);

    await worker.stop("SIGTERM");
    const log = await Bun.file(worker.logFile).text();
    expect(log).toContain('"msg":"consumidor encerrado"');
    expect(log).not.toContain("encerrado por timeout");

    const next = await env.startInstance("after-graceful", { WORKERS: "consumer" });
    await waitFor(
      async () => (await scalar<number>(env.orm, "select count(*)::int from wager_transactions where wallet_id = ? and kind = 'BET'", [wallet.id])) === 10,
      { timeoutMs: 30_000 },
    );
    expect(await scalar(env.orm, "select balance::text from wallets where id = ?", [wallet.id])).toBe("90.00");
    await next.stop();
  }, 90_000);
});

describe("outbox", () => {
  test("eventos confirmados chegam à fila de eventos, um por eventId", async () => {
    await drainQueue(env.sqs, env.queues.events, { idleRounds: 1 });
    const wallet = await openWallet(api.baseUrl, "100.00");
    await submitWager(api.baseUrl, { walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "10.00" });
    await submitWager(api.baseUrl, { walletId: wallet.id, playerId: wallet.playerId, kind: "LOSS", amount: "0.00" });

    const publisher = await env.startInstance("publisher", { WORKERS: "outbox" });
    await waitFor(async () => (await scalar<number>(env.orm, "select count(*)::int from outbox_messages where published_at is null")) === 0);
    const events = (await drainQueue(env.sqs, env.queues.events)).map((message) => JSON.parse(message.Body!));
    const forWallet = events.filter((event) => event.data.walletId === wallet.id);

    expect(new Set(forWallet.map((event) => event.eventId)).size).toBe(forWallet.length);
    expect(forWallet.map((event) => event.eventType).sort()).toEqual([
      "WagerTransactionProcessed",
      "WagerTransactionProcessed",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
      "WalletBalanceChanged",
    ]);
    const balanceChange = forWallet.find((event) => event.eventType === "WalletBalanceChanged" && event.data.walletVersion === 2);
    expect(balanceChange.data).toMatchObject({ direction: "DEBIT", money: { amount: "10.00", currency: "BRL" } });
    await publisher.stop();
  }, 60_000);

  test("dois publishers concorrentes sobre a mesma outbox publicam cada evento uma vez", async () => {
    const wallet = await openWallet(api.baseUrl, "1000.00");
    await Promise.all(
      Array.from({ length: 40 }, () => submitWager(api.baseUrl, { walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "1.00" })),
    );
    const pending = await scalar<number>(env.orm, "select count(*)::int from outbox_messages where published_at is null");
    expect(pending).toBeGreaterThanOrEqual(80);

    const uow = new MikroOrmUnitOfWork(env.orm, 5_000, new SilentTelemetry(), new SystemClock());
    const real = new SqsEventPublisher(env.sqs, env.queues.events);
    const recorders = [new RecordingPublisher(real), new RecordingPublisher(real)];
    const publishers = recorders.map(
      (recorder) =>
        new PublishOutbox(uow, recorder, new SystemClock(), new SilentTelemetry(), PinoLogger.create("silent"), { batchSize: 7, leaseMs: 30_000 }),
    );

    const drain = async (publisher: PublishOutbox) => {
      while ((await publisher.runOnce()) > 0) {}
    };
    await Promise.all(publishers.map(drain));

    const all = recorders.flatMap((recorder) => recorder.published);
    expect(recorders.every((recorder) => recorder.published.length > 0)).toBe(true);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(pending);
    expect(await scalar(env.orm, "select count(*)::int from outbox_messages where published_at is null")).toBe(0);
    await drainQueue(env.sqs, env.queues.events, { idleRounds: 1 });
  }, 60_000);

  test("publisher que morre depois de reservar: o lease expira, outro publica, e a fila guarda uma cópia por eventId", async () => {
    const wallet = await openWallet(api.baseUrl, "100.00");
    await submitWager(api.baseUrl, { walletId: wallet.id, playerId: wallet.playerId, kind: "WIN", amount: "1.00" });
    const uow = new MikroOrmUnitOfWork(env.orm, 5_000, new SilentTelemetry(), new SystemClock());

    const abandoned = await uow.run((repos) => repos.outbox.claimDue(100, 500));
    const real = new SqsEventPublisher(env.sqs, env.queues.events);
    await Promise.all(abandoned.map((message) => real.publish(message)));

    const recorder = new RecordingPublisher(real);
    const survivor = new PublishOutbox(uow, recorder, new SystemClock(), new SilentTelemetry(), PinoLogger.create("silent"), {
      batchSize: 100,
      leaseMs: 30_000,
    });
    expect(await survivor.runOnce()).toBe(0);
    await Bun.sleep(700);
    await survivor.runOnce();

    expect(recorder.published.sort()).toEqual(abandoned.map((message) => message.id).sort());
    const delivered = (await drainQueue(env.sqs, env.queues.events)).map((message) => JSON.parse(message.Body!).eventId);
    for (const id of abandoned.map((message) => message.id)) {
      expect(delivered.filter((eventId) => eventId === id)).toHaveLength(1);
    }
  }, 60_000);
});

test("invariante final: saldo == ledger em todas as wallets", async () => {
  await expectLedgerConsistent(env.orm);
});
