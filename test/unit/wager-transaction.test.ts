import { describe, expect, test } from "bun:test";
import { InvalidTransactionStateError, InvalidWagerTransactionError } from "../../src/shared/domain/errors";
import { FailureCode } from "../../src/wagering/domain/failure-code";
import { ReferenceRetryPolicy } from "../../src/wagering/domain/reference-retry-policy";
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../src/wagering/domain/wager-transaction";
import { LedgerDirection } from "../../src/wallet/domain/wallet-ledger-entry";
import { NOW, brl, wager } from "../support/domain";

describe("WagerTransaction.create", () => {
  test("nasce PENDING, sem referência resolvida", () => {
    const tx = wager(Kind.Bet, "25.00");
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.referenceTransactionId).toBeUndefined();
  });

  test("OPENING não pode ser submetido", () => {
    expect(() => wager(Kind.Opening, "10.00")).toThrow(InvalidWagerTransactionError);
  });

  test.each([Kind.Refund, Kind.Rollback])("%s exige referência", (kind) => {
    expect(() => wager(kind, "10.00")).toThrow(InvalidWagerTransactionError);
    expect(wager(kind, "10.00", { referenceExternalTransactionId: "bet-1" }).requiresReference()).toBe(true);
  });

  test("BET não referencia outra transação", () => {
    expect(() => wager(Kind.Bet, "10.00", { referenceExternalTransactionId: "x" })).toThrow(InvalidWagerTransactionError);
  });

  test("valor zero só é aceito em LOSS", () => {
    expect(() => wager(Kind.Bet, "0.00")).toThrow(InvalidWagerTransactionError);
    expect(() => wager(Kind.Win, "0.00")).toThrow(InvalidWagerTransactionError);
    expect(wager(Kind.Loss, "0.00").affectsBalance()).toBe(false);
  });

  test("não referencia a si mesma", () => {
    expect(() =>
      wager(Kind.Refund, "10.00", { externalTransactionId: "t-1", referenceExternalTransactionId: "t-1" }),
    ).toThrow(InvalidWagerTransactionError);
  });

  test("campos obrigatórios vazios são recusados", () => {
    expect(() => wager(Kind.Bet, "10.00", { roundId: " " })).toThrow(InvalidWagerTransactionError);
  });
});

describe("transições", () => {
  const terminalize = {
    PROCESSED: (tx: WagerTransaction) => tx.markProcessed(undefined, brl("75.00"), NOW),
    REJECTED: (tx: WagerTransaction) => tx.reject(FailureCode.InsufficientFunds, brl("20.00")),
    FAILED: (tx: WagerTransaction) => tx.fail(FailureCode.ProcessingFailed),
  };

  test.each(Object.entries(terminalize))("%s é terminal: nenhuma transição é aceita depois", (_, toTerminal) => {
    const tx = wager(Kind.Bet, "25.00");
    toTerminal(tx);
    expect(tx.isTerminal()).toBe(true);

    expect(() => tx.markProcessed(undefined, brl("1.00"), NOW)).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.ProcessingFailed)).toThrow(InvalidTransactionStateError);
  });

  test("markProcessed grava o saldo observado e a data", () => {
    const tx = wager(Kind.Bet, "25.00");
    tx.markProcessed(undefined, brl("75.00"), NOW);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.balanceAfter?.toJSON().amount).toBe("75.00");
    expect(tx.processedAt).toEqual(NOW);
  });

  test("REFUND não é processado sem a referência resolvida", () => {
    const tx = wager(Kind.Refund, "10.00", { referenceExternalTransactionId: "bet-1" });
    expect(() => tx.markProcessed(undefined, brl("10.00"), NOW)).toThrow(InvalidTransactionStateError);
  });

  test("PENDING_REFERENCE agenda novas tentativas com backoff exponencial e teto", () => {
    const policy = ReferenceRetryPolicy.create({ baseDelayMs: 1_000, maxDelayMs: 4_000, maxRetries: 5 });
    const tx = wager(Kind.Refund, "10.00", { referenceExternalTransactionId: "bet-1" });

    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      tx.markPendingReference(policy, NOW);
      delays.push(tx.nextAttemptAt!.getTime() - NOW.getTime());
    }

    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.referenceAttempts).toBe(4);
    expect(delays).toEqual([1_000, 2_000, 4_000, 4_000]);
  });

  test("canRetryReference respeita maxRetries", () => {
    const policy = ReferenceRetryPolicy.create({ maxRetries: 2 });
    const tx = wager(Kind.Refund, "10.00", { referenceExternalTransactionId: "bet-1" });
    expect(tx.canRetryReference(policy)).toBe(true);
    tx.markPendingReference(policy, NOW);
    expect(tx.canRetryReference(policy)).toBe(true);
    tx.markPendingReference(policy, NOW);
    expect(tx.canRetryReference(policy)).toBe(false);
  });

  test("transação sem referência não pode ir para PENDING_REFERENCE", () => {
    expect(() => wager(Kind.Bet, "10.00").markPendingReference(ReferenceRetryPolicy.create(), NOW)).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe("consultas", () => {
  test("ledgerDirectionFor", () => {
    const bet = wager(Kind.Bet, "10.00");
    const win = wager(Kind.Win, "10.00");
    const refund = wager(Kind.Refund, "10.00", { referenceExternalTransactionId: "b" });
    const rollback = wager(Kind.Rollback, "10.00", { referenceExternalTransactionId: "b" });

    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    expect(() => wager(Kind.Loss, "0.00").ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test("matchesPayload compara o hash", () => {
    const tx = wager(Kind.Bet, "10.00");
    expect(tx.matchesPayload(tx.payloadHash)).toBe(true);
    expect(tx.matchesPayload("f".repeat(64))).toBe(false);
  });
});

describe("WagerTransaction.createOpening", () => {
  test("nasce PROCESSED, como crédito, com idempotency key interna", () => {
    const tx = WagerTransaction.createOpening({ id: "o-1", walletId: "w-1", playerId: "p-1", money: brl("1000.00"), at: NOW });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.idempotencyKey).toBe("internal:opening:w-1");
    expect(tx.balanceAfter?.toJSON().amount).toBe("1000.00");
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});
