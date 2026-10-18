import type { LoggerService } from "@nestjs/common";
import pino from "pino";
import { Logger, type LogFields } from "../shared/application/ports";

const REDACTED_PATHS = [
  "money",
  "*.money",
  "balance",
  "*.balance",
  "amount",
  "*.amount",
  "payload",
  "*.payload",
  "body",
  "*.body",
];

export class PinoLogger extends Logger {
  private constructor(private readonly instance: pino.Logger) {
    super();
  }

  static create(level: string): PinoLogger {
    return new PinoLogger(
      pino({
        level,
        base: { service: "wallet-service" },
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: { level: (label) => ({ level: label }) },
        serializers: { err: pino.stdSerializers.err },
        redact: { paths: REDACTED_PATHS, remove: true },
      }),
    );
  }

  info(message: string, fields: LogFields = {}): void {
    this.instance.info(fields, message);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.instance.warn(fields, message);
  }

  error(message: string, fields: LogFields = {}, error?: unknown): void {
    this.instance.error(error === undefined ? fields : { ...fields, err: error }, message);
  }

  child(fields: LogFields): Logger {
    return new PinoLogger(this.instance.child(fields));
  }
}

export class NestLoggerAdapter implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: string): void {
    this.logger.info(String(message), { context });
  }

  warn(message: unknown, context?: string): void {
    this.logger.warn(String(message), { context });
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error(String(message), { context, trace });
  }

  debug(): void {}

  verbose(): void {}
}
