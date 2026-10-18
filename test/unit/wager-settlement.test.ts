import { describe, expect, test } from "bun:test";
import { Money } from "../../src/shared/domain/money";
import { FailureCode } from "../../src/wagering/domain/failure-code";
import { ReferenceRetryPolicy } from "../../src/wagering/domain/reference-retry-policy";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type WagerTransaction,
} from "../../src/wagering/domain/wager-transaction";
import { WagerSettlement } from "../../src/wagering/domain/wager-settlement";
import { LedgerDirection } from "../../src/wallet/domain/wallet-ledger-entry";
import { NOW, balanceFromLedger, nextId, openWallet, wager } from "../support/domain";

const policy = ReferenceRetryPolicy.create({ baseDelayMs: 1_000, maxDelayMs: 4_000, maxRetries: 2 });

function scenario(initialBalance = "100.00") {
  const { wallet, entries } = openWallet(initialBalance);

  return {
    wallet,
    entries,
    settle(tx: WagerTransaction, options: { reference?: WagerTransaction; alreadyReversed?: boolean; now?: Date } = {}) {
      const result = WagerSettlement.settle({
        wallet,
        transaction: tx,
        reference: options.reference,
        referenceAlreadyReversed: options.alreadyReversed ?? false,
        ledgerEntryId: nextId("entry"),
        retryPolicy: policy,
        now: options.now ?? NOW,
      });
      if (result.outcome === Status.Processed && result.entry) entries.push(result.entry);
      return result;
    },
    expectConsistent(expectedBalance: string) {
      expect(wallet.balance.toJSON().amount).toBe(expectedBalance);
      expect(balanceFromLedger(entries).equals(wallet.balance)).toBe(true);
    },
  };
}

const refOf = (tx: WagerTransaction) => ({ referenceExternalTransactionId: tx.externalTransactionId });

describe("BET", () => {
  test("debita, gera DEBIT e grava o saldo observado", () => {
    const s = scenario("100.00");
    const bet = wager(Kind.Bet, "25.00");

    const result = s.settle(bet);

    expect(result.outcome).toBe(Status.Processed);
    expect(bet.status).toBe(Status.Processed);
    expect(bet.balanceAfter?.toJSON().amount).toBe("75.00");
    expect(s.entries.at(-1)?.direction).toBe(LedgerDirection.Debit);
    s.expectConsistent("75.00");
  });

  test("cenário da seção 8 (sequencial): 100.00 e duas apostas de 80.00", () => {
    const s = scenario("100.00");
    const first = wager(Kind.Bet, "80.00");
    const second = wager(Kind.Bet, "80.00");

    s.settle(first);
    const result = s.settle(second);

    expect(first.status).toBe(Status.Processed);
    expect(result).toEqual({ outcome: Status.Rejected, failureCode: FailureCode.InsufficientFunds });
    expect(second.balanceAfter?.toJSON().amount).toBe("20.00");
    expect(s.entries.filter((e) => e.direction === LedgerDirection.Debit)).toHaveLength(1);
    s.expectConsistent("20.00");
  });
});

describe("WIN e LOSS", () => {
  test("WIN credita", () => {
    const s = scenario("100.00");
    s.settle(wager(Kind.Win, "50.00"));
    s.expectConsistent("150.00");
  });

  test("WIN com referência à BET guarda o id interno da BET", () => {
    const s = scenario("100.00");
    const bet = wager(Kind.Bet, "10.00");
    s.settle(bet);
    const win = wager(Kind.Win, "30.00", refOf(bet));

    s.settle(win, { reference: bet });

    expect(win.referenceTransactionId).toBe(bet.id);
    s.expectConsistent("120.00");
  });

  test("WIN de uma BET rejeitada é rejeitado", () => {
    const s = scenario("5.00");
    const bet = wager(Kind.Bet, "10.00");
    s.settle(bet);
    const win = wager(Kind.Win, "30.00", refOf(bet));

    expect(s.settle(win, { reference: bet })).toMatchObject({ failureCode: FailureCode.ReferenceNotProcessed });
    s.expectConsistent("5.00");
  });

  test("LOSS é processado sem mexer no saldo, na version nem no ledger", () => {
    const s = scenario("100.00");
    const loss = wager(Kind.Loss, "0.00");

    const result = s.settle(loss);

    expect(result).toEqual({ outcome: Status.Processed });
    expect(loss.status).toBe(Status.Processed);
    expect(s.wallet.version).toBe(1);
    expect(s.entries).toHaveLength(1);
    s.expectConsistent("100.00");
  });
});

