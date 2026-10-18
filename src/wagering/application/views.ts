import type { MoneyProps } from "../../shared/domain/money";
import type { FailureCode } from "../domain/failure-code";
import type { WagerTransaction, WagerTransactionStatus } from "../domain/wager-transaction";

export interface WagerTransactionResult {
  transactionId: string;
  walletId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps | null;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export interface WagerTransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: WagerTransactionStatus;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  failureCode: FailureCode | null;
  balanceAfter: MoneyProps | null;
  referenceAttempts: number;
  nextAttemptAt: string | null;
  createdAt: string;
  processedAt: string | null;
}

export function toResult(transaction: WagerTransaction, idempotentReplay: boolean): WagerTransactionResult {
  return {
    transactionId: transaction.id,
    walletId: transaction.walletId,
    status: transaction.status,
    balance: transaction.balanceAfter?.toJSON() ?? null,
    ...(transaction.failureCode !== undefined && { failureCode: transaction.failureCode }),
    idempotentReplay,
  };
}

export function toTransactionView(transaction: WagerTransaction): WagerTransactionView {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    balanceAfter: transaction.balanceAfter?.toJSON() ?? null,
    referenceAttempts: transaction.referenceAttempts,
    nextAttemptAt: transaction.nextAttemptAt?.toISOString() ?? null,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}
