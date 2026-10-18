import type { InboxRepository, OutboxRepository } from "../../messaging/application/ports";
import type { WagerTransactionRepository } from "../../wagering/application/ports";
import type { LedgerRepository, WalletRepository } from "../../wallet/application/ports";

export interface TransactionalRepositories {
  wallets: WalletRepository;
  ledger: LedgerRepository;
  transactions: WagerTransactionRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export abstract class UnitOfWork {
  abstract run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T>;
}
