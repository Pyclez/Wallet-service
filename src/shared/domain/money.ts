import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "./errors";

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

const SCALE = 2;
const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;
const MAX_INTEGER_DIGITS = 17;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    const currency = Money.parseCurrency(props?.currency);
    const amount: unknown = props?.amount;

    if (typeof amount !== "string") {
      throw new InvalidMoneyError("amount deve ser uma string decimal");
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `amount inválido: "${amount}" (use até ${SCALE} casas, sem sinal nem notação científica)`,
      );
    }
    const integerPart = amount.split(".")[0]!.replace(/^0+(?=\d)/, "");
    if (integerPart.length > MAX_INTEGER_DIGITS) {
      throw new InvalidMoneyError("amount excede o limite de NUMERIC(19,2)");
    }

    return new Money(new D(amount), currency);
  }

  static zero(currency: string): Money {
    return new Money(new D(0), Money.parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.formatAmount(), currency: this.currency };
  }

  toString(): string {
    return `${this.formatAmount()} ${this.currency}`;
  }

  private formatAmount(): string {
    return this.value.isZero() ? (0).toFixed(SCALE) : this.value.toFixed(SCALE);
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`currency inválida: "${String(currency)}" (use ISO-4217, ex.: BRL)`);
    }
    return currency;
  }
}
