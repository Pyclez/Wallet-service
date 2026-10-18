import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { expectLedgerConsistent } from "../support/database";
import {
  createTestEnvironment,
  openWallet,
  request,
  scalar,
  submitWager,
  waitFor,
  type Instance,
  type TestEnvironment,
} from "../support/harness";

let env: TestEnvironment;
let app: Instance;

beforeAll(async () => {
  env = await createTestEnvironment("api");
  app = await env.startInstance("api");
}, 60_000);

afterAll(async () => {
  await env?.close();
});

const api = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
  request(app.baseUrl, method, path, body, headers);

describe("wallets", () => {
  test("criação com saldo inicial gera OPENING e crédito no ledger, com version 1", async () => {
    const playerId = Bun.randomUUIDv7();
    const created = await api("POST", "/wallets", { playerId, initialBalance: { amount: "1000.00", currency: "BRL" } });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ playerId, balance: { amount: "1000.00", currency: "BRL" }, version: 1 });
    const walletId = created.body.id as string;
    expect(await scalar(env.orm, "select kind from wager_transactions where wallet_id = ?", [walletId])).toBe("OPENING");
    expect(await scalar(env.orm, "select count(*)::int from wallet_ledger_entries where wallet_id = ?", [walletId])).toBe(1);
  });

  test("saldo inicial zero não gera lançamento", async () => {
    const wallet = await openWallet(app.baseUrl, "0.00");
    expect(await scalar(env.orm, "select count(*)::int from wallet_ledger_entries where wallet_id = ?", [wallet.id])).toBe(0);
  });

  test("wallet duplicada para o mesmo player e moeda é conflito", async () => {
    const wallet = await openWallet(app.baseUrl, "10.00");
    const duplicated = await api("POST", "/wallets", {
      playerId: wallet.playerId,
      initialBalance: { amount: "5.00", currency: "BRL" },
    });
    expect(duplicated.status).toBe(409);
    expect(duplicated.body).toMatchObject({ error: { code: "WALLET_ALREADY_EXISTS" } });
  });

  test.each([
    ["amount numérico", { amount: 10, currency: "BRL" }],
    ["três casas decimais", { amount: "10.001", currency: "BRL" }],
    ["notação científica", { amount: "1e3", currency: "BRL" }],
    ["valor negativo", { amount: "-1.00", currency: "BRL" }],
  ])("payload inválido (%s) é 400", async (_, initialBalance) => {
    const response = await api("POST", "/wallets", { playerId: Bun.randomUUIDv7(), initialBalance });
    expect(response.status).toBe(400);
  });

  test("consulta: 200, 404 e 400 para id malformado", async () => {
    const wallet = await openWallet(app.baseUrl, "1.00");
    expect((await api("GET", `/wallets/${wallet.id}`)).status).toBe(200);
    expect((await api("GET", `/wallets/${Bun.randomUUIDv7()}`)).status).toBe(404);
    expect((await api("GET", "/wallets/nao-e-uuid")).status).toBe(400);
  });
});

