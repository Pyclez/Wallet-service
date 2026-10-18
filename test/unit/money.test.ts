import { describe, expect, test } from "bun:test";
import { Money } from "../../src/shared/domain/money";
import { CurrencyMismatchError, InvalidMoneyError } from "../../src/shared/domain/errors";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money.from", () => {
  test.each([
    ["25.00", "25.00"],
    ["25", "25.00"],
    ["25.5", "25.50"],
    ["0", "0.00"],
    ["007.10", "7.10"],
    ["99999999999999999.99", "99999999999999999.99"],
  ])("aceita %p e serializa com 2 casas (%p)", (input, expected) => {
    expect(brl(input).toJSON()).toEqual({ amount: expected, currency: "BRL" });
  });

  test.each([
    ["", "string vazia"],
    [" 10.00", "espaço"],
    ["10.001", "mais de 2 casas"],
    ["-10.00", "negativo"],
    ["+10.00", "sinal explícito"],
    ["1e3", "notação científica"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    [".50", "sem parte inteira"],
    ["10.", "ponto sem casas"],
    ["10,00", "vírgula"],
    ["100000000000000000.00", "acima de NUMERIC(19,2)"],
  ])("rejeita %p (%s)", (input) => {
    expect(() => brl(input)).toThrow(InvalidMoneyError);
  });

  test("rejeita number, mesmo com valor válido", () => {
    expect(() => Money.from({ amount: 10 as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test.each(["brl", "BR", "REAL", ""])("rejeita moeda %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
  });
});

describe("aritmética", () => {
  test("0.10 + 0.20 é exatamente 0.30 (sem erro de ponto flutuante)", () => {
    expect(brl("0.10").add(brl("0.20")).equals(brl("0.30"))).toBe(true);
  });

  test("subtract pode ficar negativo; o domínio decide se isso é permitido", () => {
    const result = brl("20.00").subtract(brl("80.00"));
    expect(result.isNegative()).toBe(true);
    expect(result.toJSON().amount).toBe("-60.00");
  });

  test("é imutável", () => {
    const a = brl("10.00");
    a.add(brl("5.00"));
    expect(a.toJSON().amount).toBe("10.00");
  });

  test("negate de zero não vira -0.00", () => {
    expect(Money.zero("BRL").negate().toJSON().amount).toBe("0.00");
  });

  test("comparações", () => {
    expect(brl("20.00").isLessThan(brl("80.00"))).toBe(true);
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("1.5").equals(brl("1.50"))).toBe(true);
    expect(brl("1.00").toString()).toBe("1.00 BRL");
  });
});

describe("conflito de moeda", () => {
  const usd = Money.from({ amount: "10.00", currency: "USD" });

  test.each([
    ["add", () => brl("10.00").add(usd)],
    ["subtract", () => brl("10.00").subtract(usd)],
    ["isLessThan", () => brl("10.00").isLessThan(usd)],
  ])("%s entre moedas diferentes lança CurrencyMismatchError", (_, op) => {
    expect(op).toThrow(CurrencyMismatchError);
  });

  test("equals entre moedas diferentes é false, não erro", () => {
    expect(brl("10.00").equals(usd)).toBe(false);
  });
});
