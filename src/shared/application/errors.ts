export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidRequestError extends ApplicationError {
  readonly code = "INVALID_PAYLOAD";

  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = "WALLET_NOT_FOUND";

  constructor(public readonly walletId: string) {
    super(`wallet ${walletId} não encontrada`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = "TRANSACTION_NOT_FOUND";

  constructor(reference: string) {
    super(`transação ${reference} não encontrada`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = "WALLET_ALREADY_EXISTS";

  constructor(playerId: string, currency: string) {
    super(`já existe wallet para o player ${playerId} em ${currency}`);
  }
}

export class IdempotencyConflictError extends ApplicationError {
  readonly code = "IDEMPOTENCY_CONFLICT";

  constructor(
    public readonly idempotencyKey: string,
    public readonly existingTransactionId: string,
  ) {
    super(`a chave ${idempotencyKey} já foi usada com outro payload`);
  }
}

export class TransientInfrastructureError extends ApplicationError {
  readonly code = "TEMPORARILY_UNAVAILABLE";

  constructor(
    message: string,
    public readonly reason: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export class UniqueViolationError extends ApplicationError {
  readonly code = "UNIQUE_VIOLATION";

  constructor(
    public readonly constraint: string | undefined,
    public override readonly cause?: unknown,
  ) {
    super(`violação de unicidade${constraint ? ` (${constraint})` : ""}`);
  }
}

export class ConcurrentModificationError extends ApplicationError {
  readonly code = "CONCURRENT_MODIFICATION";
}
