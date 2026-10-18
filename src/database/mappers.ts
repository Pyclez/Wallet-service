import { InboxMessage } from "../messaging/domain/inbox-message";
import { OutboxMessage } from "../messaging/domain/outbox-message";
import { Money } from "../shared/domain/money";
import type { FailureCode } from "../wagering/domain/failure-code";
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../wagering/domain/wager-transaction";
import { Wallet } from "../wallet/domain/wallet";
import { WalletLedgerEntry, type LedgerDirection } from "../wallet/domain/wallet-ledger-entry";
import type {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "./schemas";

const money = (amount: string, currency: string) => Money.from({ amount, currency });
const optional = <T>(value: T | null | undefined): T | undefined => (value === null ? undefined : value);

export const WalletMapper = {
  toDomain(record: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency,
      balance: money(record.balance, record.currency),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  },

  toRecord(wallet: Wallet): WalletRecord {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON().amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  },
};

export const LedgerEntryMapper = {
  toDomain(record: LedgerEntryRecord): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: record.id,
      walletId: record.walletId,
      transactionId: record.transactionId,
      direction: record.direction as LedgerDirection,
      money: money(record.amount, record.currency),
      balanceBefore: money(record.balanceBefore, record.currency),
      balanceAfter: money(record.balanceAfter, record.currency),
      walletVersion: record.walletVersion,
      createdAt: record.createdAt,
    });
  },

  toRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
    return {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toJSON().amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toJSON().amount,
      balanceAfter: entry.balanceAfter.toJSON().amount,
      walletVersion: entry.walletVersion,
      createdAt: entry.createdAt,
    };
  },
};

export const WagerTransactionMapper = {
  toDomain(record: WagerTransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind as WagerTransactionKind,
      money: money(record.amount, record.currency),
      referenceExternalTransactionId: optional(record.referenceExternalTransactionId),
      createdAt: record.createdAt,
      status: record.status as WagerTransactionStatus,
      referenceTransactionId: optional(record.referenceTransactionId),
      failureCode: optional(record.failureCode) as FailureCode | undefined,
      processedAt: optional(record.processedAt),
      balanceAfter: record.balanceAfter == null ? undefined : money(record.balanceAfter, record.currency),
      referenceAttempts: record.referenceAttempts,
      nextAttemptAt: optional(record.nextAttemptAt),
    });
  },

  toRecord(transaction: WagerTransaction, updatedAt: Date): WagerTransactionRecord {
    const state = transaction.toState();
    return {
      id: state.id,
      providerId: state.providerId,
      externalTransactionId: state.externalTransactionId,
      idempotencyKey: state.idempotencyKey,
      payloadHash: state.payloadHash,
      walletId: state.walletId,
      playerId: state.playerId,
      roundId: state.roundId,
      gameId: state.gameId,
      kind: state.kind,
      amount: state.money.toJSON().amount,
      currency: state.money.currency,
      referenceExternalTransactionId: state.referenceExternalTransactionId ?? null,
      referenceTransactionId: state.referenceTransactionId ?? null,
      status: state.status,
      failureCode: state.failureCode ?? null,
      balanceAfter: state.balanceAfter?.toJSON().amount ?? null,
      referenceAttempts: state.referenceAttempts,
      nextAttemptAt: state.nextAttemptAt ?? null,
      createdAt: state.createdAt,
      updatedAt,
      processedAt: state.processedAt ?? null,
    };
  },
};

export const InboxMessageMapper = {
  toDomain(record: InboxMessageRecord): InboxMessage {
    return InboxMessage.rehydrate({
      messageId: record.messageId,
      consumerName: record.consumerName,
      payloadHash: record.payloadHash,
      receivedAt: record.receivedAt,
      processedAt: optional(record.processedAt),
    });
  },

  toRecord(message: InboxMessage): InboxMessageRecord {
    const state = message.toState();
    return { ...state, processedAt: state.processedAt ?? null };
  },
};

export const OutboxMessageMapper = {
  toDomain(record: OutboxMessageRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: record.id,
      aggregateId: record.aggregateId,
      eventType: record.eventType,
      payload: record.payload,
      occurredAt: record.occurredAt,
      attempts: record.attempts,
      nextAttemptAt: record.nextAttemptAt,
      publishedAt: optional(record.publishedAt),
    });
  },

  toRecord(message: OutboxMessage): OutboxMessageRecord {
    const state = message.toState();
    return {
      id: state.id,
      aggregateId: state.aggregateId,
      eventType: state.eventType,
      payload: { ...state.payload },
      occurredAt: state.occurredAt,
      attempts: state.attempts,
      nextAttemptAt: state.nextAttemptAt ?? state.occurredAt,
      lockedUntil: null,
      publishedAt: state.publishedAt ?? null,
      lastError: null,
    };
  },
};
