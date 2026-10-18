import { TransientInfrastructureError } from "../../shared/application/errors";
import type { Clock, Logger, Telemetry } from "../../shared/application/ports";
import type { UnitOfWork } from "../../shared/application/unit-of-work";
import { FailureCode } from "../domain/failure-code";
import { WagerTransactionStatus } from "../domain/wager-transaction";
import type { WagerTransactionSettler } from "./wager-transaction-settler";

export class ReprocessPendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly settler: WagerTransactionSettler,
    private readonly telemetry: Telemetry,
    private readonly logger: Logger,
  ) {}

  async runOnce(limit: number): Promise<number> {
    const due = await this.uow.run((repos) => repos.transactions.findDuePendingReferences(limit));
    let handled = 0;

    for (const item of due) {
      const log = this.logger.child({ transactionId: item.id, walletId: item.walletId });
      try {
        const outcome = await this.uow.run(async (repos) => {
          const wallet = await repos.wallets.lockById(item.walletId);
          const transaction = await repos.transactions.lockDuePendingReference(item.id);
          if (!wallet || !transaction) {
            return undefined;
          }
          const result = await this.settler.settle(repos, wallet, transaction, {
            correlationId: transaction.id,
            causationId: transaction.id,
            now: this.clock.now(),
          });
          return result.outcome;
        });
        if (outcome === undefined) {
          continue;
        }
        handled++;
        this.telemetry.retry("pending_reference");
        if (outcome !== WagerTransactionStatus.PendingReference) {
          this.telemetry.transactionSettled(outcome, "worker", 0);
          log.info("referência pendente resolvida", { status: outcome });
        }
      } catch (error) {
        if (error instanceof TransientInfrastructureError) {
          log.warn("falha transitória ao reprocessar referência", { reason: error.reason });
          continue;
        }
        log.error("falha permanente ao reprocessar referência", {}, error);
        await this.markFailed(item.id);
      }
    }
    return handled;
  }

  private async markFailed(transactionId: string): Promise<void> {
    await this.uow.run(async (repos) => {
      const transaction = await repos.transactions.lockDuePendingReference(transactionId);
      if (!transaction) {
        return;
      }
      transaction.fail(FailureCode.ProcessingFailed);
      await repos.transactions.updatePending(transaction);
    });
    this.telemetry.transactionSettled(WagerTransactionStatus.Failed, "worker", 0);
  }
}
