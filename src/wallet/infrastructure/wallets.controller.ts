import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ProviderAuthGuard } from "../../auth/provider-auth.guard";
import { correlationIdOf, type HttpRequest } from "../../http/http-types";
import { assertUuid, OpenWalletRequestSchema, parseWith } from "../../http/validation";
import { InvalidRequestError } from "../../shared/application/errors";
import { Logger } from "../../shared/application/ports";
import { OpenWallet } from "../application/open-wallet";
import { ReconcileWallet } from "../application/reconcile-wallet";
import { WalletQueries } from "../application/wallet-queries";

const DEFAULT_LEDGER_PAGE_SIZE = 50;

@Controller("wallets")
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
    @Inject(Logger) private readonly logger: Logger,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Req() request: HttpRequest) {
    const command = parseWith(OpenWalletRequestSchema, body);
    const correlationId = correlationIdOf(request);
    const wallet = await this.openWallet.execute(command, correlationId);
    this.logger.info("wallet criada", { correlationId, walletId: wallet.id });
    return wallet;
  }

  @Get(":walletId")
  get(@Param("walletId") walletId: string) {
    return this.queries.getWallet(assertUuid(walletId, "walletId"));
  }

  @Get(":walletId/ledger")
  ledger(@Param("walletId") walletId: string, @Query("cursor") cursor?: string, @Query("limit") limit?: string) {
    const pageSize = limit === undefined ? DEFAULT_LEDGER_PAGE_SIZE : Number(limit);
    if (!Number.isInteger(pageSize)) {
      throw new InvalidRequestError("limit deve ser um número inteiro");
    }
    return this.queries.getLedger(assertUuid(walletId, "walletId"), { cursor, limit: pageSize });
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  reconcile(@Param("walletId") walletId: string, @Req() request: HttpRequest) {
    return this.reconcileWallet.execute(assertUuid(walletId, "walletId"), correlationIdOf(request));
  }
}
