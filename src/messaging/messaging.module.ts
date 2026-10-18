import { SQSClient } from "@aws-sdk/client-sqs";
import { Module } from "@nestjs/common";
import type { AppConfig } from "../config";
import { Clock, Logger, Telemetry } from "../shared/application/ports";
import { UnitOfWork } from "../shared/application/unit-of-work";
import { APP_CONFIG, QUEUE_URLS } from "../tokens";
import { EventPublisher } from "./application/ports";
import { PublishOutbox } from "./application/publish-outbox";
import { OutboxPublisherWorker } from "./infrastructure/outbox-publisher.worker";
import { SqsEventPublisher, type QueueUrls } from "./infrastructure/sqs";

@Module({
  providers: [
    {
      provide: EventPublisher,
      useFactory: (sqs: SQSClient, queues: QueueUrls) => new SqsEventPublisher(sqs, queues.events),
      inject: [SQSClient, QUEUE_URLS],
    },
    {
      provide: PublishOutbox,
      useFactory: (
        uow: UnitOfWork,
        publisher: EventPublisher,
        clock: Clock,
        telemetry: Telemetry,
        logger: Logger,
        config: AppConfig,
      ) =>
        new PublishOutbox(uow, publisher, clock, telemetry, logger, {
          batchSize: config.outbox.batchSize,
          leaseMs: config.outbox.leaseMs,
        }),
      inject: [UnitOfWork, EventPublisher, Clock, Telemetry, Logger, APP_CONFIG],
    },
    OutboxPublisherWorker,
  ],
})
export class MessagingModule {}
