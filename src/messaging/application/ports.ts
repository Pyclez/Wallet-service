import type { InboxMessage } from "../domain/inbox-message";
import type { OutboxMessage } from "../domain/outbox-message";

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  insert(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  add(messages: readonly OutboxMessage[]): Promise<void>;
  claimDue(limit: number, leaseMs: number): Promise<OutboxMessage[]>;
  markPublished(message: OutboxMessage): Promise<void>;
  scheduleRetry(message: OutboxMessage, error: string): Promise<void>;
  oldestPendingAgeSeconds(): Promise<number>;
}

export abstract class EventPublisher {
  abstract publish(message: OutboxMessage): Promise<void>;
}
