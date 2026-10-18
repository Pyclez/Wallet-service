import type { Clock, Logger, Telemetry } from "../../shared/application/ports";
import type { UnitOfWork } from "../../shared/application/unit-of-work";
import type { EventPublisher } from "./ports";

export interface PublishOutboxOptions {
  batchSize: number;
  leaseMs: number;
}

export class PublishOutbox {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly telemetry: Telemetry,
    private readonly logger: Logger,
    private readonly options: PublishOutboxOptions,
  ) {}

  async runOnce(): Promise<number> {
    const batch = await this.uow.run((repos) => repos.outbox.claimDue(this.options.batchSize, this.options.leaseMs));
    let published = 0;

    for (const message of batch) {
      try {
        await this.publisher.publish(message);
        message.markPublished(this.clock.now());
        await this.uow.run((repos) => repos.outbox.markPublished(message));
        published++;
      } catch (error) {
        message.scheduleRetry(this.clock.now());
        this.telemetry.retry("outbox_publish");
        this.logger.warn("falha ao publicar evento; nova tentativa agendada", {
          eventId: message.id,
          eventType: message.eventType,
          attempts: message.attempts,
        });
        await this.uow.run((repos) => repos.outbox.scheduleRetry(message, error instanceof Error ? error.message : String(error)));
      }
    }

    if (published > 0) {
      this.telemetry.outboxPublished(published);
    }
    return batch.length;
  }
}
