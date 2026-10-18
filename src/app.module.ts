import { Module, type DynamicModule, type Provider } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import type { AppConfig } from "./config";
import { CoreModule } from "./core.module";
import { HttpErrorFilter } from "./http/http-error.filter";
import { MessagingModule } from "./messaging/messaging.module";
import { ObservabilityModule } from "./observability/observability.module";
import { WageringModule } from "./wagering/wagering.module";
import { WalletModule } from "./wallet/wallet.module";

@Module({})
export class AppModule {
  static register(config: AppConfig, extraProviders: Provider[] = []): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.register(config, extraProviders),
        WalletModule,
        WageringModule,
        MessagingModule,
        ObservabilityModule,
      ],
      providers: [{ provide: APP_FILTER, useClass: HttpErrorFilter }],
    };
  }
}
