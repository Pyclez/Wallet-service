import { Inject, Injectable } from "@nestjs/common";
import type { AppConfig } from "../../config";
import { Logger } from "../../shared/application/ports";
import { PollingWorker } from "../../shared/infrastructure/polling-worker";
import { APP_CONFIG } from "../../tokens";
import { PublishOutbox } from "../application/publish-outbox";

@Injectable()
export class OutboxPublisherWorker extends PollingWorker {
  protected readonly logger: Logger;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PublishOutbox) private readonly publishOutbox: PublishOutbox,
    @Inject(Logger) logger: Logger,
  ) {
    super();
    this.logger = logger.child({ worker: "outbox-publisher" });
  }

  protected isEnabled(): boolean {
    return this.config.workers.outbox;
  }

  protected intervalMs(): number {
    return this.config.outbox.pollIntervalMs;
  }

  protected tick(): Promise<number> {
    return this.publishOutbox.runOnce();
  }
}
