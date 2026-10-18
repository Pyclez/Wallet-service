import type { WagerTransaction } from "../domain/wager-transaction";

export interface DuePendingReference {
  id: string;
  walletId: string;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKeyOrExternalId(
    idempotencyKey: string,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction[]>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  insert(transaction: WagerTransaction): Promise<void>;
  updatePending(transaction: WagerTransaction): Promise<void>;
  findDuePendingReferences(limit: number): Promise<DuePendingReference[]>;
  lockDuePendingReference(id: string): Promise<WagerTransaction | undefined>;
}
