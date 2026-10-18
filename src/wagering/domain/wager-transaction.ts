import { InvalidTransactionStateError, InvalidWagerTransactionError } from "../../shared/domain/errors";
import type { Money } from "../../shared/domain/money";
import { LedgerDirection } from "../../wallet/domain/wallet-ledger-entry";
import type { FailureCode } from "./failure-code";
import { computePayloadHash } from "./payload-hash";
import type { ReferenceRetryPolicy } from "./reference-retry-policy";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export const INTERNAL_PROVIDER_ID = "internal";

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  balanceAfter?: Money;
  referenceAttempts: number;
  nextAttemptAt?: Date;
}

export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  public readonly referenceExternalTransactionId: string | undefined;
  public readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId?: string;
  private _failureCode?: FailureCode;
  private _processedAt?: Date;
  private _balanceAfter?: Money;
  private _referenceAttempts: number;
  private _nextAttemptAt?: Date;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt;
    this._balanceAfter = state.balanceAfter;
    this._referenceAttempts = state.referenceAttempts;
    this._nextAttemptAt = state.nextAttemptAt;
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError("OPENING é interno e não pode ser submetido pela API nem pela fila");
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidWagerTransactionError(`kind inválido: ${String(props.kind)}`);
    }
    for (const field of ["id", "providerId", "externalTransactionId", "idempotencyKey", "walletId", "playerId", "roundId", "gameId"] as const) {
      if (typeof props[field] !== "string" || props[field].trim() === "") {
        throw new InvalidWagerTransactionError(`${field} é obrigatório`);
      }
    }
    if (!/^[0-9a-f]{64}$/.test(props.payloadHash)) {
      throw new InvalidWagerTransactionError("payloadHash precisa ser SHA-256 em hex");
    }
    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidWagerTransactionError(`${props.kind} exige valor maior que zero`);
    }

    const reference = props.referenceExternalTransactionId;
    const requiresReference = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (requiresReference && !reference) {
      throw new InvalidWagerTransactionError(`${props.kind} exige referenceExternalTransactionId`);
    }
    if (props.kind === WagerTransactionKind.Bet && reference !== undefined) {
      throw new InvalidWagerTransactionError("BET não referencia outra transação");
    }
    if (reference !== undefined && reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError("uma transação não pode referenciar a si mesma");
    }

    return new WagerTransaction({ ...props, status: WagerTransactionStatus.Pending, referenceAttempts: 0 });
  }

  static createOpening(props: { id: string; walletId: string; playerId: string; money: Money; at: Date }): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError("OPENING só existe para saldo inicial positivo");
    }
    const payload = {
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: `opening:${props.walletId}`,
      playerId: props.playerId,
      walletId: props.walletId,
      roundId: "opening",
      gameId: "internal",
      kind: WagerTransactionKind.Opening,
      money: props.money.toJSON(),
    };
    return new WagerTransaction({
      ...payload,
      id: props.id,
      idempotencyKey: `${INTERNAL_PROVIDER_ID}:opening:${props.walletId}`,
      payloadHash: computePayloadHash(payload),
      money: props.money,
      createdAt: props.at,
      status: WagerTransactionStatus.Processed,
      processedAt: props.at,
      balanceAfter: props.money,
      referenceAttempts: 0,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  markProcessed(referenceTransactionId: string | undefined, balanceAfter: Money, at: Date): void {
    this.assertNotTerminal("markProcessed");
    if (this.requiresReference() && !referenceTransactionId) {
      throw new InvalidTransactionStateError(`${this.kind} só pode ser processado com a referência resolvida`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._balanceAfter = balanceAfter;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  markPendingReference(policy: ReferenceRetryPolicy, now: Date): void {
    this.assertNotTerminal("markPendingReference");
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidTransactionStateError("transação sem referência não pode aguardar referência");
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    this._nextAttemptAt = policy.nextAttemptAt(this._referenceAttempts, now);
  }

  reject(code: FailureCode, observedBalance?: Money): void {
    this.assertNotTerminal("reject");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._balanceAfter = observedBalance;
    this._nextAttemptAt = undefined;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal("fail");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextAttemptAt = undefined;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  canRetryReference(policy: ReferenceRetryPolicy): boolean {
    return this._referenceAttempts < policy.maxRetries;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError("ROLLBACK precisa da referência para saber a direção");
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError("LOSS não move saldo e não tem direção no ledger");
    }
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      createdAt: this.createdAt,
      status: this._status,
      referenceTransactionId: this._referenceTransactionId,
      failureCode: this._failureCode,
      processedAt: this._processedAt,
      balanceAfter: this._balanceAfter,
      referenceAttempts: this._referenceAttempts,
      nextAttemptAt: this._nextAttemptAt,
    };
  }

  private assertNotTerminal(operation: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `${operation} em transação ${this.id} já terminal (${this._status})`,
      );
    }
  }
}
