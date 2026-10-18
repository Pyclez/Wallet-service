import type { MikroORM } from "@mikro-orm/postgresql";
import { TransientInfrastructureError, UniqueViolationError } from "../shared/application/errors";
import type { Clock, Telemetry } from "../shared/application/ports";
import { UnitOfWork, type TransactionalRepositories } from "../shared/application/unit-of-work";
import { createRepositories } from "./repositories";

const TRANSIENT_SQLSTATES: Readonly<Record<string, string>> = {
  "40001": "serialization_failure",
  "40P01": "deadlock",
  "55P03": "lock_timeout",
  "57014": "statement_timeout",
  "57P01": "admin_shutdown",
  "57P02": "crash_shutdown",
  "57P03": "cannot_connect_now",
  "53300": "too_many_connections",
  "08000": "connection_exception",
  "08001": "connection_exception",
  "08003": "connection_exception",
  "08004": "connection_exception",
  "08006": "connection_exception",
};

const TRANSIENT_NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]);
const LOCK_CONFLICTS = new Set(["deadlock", "lock_timeout", "serialization_failure"]);

export class MikroOrmUnitOfWork extends UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly lockTimeoutMs: number,
    private readonly telemetry: Telemetry,
    private readonly clock: Clock,
  ) {
    super();
  }

  async run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        await em.execute(`set local lock_timeout = '${Math.trunc(this.lockTimeoutMs)}ms'`);
        return work(createRepositories(em, this.clock));
      });
    } catch (error) {
      throw this.translate(error);
    }
  }

  private translate(error: unknown): unknown {
    const details = error as { code?: unknown; constraint?: unknown; message?: unknown; name?: unknown };
    const code = typeof details.code === "string" ? details.code : undefined;

    if (code === "23505") {
      return new UniqueViolationError(constraintOf(details), error);
    }
    const sqlReason = code ? TRANSIENT_SQLSTATES[code] : undefined;
    if (sqlReason) {
      if (LOCK_CONFLICTS.has(sqlReason)) {
        this.telemetry.lockConflict(sqlReason);
      }
      return new TransientInfrastructureError("banco de dados temporariamente indisponível", sqlReason, error);
    }
    const message = typeof details.message === "string" ? details.message : "";
    if (
      (code && TRANSIENT_NETWORK_CODES.has(code)) ||
      details.name === "ConnectionException" ||
      /Connection terminated|connection is closed|timeout exceeded when trying to connect/i.test(message)
    ) {
      return new TransientInfrastructureError("banco de dados inacessível", "connection", error);
    }
    return error;
  }
}

function constraintOf(details: { constraint?: unknown; message?: unknown }): string | undefined {
  if (typeof details.constraint === "string") {
    return details.constraint;
  }
  const match = typeof details.message === "string" ? /constraint "([^"]+)"/.exec(details.message) : null;
  return match?.[1];
}
