import { TransactionNotFoundError } from "../../shared/application/errors";
import type { UnitOfWork } from "../../shared/application/unit-of-work";
import { toTransactionView, type WagerTransactionView } from "./views";

export class WagerTransactionQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async getById(transactionId: string): Promise<WagerTransactionView> {
    const transaction = await this.uow.run((repos) => repos.transactions.findById(transactionId));
    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }
    return toTransactionView(transaction);
  }

  async getByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransactionView> {
    const transaction = await this.uow.run((repos) =>
      repos.transactions.findByExternalId(providerId, externalTransactionId),
    );
    if (!transaction) {
      throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    }
    return toTransactionView(transaction);
  }
}
