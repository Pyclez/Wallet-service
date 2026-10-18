import { Inject, Injectable } from "@nestjs/common";
import type { AppConfig } from "../../config";
import { Logger } from "../../shared/application/ports";
import { PollingWorker } from "../../shared/infrastructure/polling-worker";
import { APP_CONFIG } from "../../tokens";
import { ReprocessPendingReferences } from "../application/reprocess-pending-references";

@Injectable()
export class PendingReferenceWorker extends PollingWorker {
  protected readonly logger: Logger;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ReprocessPendingReferences) private readonly reprocess: ReprocessPendingReferences,
    @Inject(Logger) logger: Logger,
  ) {
    super();
    this.logger = logger.child({ worker: "pending-references" });
  }

  protected isEnabled(): boolean {
    return this.config.workers.references;
  }

  protected intervalMs(): number {
    return this.config.references.pollIntervalMs;
  }

  protected tick(): Promise<number> {
    return this.reprocess.runOnce(this.config.references.batchSize);
  }
}
