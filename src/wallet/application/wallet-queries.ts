import { InvalidRequestError, WalletNotFoundError } from "../../shared/application/errors";
import type { UnitOfWork } from "../../shared/application/unit-of-work";
import { toLedgerEntryView, toWalletView, type LedgerPage, type WalletView } from "./views";

export const MAX_LEDGER_PAGE_SIZE = 100;

export class WalletQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.run((repos) => repos.wallets.findById(walletId));
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }
    return toWalletView(wallet);
  }

  async getLedger(walletId: string, options: { cursor?: string; limit: number }): Promise<LedgerPage> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_LEDGER_PAGE_SIZE) {
      throw new InvalidRequestError(`limit deve estar entre 1 e ${MAX_LEDGER_PAGE_SIZE}`);
    }
    const beforeVersion = options.cursor === undefined ? undefined : decodeCursor(options.cursor);

    return this.uow.run(async (repos) => {
      const wallet = await repos.wallets.findById(walletId);
      if (!wallet) {
        throw new WalletNotFoundError(walletId);
      }
      const entries = await repos.ledger.page(walletId, { beforeVersion, limit: options.limit + 1 });
      const page = entries.slice(0, options.limit);
      const last = page.at(-1);
      return {
        items: page.map(toLedgerEntryView),
        nextCursor: entries.length > options.limit && last ? encodeCursor(last.walletVersion) : null,
      };
    });
  }
}

function encodeCursor(walletVersion: number): string {
  return Buffer.from(JSON.stringify({ v: walletVersion })).toString("base64url");
}

function decodeCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown };
    if (typeof parsed.v === "number" && Number.isInteger(parsed.v) && parsed.v > 0) {
      return parsed.v;
    }
  } catch {}
  throw new InvalidRequestError("cursor inválido");
}
