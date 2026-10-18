import { UniqueViolationError, WalletAlreadyExistsError } from "../../shared/application/errors";
import type { Clock, IdGenerator } from "../../shared/application/ports";
import type { UnitOfWork } from "../../shared/application/unit-of-work";
import { Money, type MoneyProps } from "../../shared/domain/money";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import { WagerTransactionProcessed } from "../../wagering/domain/wager-events";
import { WagerTransaction } from "../../wagering/domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { WalletBalanceChanged } from "../domain/wallet-events";
import { toWalletView, type WalletView } from "./views";

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export class OpenWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: OpenWalletCommand, correlationId: string): Promise<WalletView> {
    const initialBalance = Money.from(command.initialBalance);
    const now = this.clock.now();
    const walletId = this.ids.next();
    const opening = initialBalance.isPositive()
      ? WagerTransaction.createOpening({
          id: this.ids.next(),
          walletId,
          playerId: command.playerId,
          money: initialBalance,
          at: now,
        })
      : undefined;
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance,
      at: now,
      opening: opening && { transactionId: opening.id, entryId: this.ids.next() },
    });

    try {
      await this.uow.run(async (repos) => {
        await repos.wallets.insert(wallet);
        if (opening && openingEntry) {
          await repos.transactions.insert(opening);
          await repos.ledger.append(openingEntry);
          const ctx = () => ({ eventId: this.ids.next(), correlationId, occurredAt: now });
          await repos.outbox.add([
            OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, ctx())),
            OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, ctx())),
          ]);
        }
      });
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === "wallets_player_currency_uq") {
        throw new WalletAlreadyExistsError(command.playerId, initialBalance.currency);
      }
      throw error;
    }

    return toWalletView(wallet);
  }
}
