export abstract class Clock {
  abstract now(): Date;
}

export abstract class IdGenerator {
  abstract next(): string;
}

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export abstract class Logger {
  abstract info(message: string, fields?: LogFields): void;
  abstract warn(message: string, fields?: LogFields): void;
  abstract error(message: string, fields?: LogFields, error?: unknown): void;
  abstract child(fields: LogFields): Logger;
}

export type ProcessingSource = "http" | "sqs" | "worker";

export abstract class Telemetry {
  abstract transactionSettled(status: string, source: ProcessingSource, durationSeconds: number): void;
  abstract duplicateDetected(source: ProcessingSource, mechanism: "idempotency_key" | "inbox"): void;
  abstract idempotencyConflict(source: ProcessingSource): void;
  abstract retry(reason: string): void;
  abstract lockConflict(kind: string): void;
  abstract deadLettered(reason: string): void;
  abstract reconciliationDivergence(): void;
  abstract outboxPublished(count: number): void;
}
