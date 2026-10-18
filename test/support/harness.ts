import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { loadConfig, type AppConfig } from "../../src/config";
import { createSqsClient, prepareQueues, type QueueUrls } from "../../src/messaging/infrastructure/sqs";
import { PinoLogger } from "../../src/observability/logger";
import { createTestDatabase, testDatabaseUrl } from "./database";

const PROJECT_ROOT = resolve(import.meta.dir, "../..");
const LOG_DIR = join(tmpdir(), "wallet-service-tests");

export interface Instance {
  name: string;
  baseUrl: string;
  process: Subprocess;
  logFile: string;
  stop(signal?: NodeJS.Signals): Promise<number | null>;
}

export interface TestEnvironment {
  orm: MikroORM;
  sqs: SQSClient;
  queues: QueueUrls;
  config: AppConfig;
  env: Record<string, string>;
  startInstance(name: string, overrides?: Record<string, string>): Promise<Instance>;
  spawnInstance(name: string, overrides?: Record<string, string>, entry?: string): Instance;
  close(): Promise<void>;
}

export async function createTestEnvironment(name: string, overrides: Record<string, string> = {}): Promise<TestEnvironment> {
  mkdirSync(LOG_DIR, { recursive: true });
  const suffix = `${name}-${Date.now().toString(36)}`;
  const env: Record<string, string> = {
    DATABASE_URL: testDatabaseUrl(name),
    SQS_ENDPOINT: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
    WAGER_QUEUE_NAME: `wager-${suffix}.fifo`,
    WAGER_DLQ_NAME: `wager-dlq-${suffix}.fifo`,
    EVENTS_QUEUE_NAME: `events-${suffix}.fifo`,
    SQS_WAIT_TIME_SECONDS: "1",
    SQS_VISIBILITY_TIMEOUT_SECONDS: "3",
    SQS_MAX_RECEIVE_COUNT: "3",
    SQS_TRANSIENT_BASE_DELAY_SECONDS: "1",
    REFERENCE_RETRY_BASE_MS: "200",
    REFERENCE_RETRY_MAX_MS: "1000",
    REFERENCE_RETRY_MAX_ATTEMPTS: "3",
    REFERENCE_POLL_INTERVAL_MS: "100",
    OUTBOX_POLL_INTERVAL_MS: "100",
    OUTBOX_LEASE_MS: "2000",
    SHUTDOWN_TIMEOUT_MS: "8000",
    LOCK_TIMEOUT_MS: "5000",
    LOG_LEVEL: "info",
    ...overrides,
  };
  const config = loadConfig(env);
  const orm = await createTestDatabase(name);
  const sqs = createSqsClient(config.sqs);
  const queues = await prepareQueues(sqs, config.sqs, PinoLogger.create("silent"), 5);
  const instances: Instance[] = [];

  const spawnInstance = (instanceName: string, extra: Record<string, string> = {}, entry = "src/main.ts"): Instance => {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const logFile = join(LOG_DIR, `${suffix}-${instanceName}-${port}.log`);
    const child = Bun.spawn(["bun", entry], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env, ...extra, PORT: String(port) },
      stdout: Bun.file(logFile),
      stderr: "inherit",
    });
    const instance: Instance = {
      name: instanceName,
      baseUrl: `http://localhost:${port}`,
      process: child,
      logFile,
      async stop(signal: NodeJS.Signals = "SIGTERM") {
        if (child.exitCode === null && !child.killed) {
          child.kill(signal);
        }
        return child.exited;
      },
    };
    instances.push(instance);
    return instance;
  };

  const startInstance = async (instanceName: string, extra: Record<string, string> = {}): Promise<Instance> => {
    for (let attempt = 1; ; attempt++) {
      const instance = spawnInstance(instanceName, extra);
      const ready = await waitFor(
        async () => {
          if (instance.process.exitCode !== null) {
            return "exited";
          }
          const response = await fetch(`${instance.baseUrl}/health/ready`).catch(() => undefined);
          return response?.status === 200 ? "ready" : undefined;
        },
        { timeoutMs: 20_000, intervalMs: 100 },
      );
      if (ready === "ready") {
        return instance;
      }
      await instance.stop("SIGKILL");
      if (attempt >= 3) {
        throw new Error(`instância ${instanceName} não ficou pronta; log em ${instance.logFile}`);
      }
    }
  };

  return {
    orm,
    sqs,
    queues,
    config,
    env,
    startInstance,
    spawnInstance,
    async close() {
      await Promise.all(instances.map((instance) => instance.stop("SIGKILL")));
      sqs.destroy();
      await orm.close(true);
    },
  };
}

