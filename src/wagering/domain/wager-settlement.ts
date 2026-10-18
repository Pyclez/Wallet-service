import { InvalidTransactionStateError } from "../../shared/domain/errors";
import type { Wallet } from "../../wallet/domain/wallet";
import { LedgerDirection, type WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry";
import { FailureCode } from "./failure-code";
import type { ReferenceRetryPolicy } from "./reference-retry-policy";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "./wager-transaction";

export type SettlementResult =
  | { outcome: WagerTransactionStatus.Processed; entry?: WalletLedgerEntry }
  | { outcome: WagerTransactionStatus.Rejected; failureCode: FailureCode }
  | { outcome: WagerTransactionStatus.PendingReference; nextAttemptAt: Date };

export interface SettlementInput {
  wallet: Wallet;
  transaction: WagerTransaction;
  reference: WagerTransaction | undefined;
  referenceAlreadyReversed: boolean;
  ledgerEntryId: string;
  retryPolicy: ReferenceRetryPolicy;
  now: Date;
}

const ALLOWED_REFERENCE_KINDS: Readonly<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Opening]: [],
};

const REFERENCE_NOT_AVAILABLE = "REFERENCE_NOT_AVAILABLE";

export class WagerSettlement {
  private constructor() {}

  static settle(input: SettlementInput): SettlementResult {
    const { wallet, transaction: tx, reference, now } = input;

    if (tx.walletId !== wallet.id) {
      throw new InvalidTransactionStateError(`transação ${tx.id} não pertence à wallet ${wallet.id}`);
    }

    const reject = (code: FailureCode): SettlementResult => {
      tx.reject(code, wallet.balance);
      return { outcome: WagerTransactionStatus.Rejected, failureCode: code };
    };

    if (tx.money.currency !== wallet.currency) return reject(FailureCode.CurrencyMismatch);
    if (tx.playerId !== wallet.playerId) return reject(FailureCode.PlayerMismatch);

    if (tx.referenceExternalTransactionId !== undefined) {
      const problem = WagerSettlement.checkReference(tx, reference, input.referenceAlreadyReversed);
      if (problem === REFERENCE_NOT_AVAILABLE) {
        if (!tx.canRetryReference(input.retryPolicy)) return reject(FailureCode.ReferenceNotFound);
        tx.markPendingReference(input.retryPolicy, now);
        return { outcome: WagerTransactionStatus.PendingReference, nextAttemptAt: tx.nextAttemptAt! };
      }
      if (problem) return reject(problem);
    }

    if (!tx.affectsBalance()) {
      tx.markProcessed(reference?.id, wallet.balance, now);
      return { outcome: WagerTransactionStatus.Processed };
    }

    const direction = tx.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
      return reject(tx.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds);
    }

    const movement = { money: tx.money, transactionId: tx.id, entryId: input.ledgerEntryId, at: now };
    const entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
    tx.markProcessed(reference?.id, wallet.balance, now);
    return { outcome: WagerTransactionStatus.Processed, entry };
  }

  private static checkReference(
    tx: WagerTransaction,
    reference: WagerTransaction | undefined,
    alreadyReversed: boolean,
  ): FailureCode | typeof REFERENCE_NOT_AVAILABLE | undefined {
    if (
      !reference ||
      reference.status === WagerTransactionStatus.Pending ||
      reference.status === WagerTransactionStatus.PendingReference
    ) {
      return REFERENCE_NOT_AVAILABLE;
    }
    if (reference.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;
    if (!ALLOWED_REFERENCE_KINDS[tx.kind].includes(reference.kind)) return FailureCode.InvalidReferenceKind;

    const sameContext =
      reference.providerId === tx.providerId &&
      reference.walletId === tx.walletId &&
      reference.playerId === tx.playerId &&
      reference.roundId === tx.roundId &&
      reference.money.currency === tx.money.currency;
    if (!sameContext) return FailureCode.ReferenceMismatch;

    if (tx.isReversal()) {
      if (!reference.money.equals(tx.money)) return FailureCode.ReversalAmountMismatch;
      if (alreadyReversed) return FailureCode.ReferenceAlreadyReversed;
    }
    return undefined;
  }
}
