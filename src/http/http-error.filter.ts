import { Catch, HttpException, Inject, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import {
  IdempotencyConflictError,
  InvalidRequestError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../shared/application/errors";
import { Logger } from "../shared/application/ports";
import { DomainError } from "../shared/domain/errors";
import type { HttpRequest, HttpResponse } from "./http-types";

interface ErrorResponse {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  retryAfterSeconds?: number;
}

const STATUS_CODES: Readonly<Record<number, string>> = {
  400: "INVALID_PAYLOAD",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
};

export function toErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof InvalidRequestError) {
    return { status: 400, code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof DomainError) {
    return { status: 400, code: error.code, message: error.message };
  }
  if (error instanceof IdempotencyConflictError || error instanceof WalletAlreadyExistsError) {
    return { status: 409, code: error.code, message: error.message };
  }
  if (error instanceof WalletNotFoundError || error instanceof TransactionNotFoundError) {
    return { status: 404, code: error.code, message: error.message };
  }
  if (error instanceof TransientInfrastructureError) {
    return { status: 503, code: error.code, message: error.message, retryAfterSeconds: 1 };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return { status, code: STATUS_CODES[status] ?? "HTTP_ERROR", message: error.message };
  }
  return { status: 500, code: "INTERNAL_ERROR", message: "erro inesperado" };
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(@Inject(Logger) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const response = http.getResponse<HttpResponse>();
    const error = toErrorResponse(exception);

    if (error.status >= 500) {
      this.logger.error(
        "falha ao atender requisição",
        { correlationId: request.correlationId, method: request.method, path: request.url, status: error.status },
        exception,
      );
    }
    if (error.retryAfterSeconds !== undefined) {
      response.setHeader("Retry-After", String(error.retryAfterSeconds));
    }
    response.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details !== undefined && { details: error.details }),
      },
    });
  }
}
