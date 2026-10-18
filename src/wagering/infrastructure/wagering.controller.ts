import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ProviderAuthGuard } from "../../auth/provider-auth.guard";
import { correlationIdOf, type HttpRequest, type HttpResponse } from "../../http/http-types";
import {
  assertUuid,
  IdempotencyKeySchema,
  parseWith,
  WagerTransactionRequestSchema,
} from "../../http/validation";
import { InvalidRequestError } from "../../shared/application/errors";
import { Logger } from "../../shared/application/ports";
import { ProcessWagerTransaction } from "../application/process-wager-transaction";
import type { WagerTransactionResult } from "../application/views";
import { WagerTransactionQueries } from "../application/wager-transaction-queries";
import { WagerTransactionStatus } from "../domain/wager-transaction";

export function httpStatusFor(result: WagerTransactionResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Failed:
      return 500;
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
  }
}

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransaction) private readonly processWager: ProcessWagerTransaction,
    @Inject(WagerTransactionQueries) private readonly queries: WagerTransactionQueries,
    @Inject(Logger) private readonly logger: Logger,
  ) {}

  @Post("wagering/transactions")
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    if (idempotencyKey === undefined) {
      throw new InvalidRequestError("o header Idempotency-Key é obrigatório");
    }
    const key = parseWith(IdempotencyKeySchema, idempotencyKey);
    const command = parseWith(WagerTransactionRequestSchema, body);
    const correlationId = correlationIdOf(request);

    const outcome = await this.processWager.execute({ ...command, idempotencyKey: key }, { correlationId, source: "http" });

    this.logger.info("transação recebida via HTTP", {
      correlationId,
      transactionId: outcome.transactionId,
      walletId: outcome.walletId,
      providerId: command.providerId,
      status: outcome.status,
      failureCode: outcome.failureCode,
      idempotentReplay: outcome.idempotentReplay,
    });
    response.status(httpStatusFor(outcome));
    return {
      transactionId: outcome.transactionId,
      status: outcome.status,
      balance: outcome.balance,
      ...(outcome.failureCode !== undefined && { failureCode: outcome.failureCode }),
      idempotentReplay: outcome.idempotentReplay,
    };
  }

  @Get("wagering/transactions/:transactionId")
  getById(@Param("transactionId") transactionId: string) {
    return this.queries.getById(assertUuid(transactionId, "transactionId"));
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  getByExternalId(@Param("providerId") providerId: string, @Param("externalTransactionId") externalTransactionId: string) {
    return this.queries.getByExternalId(providerId, externalTransactionId);
  }
}
