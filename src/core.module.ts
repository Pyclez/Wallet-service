import { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type InjectionToken,
  type OnApplicationShutdown,
  type Provider,
} from "@nestjs/common";
import type { Registry } from "prom-client";
import { ProviderAuthGuard } from "./auth/provider-auth.guard";
import type { AppConfig } from "./config";
import { MikroOrmUnitOfWork } from "./database/mikro-orm-unit-of-work";
import { createOrmConfig } from "./database/mikro-orm.config";
import { createSqsClient, prepareQueues } from "./messaging/infrastructure/sqs";
import { NestLoggerAdapter, PinoLogger } from "./observability/logger";
import { createMetricsRegistry, PrometheusTelemetry, registerOutboxLagGauge } from "./observability/telemetry";
import { Clock, IdGenerator, Logger, Telemetry } from "./shared/application/ports";
import { UnitOfWork } from "./shared/application/unit-of-work";
import { SystemClock, UuidV7IdGenerator } from "./shared/infrastructure/system";
import { APP_CONFIG, METRICS_REGISTRY, QUEUE_URLS } from "./tokens";

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}

function tokenOf(provider: Provider): InjectionToken {
  return typeof provider === "function" ? provider : provider.provide;
}

@Module({})
export class CoreModule {
  static register(config: AppConfig, extraProviders: Provider[] = []): DynamicModule {
    const providers: Provider[] = [
      { provide: APP_CONFIG, useValue: config },
      { provide: Logger, useFactory: () => PinoLogger.create(config.logLevel) },
      { provide: NestLoggerAdapter, useFactory: (logger: Logger) => new NestLoggerAdapter(logger), inject: [Logger] },
      { provide: METRICS_REGISTRY, useFactory: createMetricsRegistry },
      {
        provide: Telemetry,
        useFactory: (registry: Registry) => new PrometheusTelemetry(registry),
        inject: [METRICS_REGISTRY],
      },
      { provide: Clock, useClass: SystemClock },
      { provide: IdGenerator, useClass: UuidV7IdGenerator },
      {
        provide: MikroORM,
        useFactory: () => MikroORM.init(createOrmConfig(config.databaseUrl, { poolSize: config.databasePoolSize })),
      },
      DatabaseLifecycle,
      {
        provide: UnitOfWork,
        useFactory: (orm: MikroORM, telemetry: Telemetry, clock: Clock, registry: Registry) => {
          const uow = new MikroOrmUnitOfWork(orm, config.lockTimeoutMs, telemetry, clock);
          registerOutboxLagGauge(registry, () => uow.run((repos) => repos.outbox.oldestPendingAgeSeconds()));
          return uow;
        },
        inject: [MikroORM, Telemetry, Clock, METRICS_REGISTRY],
      },
      { provide: SQSClient, useFactory: () => createSqsClient(config.sqs) },
      {
        provide: QUEUE_URLS,
        useFactory: (sqs: SQSClient, logger: Logger) => prepareQueues(sqs, config.sqs, logger),
        inject: [SQSClient, Logger],
      },
      ProviderAuthGuard,
      ...extraProviders,
    ];

    return {
      module: CoreModule,
      global: true,
      providers,
      exports: providers.filter((provider) => provider !== DatabaseLifecycle).map(tokenOf),
    };
  }
}
