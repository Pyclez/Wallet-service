import { InboxMessage } from "../../messaging/domain/inbox-message";
import {
  IdempotencyConflictError,
  UniqueViolationError,
  WalletNotFoundError,
} from "../../shared/application/errors";
import type { Clock, IdGenerator, ProcessingSource, Telemetry } from "../../shared/application/ports";
import type { TransactionalRepositories, UnitOfWork } from "../../shared/application/unit-of-work";
import { InvalidWagerTransactionError } from "../../shared/domain/errors";
import { Money, type MoneyProps } from "../../shared/domain/money";
import { computePayloadHash } from "../domain/payload-hash";
import { WagerTransaction, WagerTransactionKind } from "../domain/wager-transaction";
import { toResult, type WagerTransactionResult } from "./views";
import type { WagerTransactionSettler } from "./wager-transaction-settler";

export interface WagerTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface ProcessingContext {
  correlationId: string;
  source: ProcessingSource;
  inbox?: { consumerName: string; messageId: string };
}

export interface ProcessingOutcome extends WagerTransactionResult {
  duplicateMessage: boolean;
}

const SUBMITTABLE_KINDS: ReadonlySet<string> = new Set(
  Object.values(WagerTransactionKind).filter((kind) => kind !== WagerTransactionKind.Opening),
);
const MAX_ATTEMPTS = 3;

export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly settler: WagerTransactionSettler,
    private readonly telemetry: Telemetry,
  ) {}

  async execute(command: WagerTransactionCommand, ctx: ProcessingContext): Promise<ProcessingOutcome> {
    const started = performance.now();
    if (!SUBMITTABLE_KINDS.has(command.kind)) {
      throw new InvalidWagerTransactionError(`kind inválido para submissão: ${command.kind}`);
    }
    const money = Money.from(command.money);
    const payloadHash = computePayloadHash({ ...command, money: money.toJSON() });
    let candidate = this.buildCandidate(command, money, payloadHash);

    for (let attempt = 1; ; attempt++) {
      try {
        const outcome = await this.uow.run((repos) => this.process(repos, candidate, ctx));
        if (!outcome.idempotentReplay) {
          this.telemetry.transactionSettled(outcome.status, ctx.source, (performance.now() - started) / 1000);
        }
        return outcome;
      } catch (error) {
        if (error instanceof UniqueViolationError && attempt < MAX_ATTEMPTS) {
          this.telemetry.retry("unique_violation");
          candidate = this.buildCandidate(command, money, payloadHash);
          continue;
        }
        if (error instanceof IdempotencyConflictError) {
          this.telemetry.idempotencyConflict(ctx.source);
        }
        throw error;
      }
    }
  }

  private async process(
    repos: TransactionalRepositories,
    candidate: WagerTransaction,
    ctx: ProcessingContext,
  ): Promise<ProcessingOutcome> {
    const wallet = await repos.wallets.lockById(candidate.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(candidate.walletId);
    }

    const now = this.clock.now();
    if (ctx.inbox && (await repos.inbox.find(ctx.inbox.consumerName, ctx.inbox.messageId))) {
      const original = await this.findSameRequest(repos, candidate);
      this.telemetry.duplicateDetected(ctx.source, "inbox");
      return { ...toResult(original, true), duplicateMessage: true };
    }

    const existing = await repos.transactions.findByIdempotencyKeyOrExternalId(
      candidate.idempotencyKey,
      candidate.providerId,
      candidate.externalTransactionId,
    );
    if (existing.length > 0) {
      const original = await this.findSameRequest(repos, candidate, existing);
      await this.recordInbox(repos, candidate, ctx, now);
      this.telemetry.duplicateDetected(ctx.source, "idempotency_key");
      return { ...toResult(original, true), duplicateMessage: false };
    }

    await this.settler.settle(repos, wallet, candidate, {
      correlationId: ctx.correlationId,
      causationId: ctx.inbox?.messageId,
      now,
    });
    await this.recordInbox(repos, candidate, ctx, now);
    return { ...toResult(candidate, false), duplicateMessage: false };
  }

  private async findSameRequest(
    repos: TransactionalRepositories,
    candidate: WagerTransaction,
    found?: WagerTransaction[],
  ): Promise<WagerTransaction> {
    const existing =
      found ??
      (await repos.transactions.findByIdempotencyKeyOrExternalId(
        candidate.idempotencyKey,
        candidate.providerId,
        candidate.externalTransactionId,
      ));
    const [original] = existing;
    const sameRequest =
      existing.length === 1 &&
      original !== undefined &&
      original.idempotencyKey === candidate.idempotencyKey &&
      original.providerId === candidate.providerId &&
      original.externalTransactionId === candidate.externalTransactionId &&
      original.matchesPayload(candidate.payloadHash);
    if (!sameRequest) {
      throw new IdempotencyConflictError(candidate.idempotencyKey, original?.id ?? "desconhecida");
    }
    return original;
  }

  private async recordInbox(
    repos: TransactionalRepositories,
    candidate: WagerTransaction,
    ctx: ProcessingContext,
    now: Date,
  ): Promise<void> {
    if (!ctx.inbox) {
      return;
    }
    const message = InboxMessage.receive({
      messageId: ctx.inbox.messageId,
      consumerName: ctx.inbox.consumerName,
      payloadHash: candidate.payloadHash,
      receivedAt: now,
    });
    message.markProcessed(now);
    await repos.inbox.insert(message);
  }

  private buildCandidate(command: WagerTransactionCommand, money: Money, payloadHash: string): WagerTransaction {
    return WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind as WagerTransactionKind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: this.clock.now(),
    });
  }
}
