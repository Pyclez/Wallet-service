import { CurrencyMismatchError, InsufficientFundsError, InvalidWalletError } from "../../shared/domain/errors";
import { Money } from "../../shared/domain/money";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  opening?: { transactionId: string; entryId: string };
}

export interface WalletMovement {
  money: Money;
  transactionId: string;
  entryId: string;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    if (!props.id || !props.playerId) {
      throw new InvalidWalletError("id e playerId são obrigatórios");
    }
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError("saldo inicial não pode ser negativo");
    }

    const currency = props.initialBalance.currency;
    const zero = Money.zero(currency);
    const wallet = new Wallet(props.id, props.playerId, currency, zero, 1, props.at, props.at);

    if (props.initialBalance.isZero()) {
      return { wallet };
    }
    if (!props.opening) {
      throw new InvalidWalletError("saldo inicial positivo exige uma transação OPENING");
    }

    const openingEntry = WalletLedgerEntry.create({
      id: props.opening.entryId,
      walletId: wallet.id,
      transactionId: props.opening.transactionId,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: zero,
      balanceAfter: props.initialBalance,
      walletVersion: 1,
      createdAt: props.at,
    });
    wallet._balance = props.initialBalance;
    return { wallet, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(movement: WalletMovement): WalletLedgerEntry {
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    return this.apply(LedgerDirection.Credit, movement);
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance,
      version: this._version,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }

  private apply(direction: LedgerDirection, { money, transactionId, entryId, at }: WalletMovement): WalletLedgerEntry {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidWalletError(`movimentação precisa ser positiva (recebido ${money})`);
    }

    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Debit ? balanceBefore.subtract(money) : balanceBefore.add(money);

    if (balanceAfter.isNegative()) {
      throw new InsufficientFundsError(`saldo ${balanceBefore} insuficiente para débito de ${money}`);
    }

    const walletVersion = this._version + 1;
    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      walletVersion,
      createdAt: at,
    });

    this._balance = balanceAfter;
    this._version = walletVersion;
    this._updatedAt = at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