export async function waitFor<T>(
  check: () => Promise<T | undefined | false> | T | undefined | false,
  { timeoutMs = 15_000, intervalMs = 100 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`condição não atingida em ${timeoutMs}ms`);
    }
    await Bun.sleep(intervalMs);
  }
}

export interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
}

export async function request<T = Record<string, unknown>>(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

export async function openWallet(baseUrl: string, amount: string, playerId: string = Bun.randomUUIDv7()) {
  const response = await request<{ id: string; playerId: string; version: number }>(baseUrl, "POST", "/wallets", {
    playerId,
    initialBalance: { amount, currency: "BRL" },
  });
  if (response.status !== 201) {
    throw new Error(`falha ao criar wallet: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

export interface WagerInput {
  walletId: string;
  playerId: string;
  kind: string;
  amount: string;
  externalTransactionId?: string;
  referenceExternalTransactionId?: string;
  roundId?: string;
  providerId?: string;
}

export function wagerPayload(input: WagerInput) {
  const externalTransactionId = input.externalTransactionId ?? `ext-${Bun.randomUUIDv7()}`;
  const providerId = input.providerId ?? "provider-a";
  return {
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    body: {
      providerId,
      externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId ?? "round-1",
      gameId: "fortune-chimp",
      kind: input.kind,
      money: { amount: input.amount, currency: "BRL" },
      ...(input.referenceExternalTransactionId !== undefined && {
        referenceExternalTransactionId: input.referenceExternalTransactionId,
      }),
    },
  };
}

export function submitWager(baseUrl: string, input: WagerInput) {
  const { idempotencyKey, body } = wagerPayload(input);
  return request<{ transactionId: string; status: string; balance: { amount: string } | null; failureCode?: string; idempotentReplay: boolean }>(
    baseUrl,
    "POST",
    "/wagering/transactions",
    body,
    { "Idempotency-Key": idempotencyKey },
  );
}

export async function sendWagerMessage(
  env: TestEnvironment,
  input: WagerInput & { messageId?: string; groupId?: string },
) {
  const { idempotencyKey, body } = wagerPayload(input);
  const messageId = input.messageId ?? `msg-${Bun.randomUUIDv7()}`;
  await env.sqs.send(
    new SendMessageCommand({
      QueueUrl: env.queues.wager,
      MessageBody: JSON.stringify({
        messageId,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: { ...body, idempotencyKey },
      }),
      MessageGroupId: input.groupId ?? input.walletId,
      MessageDeduplicationId: `${messageId}-${Bun.randomUUIDv7()}`,
    }),
  );
  return { messageId, externalTransactionId: body.externalTransactionId };
}

export async function sendRawMessage(env: TestEnvironment, body: string, groupId = "raw") {
  await env.sqs.send(
    new SendMessageCommand({
      QueueUrl: env.queues.wager,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: Bun.randomUUIDv7(),
    }),
  );
}

export async function drainQueue(sqs: SQSClient, queueUrl: string, { idleRounds = 2 } = {}): Promise<Message[]> {
  const collected: Message[] = [];
  let idle = 0;
  while (idle < idleRounds) {
    const response = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ["All"],
      }),
    );
    const messages = response.Messages ?? [];
    if (messages.length === 0) {
      idle++;
      continue;
    }
    idle = 0;
    collected.push(...messages);
    await Promise.all(
      messages.map((message) =>
        sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle })),
      ),
    );
  }
  return collected;
}

export async function queueIsEmpty(sqs: SQSClient, queueUrl: string): Promise<boolean> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return Attributes?.ApproximateNumberOfMessages === "0" && Attributes?.ApproximateNumberOfMessagesNotVisible === "0";
}

export async function scalar<T>(orm: MikroORM, sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await orm.em.fork().execute<Record<string, T>[]>(sql, params);
  return Object.values(row ?? {})[0] as T;
}
