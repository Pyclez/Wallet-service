import { DEFAULT_DATABASE_URL } from "./database/mikro-orm.config";

export interface AppConfig {
  port: number;
  logLevel: string;
  databaseUrl: string;
  databasePoolSize: number;
  lockTimeoutMs: number;
  shutdownTimeoutMs: number;
  sqs: {
    endpoint: string | undefined;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    wagerQueueName: string;
    wagerDlqName: string;
    eventsQueueName: string;
    createQueues: boolean;
    maxReceiveCount: number;
    visibilityTimeoutSeconds: number;
    waitTimeSeconds: number;
    batchSize: number;
    transientBaseDelaySeconds: number;
  };
  workers: {
    consumer: boolean;
    outbox: boolean;
    references: boolean;
  };
  outbox: {
    pollIntervalMs: number;
    batchSize: number;
    leaseMs: number;
  };
  references: {
    pollIntervalMs: number;
    batchSize: number;
    baseDelayMs: number;
    maxDelayMs: number;
    maxRetries: number;
  };
}

type Env = Record<string, string | undefined>;

function integer(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`variável ${name} precisa ser um inteiro não negativo (recebido "${raw}")`);
  }
  return value;
}

function flag(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  return raw === undefined || raw === "" ? fallback : ["1", "true", "yes"].includes(raw.toLowerCase());
}

export function loadConfig(env: Env = process.env): AppConfig {
  const workers = new Set(
    (env.WORKERS ?? "consumer,outbox,references")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );

  return {
    port: integer(env, "PORT", 3000),
    logLevel: env.LOG_LEVEL ?? "info",
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    databasePoolSize: integer(env, "DATABASE_POOL_SIZE", 10),
    lockTimeoutMs: integer(env, "LOCK_TIMEOUT_MS", 5_000),
    shutdownTimeoutMs: integer(env, "SHUTDOWN_TIMEOUT_MS", 10_000),
    sqs: {
      endpoint: env.SQS_ENDPOINT || undefined,
      region: env.AWS_REGION ?? "us-east-1",
      accessKeyId: env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? "test",
      wagerQueueName: env.WAGER_QUEUE_NAME ?? "wager-transactions.fifo",
      wagerDlqName: env.WAGER_DLQ_NAME ?? "wager-transactions-dlq.fifo",
      eventsQueueName: env.EVENTS_QUEUE_NAME ?? "wallet-events.fifo",
      createQueues: flag(env, "SQS_CREATE_QUEUES", true),
      maxReceiveCount: integer(env, "SQS_MAX_RECEIVE_COUNT", 5),
      visibilityTimeoutSeconds: integer(env, "SQS_VISIBILITY_TIMEOUT_SECONDS", 30),
      waitTimeSeconds: integer(env, "SQS_WAIT_TIME_SECONDS", 10),
      batchSize: Math.min(Math.max(integer(env, "SQS_BATCH_SIZE", 10), 1), 10),
      transientBaseDelaySeconds: integer(env, "SQS_TRANSIENT_BASE_DELAY_SECONDS", 2),
    },
    workers: {
      consumer: workers.has("consumer"),
      outbox: workers.has("outbox"),
      references: workers.has("references"),
    },
    outbox: {
      pollIntervalMs: integer(env, "OUTBOX_POLL_INTERVAL_MS", 500),
      batchSize: integer(env, "OUTBOX_BATCH_SIZE", 50),
      leaseMs: integer(env, "OUTBOX_LEASE_MS", 30_000),
    },
    references: {
      pollIntervalMs: integer(env, "REFERENCE_POLL_INTERVAL_MS", 500),
      batchSize: integer(env, "REFERENCE_BATCH_SIZE", 50),
      baseDelayMs: integer(env, "REFERENCE_RETRY_BASE_MS", 1_000),
      maxDelayMs: integer(env, "REFERENCE_RETRY_MAX_MS", 60_000),
      maxRetries: integer(env, "REFERENCE_RETRY_MAX_ATTEMPTS", 10),
    },
  };
}
