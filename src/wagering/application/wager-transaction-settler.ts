import { OutboxMessage } from "../../messaging/domain/outbox-message";
import type { IdGenerator } from "../../shared/application/ports";
import type { TransactionalRepositories } from "../../shared/application/unit-of-work";
import type { EventContext } from "../../shared/domain/integration-event";
import type { Wallet } from "../../wallet/domain/wallet";
import { WalletBalanceChanged } from "../../wallet/domain/wallet-events";
import type { ReferenceRetryPolicy } from "../domain/reference-retry-policy";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from "../domain/wager-events";
import { WagerSettlement, type SettlementResult } from "../domain/wager-settlement";
import { WagerTransactionStatus, type WagerTransaction } from "../domain/wager-transaction";

export interface SettlementContext {
  correlationId: string;
  causationId?: string;
  now: Date;
}

export class WagerTransactionSettler {
  constructor(
    private readonly ids: IdGenerator,
    private readonly retryPolicy: ReferenceRetryPolicy,
  ) {}

  async settle(
    repos: TransactionalRepositories,
    wallet: Wallet,
    transaction: WagerTransaction,
    ctx: SettlementContext,
  ): Promise<SettlementResult> {
    const isNew = transaction.status === WagerTransactionStatus.Pending;
    const wasWaiting = transaction.status === WagerTransactionStatus.PendingReference;
    const reference = transaction.referenceExternalTransactionId
      ? await repos.transactions.findByExternalId(transaction.providerId, transaction.referenceExternalTransactionId)
      : undefined;
    const referenceAlreadyReversed =
      reference !== undefined && transaction.isReversal()
        ? await repos.transactions.hasProcessedReversal(reference.id)
        : false;
    const previousVersion = wallet.version;

    const result = WagerSettlement.settle({
      wallet,
      transaction,
      reference,
      referenceAlreadyReversed,
      ledgerEntryId: this.ids.next(),
      retryPolicy: this.retryPolicy,
      now: ctx.now,
    });

    if (isNew) {
      await repos.transactions.insert(transaction);
    } else {
      await repos.transactions.updatePending(transaction);
    }
    if (result.outcome === WagerTransactionStatus.Processed && result.entry) {
      await repos.ledger.append(result.entry);
      await repos.wallets.saveBalance(wallet, previousVersion);
    }
    await repos.outbox.add(this.eventsFor(wallet, transaction, result, ctx, wasWaiting));
    return result;
  }

  private eventsFor(
    wallet: Wallet,
    transaction: WagerTransaction,
    result: SettlementResult,
    ctx: SettlementContext,
    wasWaiting: boolean,
  ): OutboxMessage[] {
    const eventContext = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.now,
    });

    switch (result.outcome) {
      case WagerTransactionStatus.Processed:
        return [
          OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, eventContext())),
          ...(result.entry ? [OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, result.entry, eventContext()))] : []),
        ];
      case WagerTransactionStatus.Rejected:
        return [OutboxMessage.enqueue(WagerTransactionRejected.from(transaction, eventContext()))];
      case WagerTransactionStatus.PendingReference:
        return wasWaiting ? [] : [OutboxMessage.enqueue(WagerTransactionPendingReference.from(transaction, eventContext()))];
    }
  }
}
