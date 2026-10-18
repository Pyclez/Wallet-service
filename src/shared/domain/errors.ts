export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";

  constructor(expected: string, received: string) {
    super(`Moeda divergente: esperado ${expected}, recebido ${received}`);
  }
}

export class InvalidWalletError extends DomainError {
  readonly code = "INVALID_WALLET";
}

export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = "INVALID_LEDGER_ENTRY";
}

export class InvalidWagerTransactionError extends DomainError {
  readonly code = "INVALID_WAGER_TRANSACTION";
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";
}
