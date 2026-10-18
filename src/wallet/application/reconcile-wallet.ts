import { WalletNotFoundError } from "../../shared/application/errors";
import type { Logger, Telemetry } from "../../shared/application/ports";
import type { UnitOfWork } from "../../shared/application/unit-of-work";
import type { MoneyProps } from "../../shared/domain/money";

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly logger: Logger,
    private readonly telemetry: Telemetry,
  ) {}

  async execute(walletId: string, correlationId: string): Promise<ReconciliationReport> {
    const report = await this.uow.run(async (repos) => {
      const wallet = await repos.wallets.lockForRead(walletId);
      if (!wallet) {
        throw new WalletNotFoundError(walletId);
      }
      const summary = await repos.ledger.summarize(walletId, wallet.currency);
      const difference = wallet.balance.subtract(summary.net);
      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: summary.net.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: summary.entries,
      };
    });

    if (!report.consistent) {
      this.telemetry.reconciliationDivergence();
      this.logger.error("divergência entre saldo e ledger", {
        correlationId,
        walletId,
        checkedEntries: report.checkedEntries,
      });
    }
    return report;
  }
}