describe("REFUND", () => {
  test("credita o valor da BET e aponta para ela", () => {
    const s = scenario("100.00");
    const bet = wager(Kind.Bet, "40.00");
    s.settle(bet);
    const refund = wager(Kind.Refund, "40.00", refOf(bet));

    s.settle(refund, { reference: bet });

    expect(refund.status).toBe(Status.Processed);
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(s.entries.at(-1)?.direction).toBe(LedgerDirection.Credit);
    s.expectConsistent("100.00");
  });

  test.each([
    ["referência que não é BET", Kind.Win, "40.00", {}, FailureCode.InvalidReferenceKind],
    ["valor diferente da BET", Kind.Bet, "39.99", {}, FailureCode.ReversalAmountMismatch],
    ["BET de outra rodada", Kind.Bet, "40.00", { roundId: "round-2" }, FailureCode.ReferenceMismatch],
    ["BET de outro provider", Kind.Bet, "40.00", { providerId: "provider-b" }, FailureCode.ReferenceMismatch],
  ])("rejeita %s", (_, referenceKind, refundAmount, referenceOverrides, expectedCode) => {
    const s = scenario("100.00");
    const reference = wager(referenceKind, "40.00", referenceOverrides);
    s.settle(reference);
    const refund = wager(Kind.Refund, refundAmount, refOf(reference));

    expect(s.settle(refund, { reference })).toMatchObject({ outcome: Status.Rejected, failureCode: expectedCode });
    expect(refund.failureCode).toBe(expectedCode);
  });

  test("a mesma BET não é reembolsada duas vezes", () => {
    const s = scenario("100.00");
    const bet = wager(Kind.Bet, "40.00");
    s.settle(bet);
    s.settle(wager(Kind.Refund, "40.00", refOf(bet)), { reference: bet });

    const second = s.settle(wager(Kind.Refund, "40.00", refOf(bet)), { reference: bet, alreadyReversed: true });

    expect(second).toMatchObject({ failureCode: FailureCode.ReferenceAlreadyReversed });
    s.expectConsistent("100.00");
  });
});

describe("ROLLBACK", () => {
  test("de BET credita", () => {
    const s = scenario("100.00");
    const bet = wager(Kind.Bet, "30.00");
    s.settle(bet);
    s.settle(wager(Kind.Rollback, "30.00", refOf(bet)), { reference: bet });
    s.expectConsistent("100.00");
  });

  test("de WIN debita", () => {
    const s = scenario("100.00");
    const win = wager(Kind.Win, "30.00");
    s.settle(win);
    s.settle(wager(Kind.Rollback, "30.00", refOf(win)), { reference: win });
    s.expectConsistent("100.00");
  });

  test("de REFUND debita", () => {
    const s = scenario("100.00");
    const bet = wager(Kind.Bet, "30.00");
    s.settle(bet);
    const refund = wager(Kind.Refund, "30.00", refOf(bet));
    s.settle(refund, { reference: bet });
    s.settle(wager(Kind.Rollback, "30.00", refOf(refund)), { reference: refund });
    s.expectConsistent("70.00");
  });

  test("que deixaria saldo negativo é rejeitado com código próprio, distinto de aposta sem saldo", () => {
    const s = scenario("0.00");
    const win = wager(Kind.Win, "50.00");
    s.settle(win);
    s.settle(wager(Kind.Bet, "45.00"));
    const rollback = wager(Kind.Rollback, "50.00", refOf(win));

    const result = s.settle(rollback, { reference: win });

    expect(result).toEqual({ outcome: Status.Rejected, failureCode: FailureCode.ReversalInsufficientFunds });
    expect(FailureCode.ReversalInsufficientFunds).not.toBe(FailureCode.InsufficientFunds);
    expect(rollback.balanceAfter?.toJSON().amount).toBe("5.00");
    s.expectConsistent("5.00");
  });

  test("de outro ROLLBACK é rejeitado", () => {
    const s = scenario("100.00");
    const bet = wager(Kind.Bet, "30.00");
    s.settle(bet);
    const rollback = wager(Kind.Rollback, "30.00", refOf(bet));
    s.settle(rollback, { reference: bet });

    const result = s.settle(wager(Kind.Rollback, "30.00", refOf(rollback)), { reference: rollback });

    expect(result).toMatchObject({ failureCode: FailureCode.InvalidReferenceKind });
  });
});

