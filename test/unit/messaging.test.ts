import { describe, expect, test } from "bun:test";
import { InboxMessage } from "../../src/messaging/domain/inbox-message";
import { OutboxMessage } from "../../src/messaging/domain/outbox-message";
import { FailureCode } from "../../src/wagering/domain/failure-code";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from "../../src/wagering/domain/wager-events";
import { ReferenceRetryPolicy } from "../../src/wagering/domain/reference-retry-policy";
import { WagerTransactionKind as Kind } from "../../src/wagering/domain/wager-transaction";
import { WalletBalanceChanged } from "../../src/wallet/domain/wallet-events";
import { NOW, brl, nextId, openWallet, wager } from "../support/domain";

const ctx = () => ({ eventId: nextId("evt"), correlationId: "corr-1", causationId: "msg-1", occurredAt: NOW });

describe("eventos de integração", () => {
  test("WalletBalanceChanged carrega MoneyProps e a version da wallet", () => {
    const { wallet } = openWallet("100.00");
    const entry = wallet.debit({ money: brl("25.00"), transactionId: "tx-1", entryId: "e-1", at: NOW });

    const envelope = WalletBalanceChanged.from(wallet, entry, ctx()).toJSON();

    expect(envelope).toMatchObject({
      eventType: "WalletBalanceChanged",
      version: 1,
      aggregateId: wallet.id,
      correlationId: "corr-1",
      causationId: "msg-1",
      occurredAt: NOW.toISOString(),
      data: {
        transactionId: "tx-1",
        direction: "DEBIT",
        money: { amount: "25.00", currency: "BRL" },
        balanceBefore: { amount: "100.00", currency: "BRL" },
        balanceAfter: { amount: "75.00", currency: "BRL" },
        walletVersion: 2,
      },
    });
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
  });

  test("eventos de transação usam o id da transação como aggregateId", () => {
    const tx = wager(Kind.Bet, "10.00");
    tx.markProcessed(undefined, brl("90.00"), NOW);
    const processed = WagerTransactionProcessed.from(tx, ctx()).toJSON();
    expect(processed.aggregateId).toBe(tx.id);
    expect(processed.data.balanceAfter).toEqual({ amount: "90.00", currency: "BRL" });

    const rejected = wager(Kind.Bet, "10.00");
    rejected.reject(FailureCode.InsufficientFunds, brl("5.00"));
    expect(WagerTransactionRejected.from(rejected, ctx()).toJSON().data.failureCode).toBe(FailureCode.InsufficientFunds);

    const pending = wager(Kind.Refund, "10.00", { referenceExternalTransactionId: "bet-x" });
    pending.markPendingReference(ReferenceRetryPolicy.create(), NOW);
    expect(WagerTransactionPendingReference.from(pending, ctx()).toJSON().data.referenceExternalTransactionId).toBe("bet-x");
  });

  test("os dados do evento são imutáveis", () => {
    const tx = wager(Kind.Bet, "10.00");
    tx.markProcessed(undefined, brl("90.00"), NOW);
    const event = WagerTransactionProcessed.from(tx, ctx());
    expect(Object.isFrozen(event.data)).toBe(true);
  });
});

describe("OutboxMessage", () => {
  const message = () => {
    const tx = wager(Kind.Bet, "10.00");
    tx.markProcessed(undefined, brl("90.00"), NOW);
    return OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, ctx()));
  };

  test("enqueue grava o envelope serializado e nasce pendente e devido", () => {
    const outbox = message();
    expect(outbox.payload.eventType).toBe("WagerTransactionProcessed");
    expect(outbox.isPending()).toBe(true);
    expect(outbox.isDue(NOW)).toBe(true);
    expect(outbox.attempts).toBe(0);
  });

  test("scheduleRetry aplica backoff exponencial com teto", () => {
    const outbox = message();
    const delays = Array.from({ length: 8 }, () => {
      outbox.scheduleRetry(NOW);
      return outbox.nextAttemptAt!.getTime() - NOW.getTime();
    });
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    expect(outbox.isDue(NOW)).toBe(false);
    expect(outbox.isDue(new Date(NOW.getTime() + 60_000))).toBe(true);
  });

  test("markPublished encerra o ciclo", () => {
    const outbox = message();
    outbox.markPublished(NOW);
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(new Date(NOW.getTime() + 1e9))).toBe(false);
  });
});

describe("InboxMessage", () => {
  test("receive nasce não processada; markProcessed é idempotente", () => {
    const inbox = InboxMessage.receive({ messageId: "m-1", consumerName: "wager", payloadHash: "h", receivedAt: NOW });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(NOW);
    inbox.markProcessed(new Date(NOW.getTime() + 1000));
    expect(inbox.processedAt).toEqual(NOW);
  });
});
