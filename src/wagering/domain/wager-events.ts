import { IntegrationEvent, type EventContext } from "../../shared/domain/integration-event";
import type { MoneyProps } from "../../shared/domain/money";
import type { FailureCode } from "./failure-code";
import type { WagerTransaction, WagerTransactionKind } from "./wager-transaction";

interface WagerTransactionEventBase {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

export interface WagerTransactionProcessedData extends WagerTransactionEventBase {
  referenceTransactionId?: string;
  balanceAfter: MoneyProps;
}

export interface WagerTransactionRejectedData extends WagerTransactionEventBase {
  failureCode: FailureCode;
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventBase {
  referenceExternalTransactionId: string;
  nextAttemptAt: string;
}

function baseData(tx: WagerTransaction): WagerTransactionEventBase {
  return {
    transactionId: tx.id,
    walletId: tx.walletId,
    playerId: tx.playerId,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    roundId: tx.roundId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (!tx.balanceAfter) {
      throw new Error(`transação ${tx.id} processada sem saldo registrado`);
    }
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...baseData(tx),
        ...(tx.referenceTransactionId !== undefined && { referenceTransactionId: tx.referenceTransactionId }),
        balanceAfter: tx.balanceAfter.toJSON(),
      },
    });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode) {
      throw new Error(`transação ${tx.id} rejeitada sem failureCode`);
    }
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...baseData(tx),
        failureCode: tx.failureCode,
        ...(tx.referenceExternalTransactionId !== undefined && {
          referenceExternalTransactionId: tx.referenceExternalTransactionId,
        }),
      },
    });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (!tx.referenceExternalTransactionId || !tx.nextAttemptAt) {
      throw new Error(`transação ${tx.id} pendente sem referência agendada`);
    }
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...baseData(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        nextAttemptAt: tx.nextAttemptAt.toISOString(),
      },
    });
  }
}
