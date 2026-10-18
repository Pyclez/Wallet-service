import type { BeforeApplicationShutdown, OnApplicationBootstrap } from "@nestjs/common";
import type { Logger } from "../application/ports";
import { sleep } from "./system";

export abstract class PollingWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private loop?: Promise<void>;
  private readonly stop = new AbortController();

  protected abstract readonly logger: Logger;
  protected abstract isEnabled(): boolean;
  protected abstract intervalMs(): number;
  protected abstract tick(): Promise<number>;

  onApplicationBootstrap(): void {
    if (this.isEnabled()) {
      this.logger.info("worker iniciado");
      this.loop = this.run();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stop.abort();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.stop.signal.aborted) {
      let handled = 0;
      try {
        handled = await this.tick();
      } catch (error) {
        this.logger.error("falha no ciclo do worker", {}, error);
      }
      if (handled === 0) {
        await sleep(this.intervalMs(), this.stop.signal);
      }
    }
    this.logger.info("worker encerrado");
  }
}
