import { InvalidWagerTransactionError } from "../../shared/domain/errors";

export class ReferenceRetryPolicy {
  private constructor(
    public readonly baseDelayMs: number,
    public readonly maxDelayMs: number,
    public readonly maxRetries: number,
  ) {}

  static create(props: { baseDelayMs?: number; maxDelayMs?: number; maxRetries?: number } = {}): ReferenceRetryPolicy {
    const { baseDelayMs = 1_000, maxDelayMs = 60_000, maxRetries = 10 } = props;
    if (!(baseDelayMs > 0) || !(maxDelayMs >= baseDelayMs) || !Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new InvalidWagerTransactionError("política de retry inválida");
    }
    return new ReferenceRetryPolicy(baseDelayMs, maxDelayMs, maxRetries);
  }

  delayFor(retry: number): number {
    return Math.min(this.baseDelayMs * 2 ** Math.max(retry - 1, 0), this.maxDelayMs);
  }

  nextAttemptAt(retry: number, now: Date): Date {
    return new Date(now.getTime() + this.delayFor(retry));
  }
}