describe("transações via HTTP", () => {
  test("BET processada, replay idêntico e payload conflitante", async () => {
    const wallet = await openWallet(app.baseUrl, "1000.00");
    const bet = { walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "25.00", externalTransactionId: "bet-1" };

    const first = await submitWager(app.baseUrl, bet);
    const replay = await submitWager(app.baseUrl, bet);
    const conflict = await submitWager(app.baseUrl, { ...bet, amount: "26.00" });

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: "PROCESSED", balance: { amount: "975.00" }, idempotentReplay: false });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
  });

  test("Idempotency-Key ausente é 400", async () => {
    const response = await api("POST", "/wagering/transactions", { providerId: "provider-a" });
    expect(response.status).toBe(400);
  });

  test("rejeição de negócio é 422, e o replay devolve o mesmo 422 com o saldo da época", async () => {
    const wallet = await openWallet(app.baseUrl, "20.00");
    const bet = { walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "80.00" };
    const rejected = await submitWager(app.baseUrl, { ...bet, externalTransactionId: "big-bet" });
    await submitWager(app.baseUrl, { walletId: wallet.id, playerId: wallet.playerId, kind: "WIN", amount: "500.00" });
    const replay = await submitWager(app.baseUrl, { ...bet, externalTransactionId: "big-bet" });

    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", balance: { amount: "20.00" } });
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...rejected.body, idempotentReplay: true });
  });

  test("REFUND reverte a BET uma única vez", async () => {
    const wallet = await openWallet(app.baseUrl, "100.00");
    const base = { walletId: wallet.id, playerId: wallet.playerId };
    await submitWager(app.baseUrl, { ...base, kind: "BET", amount: "40.00", externalTransactionId: "r-bet" });

    const refund = await submitWager(app.baseUrl, { ...base, kind: "REFUND", amount: "40.00", referenceExternalTransactionId: "r-bet" });
    const rollback = await submitWager(app.baseUrl, { ...base, kind: "ROLLBACK", amount: "40.00", referenceExternalTransactionId: "r-bet" });

    expect(refund.body).toMatchObject({ status: "PROCESSED", balance: { amount: "100.00" } });
    expect(rollback.status).toBe(422);
    expect(rollback.body).toMatchObject({ failureCode: "REFERENCE_ALREADY_REVERSED" });
  });

  test("ROLLBACK de WIN sem saldo é rejeitado com código próprio", async () => {
    const wallet = await openWallet(app.baseUrl, "0.00");
    const base = { walletId: wallet.id, playerId: wallet.playerId };
    await submitWager(app.baseUrl, { ...base, kind: "WIN", amount: "50.00", externalTransactionId: "w-win" });
    await submitWager(app.baseUrl, { ...base, kind: "BET", amount: "45.00" });

    const rollback = await submitWager(app.baseUrl, { ...base, kind: "ROLLBACK", amount: "50.00", referenceExternalTransactionId: "w-win" });

    expect(rollback.status).toBe(422);
    expect(rollback.body).toMatchObject({ failureCode: "REVERSAL_INSUFFICIENT_FUNDS", balance: { amount: "5.00" } });
  });

  test("ROLLBACK antes da BET fica pendente (202) e é aplicado quando a BET chega", async () => {
    const wallet = await openWallet(app.baseUrl, "100.00");
    const base = { walletId: wallet.id, playerId: wallet.playerId };

    const early = await submitWager(app.baseUrl, { ...base, kind: "ROLLBACK", amount: "30.00", referenceExternalTransactionId: "late-bet" });
    expect(early.status).toBe(202);
    expect(early.body).toMatchObject({ status: "PENDING_REFERENCE" });

    await submitWager(app.baseUrl, { ...base, kind: "BET", amount: "30.00", externalTransactionId: "late-bet" });

    const settled = await waitFor(async () => {
      const view = await api("GET", `/wagering/transactions/${early.body.transactionId}`);
      return view.body.status === "PROCESSED" ? view.body : undefined;
    });
    expect(settled).toMatchObject({ balanceAfter: { amount: "100.00" } });
    expect((await api("GET", `/wallets/${wallet.id}`)).body).toMatchObject({ balance: { amount: "100.00" }, version: 3 });
  });

  test("referência que nunca chega vira REJECTED com REFERENCE_NOT_FOUND e publica evento", async () => {
    const wallet = await openWallet(app.baseUrl, "100.00");
    const pending = await submitWager(app.baseUrl, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind: "REFUND",
      amount: "10.00",
      referenceExternalTransactionId: "never-arrives",
    });

    const view = await waitFor(
      async () => {
        const current = await api("GET", `/wagering/transactions/${pending.body.transactionId}`);
        return current.body.status === "REJECTED" ? current.body : undefined;
      },
      { timeoutMs: 20_000 },
    );
    expect(view).toMatchObject({ failureCode: "REFERENCE_NOT_FOUND", referenceAttempts: 3 });
    expect(
      await scalar(env.orm, "select count(*)::int from outbox_messages where aggregate_id = ? and event_type = 'WagerTransactionRejected'", [
        pending.body.transactionId,
      ]),
    ).toBe(1);
  });

  test("consultas por id interno e por provider + id externo", async () => {
    const wallet = await openWallet(app.baseUrl, "10.00");
    const win = await submitWager(app.baseUrl, { walletId: wallet.id, playerId: wallet.playerId, kind: "WIN", amount: "1.00", externalTransactionId: "q-1" });

    const byId = await api("GET", `/wagering/transactions/${win.body.transactionId}`);
    const byExternal = await api("GET", "/providers/provider-a/wagering/transactions/q-1");

    expect(byId.status).toBe(200);
    expect(byExternal.body).toEqual(byId.body);
    expect((await api("GET", "/providers/provider-a/wagering/transactions/nao-existe")).status).toBe(404);
  });
});

