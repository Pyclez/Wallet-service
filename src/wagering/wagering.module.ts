import { Module } from "@nestjs/common";
import type { AppConfig } from "../config";
import { Clock, IdGenerator, Logger, Telemetry } from "../shared/application/ports";
import { UnitOfWork } from "../shared/application/unit-of-work";
import { APP_CONFIG } from "../tokens";
import { ProcessWagerTransaction } from "./application/process-wager-transaction";
import { ReprocessPendingReferences } from "./application/reprocess-pending-references";
import { WagerTransactionQueries } from "./application/wager-transaction-queries";
import { WagerTransactionSettler } from "./application/wager-transaction-settler";
import { ReferenceRetryPolicy } from "./domain/reference-retry-policy";
import { PendingReferenceWorker } from "./infrastructure/pending-reference.worker";
import { WagerTransactionConsumer } from "./infrastructure/wager-transaction.consumer";
import { WageringController } from "./infrastructure/wagering.controller";

@Module({
  controllers: [WageringController],
  providers: [
    {
      provide: ReferenceRetryPolicy,
      useFactory: (config: AppConfig) =>
        ReferenceRetryPolicy.create({
          baseDelayMs: config.references.baseDelayMs,
          maxDelayMs: config.references.maxDelayMs,
          maxRetries: config.references.maxRetries,
        }),
      inject: [APP_CONFIG],
    },
    {
      provide: WagerTransactionSettler,
      useFactory: (ids: IdGenerator, policy: ReferenceRetryPolicy) => new WagerTransactionSettler(ids, policy),
      inject: [IdGenerator, ReferenceRetryPolicy],
    },
    {
      provide: ProcessWagerTransaction,
      useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock, settler: WagerTransactionSettler, telemetry: Telemetry) =>
        new ProcessWagerTransaction(uow, ids, clock, settler, telemetry),
      inject: [UnitOfWork, IdGenerator, Clock, WagerTransactionSettler, Telemetry],
    },
    {
      provide: ReprocessPendingReferences,
      useFactory: (uow: UnitOfWork, clock: Clock, settler: WagerTransactionSettler, telemetry: Telemetry, logger: Logger) =>
        new ReprocessPendingReferences(uow, clock, settler, telemetry, logger),
      inject: [UnitOfWork, Clock, WagerTransactionSettler, Telemetry, Logger],
    },
    {
      provide: WagerTransactionQueries,
      useFactory: (uow: UnitOfWork) => new WagerTransactionQueries(uow),
      inject: [UnitOfWork],
    },
    WagerTransactionConsumer,
    PendingReferenceWorker,
  ],
})
export class WageringModule {}
