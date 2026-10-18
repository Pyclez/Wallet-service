import { Clock, IdGenerator } from "../application/ports";

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

export class UuidV7IdGenerator extends IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
