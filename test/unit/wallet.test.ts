import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InsufficientFundsError, InvalidWalletError } from "../../src/shared/domain/errors";
import { Money } from "../../src/shared/domain/money";
import { Wallet } from "../../src/wallet/domain/wallet";
import { LedgerDirection } from "../../src/wallet/domain/wallet-ledger-entry";
import { NOW, balanceFromLedger, brl, nextId, openWallet } from "../support/domain";

const movement = (amount: string) => ({ money: brl(amount), transactionId: nextId("tx"), entryId: nextId("entry"), at: NOW });

describe("Wallet.open", () => {
  test("saldo inicial positivo: version 1 e crédito de abertura na própria version 1", () => {
    const { wallet, entries } = openWallet("1000.00");

    expect(wallet.balance.toJSON()).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(wallet.version).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ direction: LedgerDirection.Credit, walletVersion: 1 });
    expect(entries[0]!.balanceBefore.isZero()).toBe(true);
  });

  test("saldo inicial zero: version 1 e nenhum lançamento", () => {
    const { wallet, entries } = openWallet("0.00");
    expect(wallet.version).toBe(1);
    expect(entries).toHaveLength(0);
  });

  test("saldo inicial positivo sem transação OPENING é recusado", () => {
    expect(() => Wallet.open({ id: "w", playerId: "p", initialBalance: brl("10.00"), at: NOW })).toThrow(InvalidWalletError);
  });
});

describe("debit e credit", () => {
  test("cada movimentação gera um lançamento e incrementa a version", () => {
    const { wallet, entries } = openWallet("100.00");

    const debit = wallet.debit(movement("30.00"));
    const credit = wallet.credit(movement("5.50"));

    expect(debit).toMatchObject({ direction: LedgerDirection.Debit, walletVersion: 2 });
    expect(debit.balanceBefore.toJSON().amount).toBe("100.00");
    expect(debit.balanceAfter.toJSON().amount).toBe("70.00");
    expect(credit).toMatchObject({ direction: LedgerDirection.Credit, walletVersion: 3 });
    expect(wallet.balance.toJSON().amount).toBe("75.50");
    expect(wallet.version).toBe(3);
    expect(balanceFromLedger([...entries, debit, credit]).equals(wallet.balance)).toBe(true);
  });

  test("débito acima do saldo lança erro e não altera nada", () => {
    const { wallet } = openWallet("100.00");
    expect(() => wallet.debit(movement("100.01"))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("débito exatamente igual ao saldo zera a wallet", () => {
    const { wallet } = openWallet("80.00");
    wallet.debit(movement("80.00"));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("moeda diferente da wallet lança erro e não altera nada", () => {
    const { wallet } = openWallet("100.00");
    const usd = { ...movement("1.00"), money: Money.from({ amount: "1.00", currency: "USD" }) };
    expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
    expect(() => wallet.canDebit(usd.money)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test("movimentação de valor zero é recusada", () => {
    const { wallet } = openWallet("100.00");
    expect(() => wallet.credit(movement("0.00"))).toThrow(InvalidWalletError);
  });

  test("canDebit", () => {
    const { wallet } = openWallet("20.00");
    expect(wallet.canDebit(brl("20.00"))).toBe(true);
    expect(wallet.canDebit(brl("80.00"))).toBe(false);
  });
});

describe("Wallet.rehydrate", () => {
  test("remonta o estado gravado sem revalidar", () => {
    const at = new Date("2026-01-01T00:00:00Z");
    const wallet = Wallet.rehydrate({
      id: "w", playerId: "p", currency: "BRL", balance: brl("42.00"), version: 7, createdAt: at, updatedAt: NOW,
    });
    expect(wallet.toState()).toEqual({
      id: "w", playerId: "p", currency: "BRL", balance: brl("42.00"), version: 7, createdAt: at, updatedAt: NOW,
    });
  });
});
