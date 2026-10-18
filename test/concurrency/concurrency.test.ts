import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Money } from "../../src/shared/domain/money";
import { expectLedgerConsistent } from "../support/database";
import {
  createTestEnvironment,
  openWallet,
  scalar,
  submitWager,
  type Instance,
  type TestEnvironment,
} from "../support/harness";

let env: TestEnvironment;
let instances: Instance[];

const instanceFor = (index: number) => instances[index % instances.length]!;

beforeAll(async () => {
  env = await createTestEnvironment("concurrency", { WORKERS: "references,outbox", LOG_LEVEL: "warn" });
  instances = await Promise.all([env.startInstance("a"), env.startInstance("b"), env.startInstance("c")]);
}, 90_000);

afterAll(async () => {
  await env?.close();
});

const countDebits = (walletId: string) =>
  scalar<number>(env.orm, "select count(*)::int from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'", [walletId]);
const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const balanceOf = (walletId: string) => scalar<string>(env.orm, "select balance::text from wallets where id = ?", [walletId]);

describe("concorrência entre 3 instâncias", () => {
  test("a mesma aposta enviada 50 vezes em paralelo gera um único débito", async () => {
    const wallet = await openWallet(instances[0]!.baseUrl, "1000.00");
    const bet = { walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "25.00", externalTransactionId: "same-bet" };

    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => submitWager(instanceFor(i).baseUrl, bet)));

    const transactionIds = new Set(responses.map((response) => response.body.transactionId));
    expect(responses.every((response) => response.status === 201 || response.status === 200)).toBe(true);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(transactionIds.size).toBe(1);
    expect(responses.every((response) => response.body.balance?.amount === "975.00")).toBe(true);
    expect(await countDebits(wallet.id)).toBe(1);
    expect(await balanceOf(wallet.id)).toBe("975.00");
  }, 60_000);

  test("cenário da seção 8: 100.00 e duas apostas de 80.00 simultâneas, repetido 20 vezes", async () => {
    for (let round = 0; round < 20; round++) {
      const wallet = await openWallet(instances[0]!.baseUrl, "100.00");
      const bet = (i: number) => ({ walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "80.00", externalTransactionId: `b-${round}-${i}` });

      const [first, second] = await Promise.all([submitWager(instanceFor(round).baseUrl, bet(1)), submitWager(instanceFor(round + 1).baseUrl, bet(2))]);
      const statuses = [first.body.status, second.body.status].sort();

      expect(statuses).toEqual(["PROCESSED", "REJECTED"]);
      expect([first, second].find((response) => response.body.status === "REJECTED")?.body.failureCode).toBe("INSUFFICIENT_FUNDS");
      expect(await balanceOf(wallet.id)).toBe("20.00");
      expect(await countDebits(wallet.id)).toBe(1);
    }
  }, 60_000);

  test("hot wallet: 100 apostas de 1.00 contra 50.00 de saldo nunca deixam o saldo negativo", async () => {
    const wallet = await openWallet(instances[0]!.baseUrl, "50.00");

    const responses = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        submitWager(instanceFor(i).baseUrl, { walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "1.00" }),
      ),
    );

    expect(responses.filter((response) => response.body.status === "PROCESSED")).toHaveLength(50);
    expect(responses.filter((response) => response.body.failureCode === "INSUFFICIENT_FUNDS")).toHaveLength(50);
    expect(await balanceOf(wallet.id)).toBe("0.00");
    expect(await countDebits(wallet.id)).toBe(50);
    expect(await scalar(env.orm, "select version from wallets where id = ?", [wallet.id])).toBe(51);
  }, 60_000);

  test("wallets distintas processadas em paralelo não interferem entre si", async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, (_, i) => openWallet(instanceFor(i).baseUrl, "100.00")));

    await Promise.all(
      wallets.flatMap((wallet, w) =>
        Array.from({ length: 10 }, (_, i) =>
          submitWager(instanceFor(w + i).baseUrl, { walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "1.50" }),
        ),
      ),
    );

    for (const wallet of wallets) {
      expect(await balanceOf(wallet.id)).toBe("85.00");
      expect(await countDebits(wallet.id)).toBe(10);
    }
  }, 60_000);

  test("créditos e débitos misturados em paralelo fecham com o ledger", async () => {
    const wallet = await openWallet(instances[0]!.baseUrl, "10.00");
    const operations = Array.from({ length: 60 }, (_, i) => ({
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind: i % 3 === 0 ? "WIN" : "BET",
      amount: i % 3 === 0 ? "2.00" : "1.00",
    }));

    const responses = await Promise.all(operations.map((operation, i) => submitWager(instanceFor(i).baseUrl, operation)));

    const expected = responses.reduce((balance, response, i) => {
      if (response.body.status !== "PROCESSED") {
        return balance;
      }
      const money = brl(operations[i]!.amount);
      return operations[i]!.kind === "WIN" ? balance.add(money) : balance.subtract(money);
    }, brl("10.00"));
    expect(responses.filter((response, i) => operations[i]!.kind === "WIN" && response.body.status === "PROCESSED")).toHaveLength(20);
    expect(await balanceOf(wallet.id)).toBe(expected.toJSON().amount);
  }, 60_000);
});

test("invariante final: saldo == ledger e version == último lançamento em todas as wallets", async () => {
  await expectLedgerConsistent(env.orm);
});
