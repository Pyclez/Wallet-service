import "reflect-metadata";
import type { INestApplication, Provider } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import type { AppConfig } from "./config";
import { correlationIdMiddleware } from "./http/http-types";
import { NestLoggerAdapter } from "./observability/logger";

export async function bootstrap(config: AppConfig, extraProviders: Provider[] = []): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(config, extraProviders), { bufferLogs: true });
  app.useLogger(app.get(NestLoggerAdapter));
  app.use(correlationIdMiddleware);
  app.enableShutdownHooks();
  await app.listen(config.port);
  return app;
}
