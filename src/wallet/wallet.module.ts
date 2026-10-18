import { Module } from "@nestjs/common";
import { Clock, IdGenerator, Logger, Telemetry } from "../shared/application/ports";
import { UnitOfWork } from "../shared/application/unit-of-work";
import { OpenWallet } from "./application/open-wallet";
import { ReconcileWallet } from "./application/reconcile-wallet";
import { WalletQueries } from "./application/wallet-queries";
import { WalletsController } from "./infrastructure/wallets.controller";

@Module({
  controllers: [WalletsController],
  providers: [
    {
      provide: OpenWallet,
      useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) => new OpenWallet(uow, ids, clock),
      inject: [UnitOfWork, IdGenerator, Clock],
    },
    { provide: WalletQueries, useFactory: (uow: UnitOfWork) => new WalletQueries(uow), inject: [UnitOfWork] },
    {
      provide: ReconcileWallet,
      useFactory: (uow: UnitOfWork, logger: Logger, telemetry: Telemetry) => new ReconcileWallet(uow, logger, telemetry),
      inject: [UnitOfWork, Logger, Telemetry],
    },
  ],
})
export class WalletModule {}
