import { describe, expect, test } from "bun:test";
import { InvalidLedgerEntryError } from "../../src/shared/domain/errors";
import { Money } from "../../src/shared/domain/money";
import { LedgerDirection, WalletLedgerEntry, type CreateLedgerEntryProps } from "../../src/wallet/domain/wallet-ledger-entry";
import { NOW, brl } from "../support/domain";

const props = (overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps => ({
  id: "entry-1",
  walletId: "wallet-1",
  transactionId: "tx-1",
  direction: LedgerDirection.Debit,
  money: brl("25.00"),
  balanceBefore: brl("100.00"),
  balanceAfter: brl("75.00"),
  walletVersion: 2,
  createdAt: NOW,
  ...overrides,
});

describe("WalletLedgerEntry.create", () => {
  test("débito e crédito com aritmética correta", () => {
    expect(WalletLedgerEntry.create(props()).isBalanced()).toBe(true);
    const credit = WalletLedgerEntry.create(props({ direction: LedgerDirection.Credit, balanceAfter: brl("125.00") }));
    expect(credit.isBalanced()).toBe(true);
  });

  test.each([
    ["aritmética errada", { balanceAfter: brl("80.00") }],
    ["direção trocada", { direction: LedgerDirection.Credit }],
    ["valor zero", { money: brl("0.00"), balanceAfter: brl("100.00") }],
    ["saldo final negativo", { balanceBefore: brl("10.00"), balanceAfter: brl("10.00").subtract(brl("25.00")) }],
    ["moeda diferente", { money: Money.from({ amount: "25.00", currency: "USD" }) }],
    ["walletVersion zero", { walletVersion: 0 }],
    ["walletVersion fracionária", { walletVersion: 1.5 }],
  ])("recusa %s", (_, overrides) => {
    expect(() => WalletLedgerEntry.create(props(overrides))).toThrow(InvalidLedgerEntryError);
  });
});

describe("imutabilidade", () => {
  test("a instância é congelada: atribuir um campo lança TypeError", () => {
    const entry = WalletLedgerEntry.create(props());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { direction: string }).direction = LedgerDirection.Credit;
    }).toThrow(TypeError);
  });

  test("createdAt é copiado: mexer na data original não altera o lançamento", () => {
    const at = new Date(NOW.getTime());
    const entry = WalletLedgerEntry.create(props({ createdAt: at }));
    at.setFullYear(2000);
    expect(entry.createdAt.toISOString()).toBe(NOW.toISOString());
  });
});