describe("ledger e reconciliação", () => {
  test("paginação por cursor opaco, do mais recente para o mais antigo, sem repetir lançamentos", async () => {
    const wallet = await openWallet(app.baseUrl, "100.00");
    for (let i = 0; i < 4; i++) {
      await submitWager(app.baseUrl, { walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "1.00" });
    }

    const versions: number[] = [];
    let cursor: string | null = null;
    do {
      const page: { status: number; body: { items: { walletVersion: number }[]; nextCursor: string | null } } = await request(
        app.baseUrl,
        "GET",
        `/wallets/${wallet.id}/ledger?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
      );
      expect(page.status).toBe(200);
      versions.push(...page.body.items.map((item) => item.walletVersion));
      cursor = page.body.nextCursor;
    } while (cursor);

    expect(versions).toEqual([5, 4, 3, 2, 1]);
    expect((await api("GET", `/wallets/${wallet.id}/ledger?cursor=lixo`)).status).toBe(400);
  });

  test("reconciliação consistente", async () => {
    const wallet = await openWallet(app.baseUrl, "975.00");
    const report = await api("POST", `/wallets/${wallet.id}/reconciliation`);
    expect(report.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: "975.00", currency: "BRL" },
      calculatedBalance: { amount: "975.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 1,
    });
  });

  test("divergência é sinalizada, contabilizada em métrica e não corrigida", async () => {
    const wallet = await openWallet(app.baseUrl, "50.00");
    const em = env.orm.em.fork();
    await em.execute("alter table wallets disable trigger user");
    try {
      await em.execute("update wallets set balance = 60 where id = ?", [wallet.id]);
    } finally {
      await em.execute("alter table wallets enable trigger user");
    }

    const report = await api("POST", `/wallets/${wallet.id}/reconciliation`);
    const metrics = await fetch(`${app.baseUrl}/metrics`).then((response) => response.text());

    expect(report.body).toMatchObject({ consistent: false, difference: { amount: "10.00" } });
    expect(await scalar(env.orm, "select balance::text from wallets where id = ?", [wallet.id])).toBe("60.00");
    expect(metrics).toMatch(/wallet_reconciliation_divergences_total 1/);

    await em.execute("alter table wallets disable trigger user");
    await em.execute("update wallets set balance = 50 where id = ?", [wallet.id]);
    await em.execute("alter table wallets enable trigger user");
  });
});

describe("atomicidade", () => {
  test("se a gravação da outbox falha, nada da transação financeira é persistido", async () => {
    const wallet = await openWallet(app.baseUrl, "100.00");
    const em = env.orm.em.fork();
    await em.execute(`
      create or replace function test_fail_outbox() returns trigger language plpgsql as $$
      begin
        if new.event_type = 'WalletBalanceChanged' then
          raise exception 'falha simulada na outbox';
        end if;
        return new;
      end;
      $$`);
    await em.execute("create trigger test_fail_outbox before insert on outbox_messages for each row execute function test_fail_outbox()");
    try {
      const response = await submitWager(app.baseUrl, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: "BET",
        amount: "10.00",
        externalTransactionId: "atomic-1",
      });
      expect(response.status).toBe(500);
    } finally {
      await em.execute("drop trigger test_fail_outbox on outbox_messages");
      await em.execute("drop function test_fail_outbox()");
    }

    expect(await scalar(env.orm, "select count(*)::int from wager_transactions where external_transaction_id = 'atomic-1'")).toBe(0);
    expect(await scalar(env.orm, "select count(*)::int from wallet_ledger_entries where wallet_id = ?", [wallet.id])).toBe(1);
    expect(await scalar(env.orm, "select balance::text from wallets where id = ?", [wallet.id])).toBe("100.00");

    const retry = await submitWager(app.baseUrl, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind: "BET",
      amount: "10.00",
      externalTransactionId: "atomic-1",
    });
    expect(retry.status).toBe(201);
  });
});

describe("observabilidade", () => {
  test("readiness e métricas", async () => {
    expect((await api("GET", "/health/live")).body).toEqual({ status: "ok" });
    expect((await api("GET", "/health/ready")).body).toEqual({ status: "ok", checks: { postgres: "up", sqs: "up" } });
    const metrics = await fetch(`${app.baseUrl}/metrics`).then((response) => response.text());
    for (const name of [
      "wallet_wager_transactions_total",
      "wallet_duplicates_detected_total",
      "wallet_idempotency_conflicts_total",
      "wallet_retries_total",
      "wallet_outbox_lag_seconds",
      "wallet_wager_processing_duration_seconds",
    ]) {
      expect(metrics).toContain(name);
    }
  });
});

test("invariante final: saldo de toda wallet == saldo reconstruído pelo ledger", async () => {
  const result = await expectLedgerConsistent(env.orm);
  expect(result.wallets).toBeGreaterThan(10);
});
