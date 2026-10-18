import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { createTestDatabase } from "../support/database";

let orm: MikroORM;

beforeAll(async () => {
  orm = await createTestDatabase();
});

afterAll(async () => {
  await orm?.close(true);
});

const HASH = "0".repeat(64);
const uuid = () => crypto.randomUUID();

function tx(work: (em: EntityManager) => Promise<unknown>) {
  return orm.em.fork().transactional(work);
}

interface TxRow {
  id?: string;
  walletId: string;
  playerId: string;
  kind: string;
  amount: string;
  status: string;
  providerId?: string;
  externalId?: string;
  idempotencyKey?: string;
  referenceExternalId?: string | null;
  referenceTransactionId?: string | null;
  failureCode?: string | null;
  balanceAfter?: string | null;
}

async function insertTransaction(em: EntityManager, row: TxRow): Promise<string> {
  const id = row.id ?? uuid();
  const providerId = row.providerId ?? "provider-a";
  const externalId = row.externalId ?? `ext-${id}`;
  await em.execute(
    `insert into wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
        round_id, game_id, kind, amount, currency, reference_external_transaction_id,
        reference_transaction_id, status, failure_code, balance_after, processed_at)
     values (?, ?, ?, ?, ?, ?, ?, 'round-1', 'game-1', ?, ?, 'BRL', ?, ?, ?, ?, ?,
             case when ? = 'PROCESSED' then now() end)`,
    [
      id, providerId, externalId, row.idempotencyKey ?? `${providerId}:${externalId}`, HASH,
      row.walletId, row.playerId, row.kind, row.amount, row.referenceExternalId ?? null,
      row.referenceTransactionId ?? null, row.status, row.failureCode ?? null,
      row.balanceAfter ?? null, row.status,
    ],
  );
  return id;
}

