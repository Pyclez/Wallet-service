import { Money } from "../../src/shared/domain/money";
import { computePayloadHash } from "../../src/wagering/domain/payload-hash";
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
  type WagerTransactionKind,
} from "../../src/wagering/domain/wager-transaction";
import { Wallet } from "../../src/wallet/domain/wallet";
import { LedgerDirection, type WalletLedgerEntry } from "../../src/wallet/domain/wallet-ledger-entry";

export const NOW = new Date("2026-10-18T12:00:00.000Z");
export const WALLET_ID = "wallet-1";
export const PLAYER_ID = "player-1";

export const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

let sequence = 0;
export const nextId = (prefix: string) => `${prefix}-${++sequence}`;

export function balanceFromLedger(entries: readonly WalletLedgerEntry[], currency = "BRL"): Money {
  return entries.reduce(
    (balance, e) => (e.direction === LedgerDirection.Credit ? balance.add(e.money) : balance.subtract(e.money)),
    Money.zero(currency),
  );
}

export function openWallet(initialBalance = "100.00") {
  const { wallet, openingEntry } = Wallet.open({
    id: WALLET_ID,
    playerId: PLAYER_ID,
    initialBalance: brl(initialBalance),
    at: NOW,
    opening: { transactionId: nextId("opening"), entryId: nextId("entry") },
  });
  return { wallet, entries: openingEntry ? [openingEntry] : [] };
}

export function wager(
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? nextId("ext");
  const props = {
    id: nextId("tx"),
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind,
    money: brl(amount),
    createdAt: NOW,
    ...overrides,
  };
  const payloadHash = computePayloadHash({ ...props, money: props.money.toJSON() });
  return WagerTransaction.create({ ...props, payloadHash: overrides.payloadHash ?? payloadHash });
}
