import { LockMode, type EntityManager } from "@mikro-orm/postgresql";
import type { InboxRepository, OutboxRepository } from "../messaging/application/ports";
import type { InboxMessage } from "../messaging/domain/inbox-message";
import type { OutboxMessage } from "../messaging/domain/outbox-message";
import { ConcurrentModificationError } from "../shared/application/errors";
import type { Clock } from "../shared/application/ports";
import type { TransactionalRepositories } from "../shared/application/unit-of-work";
import { Money } from "../shared/domain/money";
import type { DuePendingReference, WagerTransactionRepository } from "../wagering/application/ports";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransaction,
} from "../wagering/domain/wager-transaction";
import type { LedgerRepository, LedgerSummary, WalletRepository } from "../wallet/application/ports";
import type { Wallet } from "../wallet/domain/wallet";
import type { WalletLedgerEntry } from "../wallet/domain/wallet-ledger-entry";
import {
  InboxMessageMapper,
  LedgerEntryMapper,
  OutboxMessageMapper,
  WagerTransactionMapper,
  WalletMapper,
} from "./mappers";
import {
  InboxMessageSchema,
  LedgerEntrySchema,
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletSchema,
  type OutboxMessageRecord,
} from "./schemas";

class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { id });
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async lockById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async lockForRead(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { id }, { lockMode: LockMode.PESSIMISTIC_READ });
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletSchema, WalletMapper.toRecord(wallet));
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const updated = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.toJSON().amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (updated !== 1) {
      throw new ConcurrentModificationError(`wallet ${wallet.id} mudou fora do lock (version ${expectedVersion})`);
    }
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, LedgerEntryMapper.toRecord(entry));
  }

  async page(walletId: string, options: { beforeVersion?: number; limit: number }): Promise<WalletLedgerEntry[]> {
    const records = await this.em.find(
      LedgerEntrySchema,
      options.beforeVersion === undefined
        ? { walletId }
        : { walletId, walletVersion: { $lt: options.beforeVersion } },
      { orderBy: { walletVersion: "desc" }, limit: options.limit },
    );
    return records.map(LedgerEntryMapper.toDomain);
  }

  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    const [row] = await this.em.execute<{ net: string; entries: number }[]>(
      `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::text as net,
              count(*)::int as entries
         from wallet_ledger_entries
        where wallet_id = ?`,
      [walletId],
    );
    const net = row?.net ?? "0";
    const negative = net.startsWith("-");
    const absolute = Money.from({ amount: negative ? net.slice(1) : net, currency });
    return { net: negative ? absolute.negate() : absolute, entries: row?.entries ?? 0 };
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(
    private readonly em: EntityManager,
    private readonly clock: Clock,
  ) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, { id });
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, { providerId, externalTransactionId });
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }

  async findByIdempotencyKeyOrExternalId(
    idempotencyKey: string,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction[]> {
    const records = await this.em.find(WagerTransactionSchema, {
      $or: [{ idempotencyKey }, { providerId, externalTransactionId }],
    });
    return records.map(WagerTransactionMapper.toDomain);
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionSchema, WagerTransactionMapper.toRecord(transaction, this.clock.now()));
  }

  async updatePending(transaction: WagerTransaction): Promise<void> {
    const record = WagerTransactionMapper.toRecord(transaction, this.clock.now());
    const updated = await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: transaction.id, status: WagerTransactionStatus.PendingReference },
      {
        status: record.status,
        referenceTransactionId: record.referenceTransactionId,
        failureCode: record.failureCode,
        balanceAfter: record.balanceAfter,
        referenceAttempts: record.referenceAttempts,
        nextAttemptAt: record.nextAttemptAt,
        processedAt: record.processedAt,
        updatedAt: record.updatedAt,
      },
    );
    if (updated !== 1) {
      throw new ConcurrentModificationError(`transação ${transaction.id} não estava mais aguardando referência`);
    }
  }

  async findDuePendingReferences(limit: number): Promise<DuePendingReference[]> {
    const rows = await this.em.execute<{ id: string; wallet_id: string }[]>(
      `select id, wallet_id
         from wager_transactions
        where status = 'PENDING_REFERENCE' and next_attempt_at <= now()
        order by next_attempt_at
        limit ?`,
      [limit],
    );
    return rows.map((row) => ({ id: row.id, walletId: row.wallet_id }));
  }

  async lockDuePendingReference(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(
      WagerTransactionSchema,
      { id, status: WagerTransactionStatus.PendingReference, nextAttemptAt: { $lte: this.clock.now() } },
      { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxMessageSchema, { consumerName, messageId });
    return record ? InboxMessageMapper.toDomain(record) : undefined;
  }

  async insert(message: InboxMessage): Promise<void> {
    await this.em.insert(InboxMessageSchema, InboxMessageMapper.toRecord(message));
  }
}

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
  published_at: Date | null;
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(
    private readonly em: EntityManager,
    private readonly clock: Clock,
  ) {}

  async add(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    await this.em.insertMany(OutboxMessageSchema, messages.map(OutboxMessageMapper.toRecord));
  }

  async claimDue(limit: number, leaseMs: number): Promise<OutboxMessage[]> {
    const rows = await this.em.execute<OutboxRow[]>(
      `update outbox_messages
          set locked_until = now() + (? * interval '1 millisecond')
        where id in (
          select id
            from outbox_messages
           where published_at is null
             and next_attempt_at <= now()
             and (locked_until is null or locked_until < now())
           order by occurred_at, id
           limit ?
             for update skip locked)
       returning id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at`,
      [leaseMs, limit],
    );
    return rows
      .map((row): OutboxMessageRecord => ({
        id: row.id,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: row.payload,
        occurredAt: new Date(row.occurred_at),
        attempts: row.attempts,
        nextAttemptAt: new Date(row.next_attempt_at),
        publishedAt: row.published_at === null ? null : new Date(row.published_at),
      }))
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id))
      .map(OutboxMessageMapper.toDomain);
  }

  async markPublished(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: message.id, publishedAt: null },
      { publishedAt: message.publishedAt ?? this.clock.now(), lockedUntil: null },
    );
  }

  async scheduleRetry(message: OutboxMessage, error: string): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: message.id, publishedAt: null },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? this.clock.now(),
        lockedUntil: null,
        lastError: error.slice(0, 500),
      },
    );
  }

  async oldestPendingAgeSeconds(): Promise<number> {
    const [row] = await this.em.execute<{ age: string | null }[]>(
      `select extract(epoch from now() - min(occurred_at))::text as age
         from outbox_messages
        where published_at is null`,
    );
    return row?.age ? Math.max(Number(row.age), 0) : 0;
  }
}

export function createRepositories(em: EntityManager, clock: Clock): TransactionalRepositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em, clock),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em, clock),
  };
}
