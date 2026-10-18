import type { Money } from "../../shared/domain/money";
import type { Wallet } from "../domain/wallet";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  lockById(id: string): Promise<Wallet | undefined>;
  lockForRead(id: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface LedgerSummary {
  net: Money;
  entries: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  page(walletId: string, options: { beforeVersion?: number; limit: number }): Promise<WalletLedgerEntry[]>;
  summarize(walletId: string, currency: string): Promise<LedgerSummary>;
}