describe("referência fora de ordem", () => {
  test("referência ausente: PENDING_REFERENCE agendado, sem mexer no saldo", () => {
    const s = scenario("100.00");
    const refund = wager(Kind.Refund, "40.00", { referenceExternalTransactionId: "bet-ainda-nao-chegou" });

    const result = s.settle(refund);

    expect(result).toEqual({ outcome: Status.PendingReference, nextAttemptAt: new Date(NOW.getTime() + 1_000) });
    expect(refund.status).toBe(Status.PendingReference);
    s.expectConsistent("100.00");
  });

  test("quando a BET chega, o REFUND pendente é processado no retry", () => {
    const s = scenario("100.00");
    const refund = wager(Kind.Refund, "40.00", { referenceExternalTransactionId: "bet-late" });
    s.settle(refund);

    const bet = wager(Kind.Bet, "40.00", { externalTransactionId: "bet-late" });
    s.settle(bet);
    s.settle(refund, { reference: bet });

    expect(refund.status).toBe(Status.Processed);
    s.expectConsistent("100.00");
  });

  test("referência que ela mesma está pendente conta como ausente", () => {
    const s = scenario("100.00");
    const pendingRefund = wager(Kind.Refund, "40.00", { referenceExternalTransactionId: "bet-x" });
    s.settle(pendingRefund);
    const rollback = wager(Kind.Rollback, "40.00", refOf(pendingRefund));

    expect(s.settle(rollback, { reference: pendingRefund }).outcome).toBe(Status.PendingReference);
  });

  test("esgotadas as tentativas, REJECTED com REFERENCE_NOT_FOUND", () => {
    const s = scenario("100.00");
    const refund = wager(Kind.Refund, "40.00", { referenceExternalTransactionId: "nunca-chega" });

    const outcomes = [s.settle(refund), s.settle(refund), s.settle(refund)].map((r) => r.outcome);

    expect(outcomes).toEqual([Status.PendingReference, Status.PendingReference, Status.Rejected]);
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotFound);
    s.expectConsistent("100.00");
  });
});

describe("validações contra a wallet", () => {
  test("moeda diferente da wallet: REJECTED sem movimentação", () => {
    const s = scenario("100.00");
    const tx = wager(Kind.Win, "10.00", { money: Money.from({ amount: "10.00", currency: "USD" }) });

    expect(s.settle(tx)).toEqual({ outcome: Status.Rejected, failureCode: FailureCode.CurrencyMismatch });
    s.expectConsistent("100.00");
  });

  test("player que não é dono da wallet: REJECTED", () => {
    const s = scenario("100.00");
    expect(s.settle(wager(Kind.Win, "10.00", { playerId: "intruso" }))).toMatchObject({
      failureCode: FailureCode.PlayerMismatch,
    });
    s.expectConsistent("100.00");
  });
});
