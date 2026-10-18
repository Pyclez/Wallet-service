import { describe, expect, test } from "bun:test";
import { canonicalJson, computePayloadHash, type WagerPayload } from "../../src/wagering/domain/payload-hash";
import { WagerTransactionKind as Kind } from "../../src/wagering/domain/wager-transaction";
import { wager } from "../support/domain";

const payload: WagerPayload = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

describe("computePayloadHash", () => {
  test("SHA-256 em hex", () => {
    expect(computePayloadHash(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a ordem das chaves não muda o hash", () => {
    const reordered = Object.fromEntries(Object.entries(payload).reverse()) as unknown as WagerPayload;
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(payload));
  });

  test("amount é normalizado: 25 e 25.00 são o mesmo payload", () => {
    expect(computePayloadHash({ ...payload, money: { amount: "25", currency: "BRL" } })).toBe(computePayloadHash(payload));
  });

  test("Idempotency-Key e metadados de transporte não entram no hash", () => {
    const withTransport = { ...payload, idempotencyKey: "outra-chave", messageId: "msg-1" } as WagerPayload;
    expect(computePayloadHash(withTransport)).toBe(computePayloadHash(payload));
  });

  test("referência undefined equivale a referência ausente", () => {
    expect(computePayloadHash({ ...payload, referenceExternalTransactionId: undefined })).toBe(computePayloadHash(payload));
  });

  test.each([
    ["valor", { money: { amount: "25.01", currency: "BRL" } }],
    ["moeda", { money: { amount: "25.00", currency: "USD" } }],
    ["kind", { kind: "WIN" }],
    ["rodada", { roundId: "round-988" }],
    ["wallet", { walletId: "outra" }],
    ["referência", { referenceExternalTransactionId: "bet-1" }],
  ])("mudar %s muda o hash", (_, change) => {
    expect(computePayloadHash({ ...payload, ...change })).not.toBe(computePayloadHash(payload));
  });
});

describe("idempotency key com payload divergente", () => {
  test("a transação gravada não casa com o hash de um payload diferente: é conflito, não replay", () => {
    const original = wager(Kind.Bet, "25.00", { externalTransactionId: "t-1" });
    const sameRequest = computePayloadHash({ ...original, money: original.money.toJSON() });
    const divergent = computePayloadHash({ ...original, money: { amount: "26.00", currency: "BRL" } });

    expect(original.matchesPayload(sameRequest)).toBe(true);
    expect(original.matchesPayload(divergent)).toBe(false);
  });
});

describe("canonicalJson", () => {
  test("ordena chaves em todos os níveis e omite undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"y":2,"z":1}]},"b":1}');
  });
});