async function insertLedger(
  em: EntityManager,
  e: { walletId: string; transactionId: string; direction: string; amount: string;
       before: string; after: string; version: number; currency?: string },
) {
  await em.execute(
    `insert into wallet_ledger_entries
       (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuid(), e.walletId, e.transactionId, e.direction, e.amount, e.currency ?? "BRL", e.before, e.after, e.version],
  );
}

async function openWallet(balance: string) {
  const walletId = uuid();
  const playerId = uuid();
  await tx(async (em) => {
    await em.execute(
      `insert into wallets (id, player_id, currency, balance, version) values (?, ?, 'BRL', ?, 1)`,
      [walletId, playerId, balance],
    );
    if (Number(balance) > 0) {
      const openingId = await insertTransaction(em, {
        walletId, playerId, kind: "OPENING", amount: balance, status: "PROCESSED",
        providerId: "internal", externalId: `opening:${walletId}`, balanceAfter: balance,
      });
      await insertLedger(em, {
        walletId, transactionId: openingId, direction: "CREDIT", amount: balance,
        before: "0.00", after: balance, version: 1,
      });
    }
  });
  return { walletId, playerId };
}

async function applyBet(w: { walletId: string; playerId: string }, amount: string, before: string, after: string, version: number) {
  let betId = "";
  await tx(async (em) => {
    betId = await insertTransaction(em, { ...w, kind: "BET", amount, status: "PROCESSED", balanceAfter: after });
    await insertLedger(em, { walletId: w.walletId, transactionId: betId, direction: "DEBIT", amount, before, after, version });
    await em.execute(`update wallets set balance = ?, version = ? where id = ?`, [after, version, w.walletId]);
  });
  return betId;
}

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const TRIGGER_EXCEPTION = "P0001";

async function expectRejected(promise: Promise<unknown>, sqlState: string, message?: RegExp) {
  const error = await promise.then(
    () => { throw new Error("era esperado que o banco recusasse a operação"); },
    (e: unknown) => e as Error & { code?: string },
  );
  expect(error.code).toBe(sqlState);
  if (message) expect(error.message).toMatch(message);
}

describe("migrations", () => {
  test("são reversíveis: down remove tudo e up recria", async () => {
    const tables = async () =>
      (await orm.em.execute<{ table_name: string }[]>(
        `select table_name from information_schema.tables
          where table_schema = 'public' and table_name <> 'mikro_orm_migrations' order by 1`,
      )).map((r) => r.table_name);

    expect(await tables()).toEqual([
      "inbox_messages", "outbox_messages", "wager_transactions", "wallet_ledger_entries", "wallets",
    ]);
    await orm.migrator.down();
    expect(await tables()).toEqual([]);
    await orm.migrator.up();
    expect(await tables()).toHaveLength(5);
  });
});

describe("fluxo válido", () => {
  test("abrir wallet e aplicar uma BET passam por todas as constraints", async () => {
    const w = await openWallet("100.00");
    await applyBet(w, "80.00", "100.00", "20.00", 2);

    const [wallet] = await orm.em.execute(`select balance, version from wallets where id = ?`, [w.walletId]);
    expect(wallet).toEqual({ balance: "20.00", version: 2 });
  });
});

describe("wallets", () => {
  test("saldo negativo é recusado", async () => {
    await expectRejected(
      tx((em) => em.execute(`insert into wallets (id, player_id, currency, balance, version) values (?, ?, 'BRL', -1, 1)`, [uuid(), uuid()])),
      CHECK_VIOLATION,
    );
  });

  test("uma wallet por player + moeda", async () => {
    const w = await openWallet("0.00");
    await expectRejected(
      tx((em) => em.execute(`insert into wallets (id, player_id, currency, balance, version) values (?, ?, 'BRL', 0, 1)`, [uuid(), w.playerId])),
      UNIQUE_VIOLATION,
    );
  });

  test("saldo não muda sem lançamento no ledger (checado no commit)", async () => {
    const w = await openWallet("100.00");
    await expectRejected(
      tx((em) => em.execute(`update wallets set balance = 50, version = 2 where id = ?`, [w.walletId])),
      TRIGGER_EXCEPTION,
      /sem lançamento no ledger/,
    );
  });

  test("saldo não muda sem incrementar version", async () => {
    const w = await openWallet("100.00");
    await expectRejected(
      tx((em) => em.execute(`update wallets set balance = 50 where id = ?`, [w.walletId])),
      TRIGGER_EXCEPTION,
      /exige version = 2/,
    );
  });

  test("wallet não pode ser excluída", async () => {
    const w = await openWallet("0.00");
    await expectRejected(tx((em) => em.execute(`delete from wallets where id = ?`, [w.walletId])), TRIGGER_EXCEPTION, /não é permitido/);
  });
});

describe("wallet_ledger_entries", () => {
  test("UPDATE e DELETE são bloqueados", async () => {
    const w = await openWallet("100.00");
    await expectRejected(
      tx((em) => em.execute(`update wallet_ledger_entries set amount = 1 where wallet_id = ?`, [w.walletId])),
      TRIGGER_EXCEPTION, /UPDATE .* não é permitido/,
    );
    await expectRejected(
      tx((em) => em.execute(`delete from wallet_ledger_entries where wallet_id = ?`, [w.walletId])),
      TRIGGER_EXCEPTION, /DELETE .* não é permitido/,
    );
  });

  test("aritmética do lançamento é validada", async () => {
    const w = await openWallet("100.00");
    await expectRejected(
      tx(async (em) => {
        const id = await insertTransaction(em, { ...w, kind: "BET", amount: "10.00", status: "PROCESSED", balanceAfter: "95.00" });
        await insertLedger(em, { walletId: w.walletId, transactionId: id, direction: "DEBIT", amount: "10.00", before: "100.00", after: "95.00", version: 2 });
      }),
      CHECK_VIOLATION,
    );
  });

  test("duas escritas a partir da mesma version (lost update) são recusadas", async () => {
    const w = await openWallet("100.00");
    await applyBet(w, "80.00", "100.00", "20.00", 2);
    await expectRejected(applyBet(w, "80.00", "100.00", "20.00", 2), UNIQUE_VIOLATION);
  });

  test("moeda do lançamento precisa ser a da wallet", async () => {
    const w = await openWallet("100.00");
    await expectRejected(
      tx(async (em) => {
        const id = await insertTransaction(em, { ...w, kind: "BET", amount: "10.00", status: "PROCESSED", balanceAfter: "90.00" });
        await insertLedger(em, { walletId: w.walletId, transactionId: id, direction: "DEBIT", amount: "10.00", before: "100.00", after: "90.00", version: 2, currency: "USD" });
      }),
      FOREIGN_KEY_VIOLATION,
    );
  });

  test("um lançamento por transação", async () => {
    const w = await openWallet("100.00");
    const betId = await applyBet(w, "10.00", "100.00", "90.00", 2);
    await expectRejected(
      tx((em) => insertLedger(em, { walletId: w.walletId, transactionId: betId, direction: "DEBIT", amount: "10.00", before: "90.00", after: "80.00", version: 3 })),
      UNIQUE_VIOLATION,
    );
  });

  test("lançamento exige transação PROCESSED (checado no commit)", async () => {
    const w = await openWallet("100.00");
    await expectRejected(
      tx(async (em) => {
        const id = await insertTransaction(em, { ...w, kind: "BET", amount: "10.00", status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });
        await insertLedger(em, { walletId: w.walletId, transactionId: id, direction: "DEBIT", amount: "10.00", before: "100.00", after: "90.00", version: 2 });
        await em.execute(`update wallets set balance = 90, version = 2 where id = ?`, [w.walletId]);
      }),
      TRIGGER_EXCEPTION,
      /precisa estar PROCESSED/,
    );
  });
});

describe("wager_transactions", () => {
  test("(providerId, externalTransactionId) é único", async () => {
    const w = await openWallet("0.00");
    await tx((em) => insertTransaction(em, { ...w, kind: "LOSS", amount: "0.00", status: "PENDING", externalId: "dup-1", idempotencyKey: "k-1" }));
    await expectRejected(
      tx((em) => insertTransaction(em, { ...w, kind: "LOSS", amount: "0.00", status: "PENDING", externalId: "dup-1", idempotencyKey: "k-2" })),
      UNIQUE_VIOLATION,
    );
  });

  test("idempotency key é única", async () => {
    const w = await openWallet("0.00");
    await tx((em) => insertTransaction(em, { ...w, kind: "LOSS", amount: "0.00", status: "PENDING", idempotencyKey: "same-key" }));
    await expectRejected(
      tx((em) => insertTransaction(em, { ...w, kind: "LOSS", amount: "0.00", status: "PENDING", idempotencyKey: "same-key" })),
      UNIQUE_VIOLATION,
    );
  });

  test("REFUND e ROLLBACK exigem referência", async () => {
    const w = await openWallet("0.00");
    await expectRejected(
      tx((em) => insertTransaction(em, { ...w, kind: "REFUND", amount: "10.00", status: "PENDING" })),
      CHECK_VIOLATION,
    );
  });

  test("REJECTED exige failure_code", async () => {
    const w = await openWallet("0.00");
    await expectRejected(
      tx((em) => insertTransaction(em, { ...w, kind: "BET", amount: "10.00", status: "REJECTED" })),
      CHECK_VIOLATION,
    );
  });

  test("estado terminal não muda", async () => {
    const w = await openWallet("100.00");
    const betId = await applyBet(w, "10.00", "100.00", "90.00", 2);
    await expectRejected(
      tx((em) => em.execute(`update wager_transactions set status = 'FAILED', failure_code = 'X', processed_at = null where id = ?`, [betId])),
      TRIGGER_EXCEPTION,
      /estado terminal/,
    );
  });

  test("campos de negócio são imutáveis mesmo fora do estado terminal", async () => {
    const w = await openWallet("0.00");
    const id = await tx((em) => insertTransaction(em, { ...w, kind: "LOSS", amount: "0.00", status: "PENDING" })) as string;
    await expectRejected(
      tx((em) => em.execute(`update wager_transactions set amount = 5 where id = ?`, [id])),
      TRIGGER_EXCEPTION,
      /imutáveis/,
    );
  });

  test("a mesma referência não é revertida duas vezes (REFUND e depois ROLLBACK)", async () => {
    const w = await openWallet("100.00");
    const betId = await applyBet(w, "10.00", "100.00", "90.00", 2);
    const reversal = (kind: string) => ({
      ...w, kind, amount: "10.00", status: "PROCESSED", balanceAfter: "100.00",
      referenceExternalId: `ext-${betId}`, referenceTransactionId: betId,
    });

    await tx(async (em) => {
      const refundId = await insertTransaction(em, reversal("REFUND"));
      await insertLedger(em, { walletId: w.walletId, transactionId: refundId, direction: "CREDIT", amount: "10.00", before: "90.00", after: "100.00", version: 3 });
      await em.execute(`update wallets set balance = 100, version = 3 where id = ?`, [w.walletId]);
    });

    await expectRejected(tx((em) => insertTransaction(em, reversal("ROLLBACK"))), UNIQUE_VIOLATION);
  });
});
