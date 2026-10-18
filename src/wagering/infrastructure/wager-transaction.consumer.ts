import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import { Inject, Injectable, Optional, type BeforeApplicationShutdown, type OnApplicationBootstrap } from "@nestjs/common";
import type { AppConfig } from "../../config";
import { parseWith, WagerTransactionMessageSchema } from "../../http/validation";
import type { QueueUrls } from "../../messaging/infrastructure/sqs";
import {
  IdempotencyConflictError,
  InvalidRequestError,
  WalletNotFoundError,
} from "../../shared/application/errors";
import { Logger, Telemetry } from "../../shared/application/ports";
import { DomainError } from "../../shared/domain/errors";
import { sleep } from "../../shared/infrastructure/system";
import { AFTER_COMMIT_HOOK, APP_CONFIG, QUEUE_URLS } from "../../tokens";
import { ProcessWagerTransaction, type ProcessingOutcome } from "../application/process-wager-transaction";

export const WAGER_CONSUMER_NAME = "wager-transactions-consumer";

export type AfterCommitHook = (outcome: ProcessingOutcome) => void | Promise<void>;
const MAX_VISIBILITY_SECONDS = 900;

type Classification = "dead_letter" | "terminal" | "retry";

@Injectable()
export class WagerTransactionConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private loop?: Promise<void>;
  private stopping = false;
  private receiveAbort?: AbortController;
  private readonly logger: Logger;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(QUEUE_URLS) private readonly queues: QueueUrls,
    @Inject(ProcessWagerTransaction) private readonly processWager: ProcessWagerTransaction,
    @Inject(Telemetry) private readonly telemetry: Telemetry,
    @Inject(Logger) logger: Logger,
    @Optional() @Inject(AFTER_COMMIT_HOOK) private readonly afterCommit?: AfterCommitHook,
  ) {
    this.logger = logger.child({ worker: WAGER_CONSUMER_NAME });
  }

  onApplicationBootstrap(): void {
    if (this.config.workers.consumer) {
      this.logger.info("consumidor iniciado");
      this.loop = this.run();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.receiveAbort?.abort();
    if (!this.loop) {
      return;
    }
    const finished = await Promise.race([
      this.loop.then(() => true),
      sleep(this.config.shutdownTimeoutMs).then(() => false),
    ]);
    this.logger.info(finished ? "consumidor encerrado" : "consumidor encerrado por timeout; mensagens em voo voltam pela visibilidade");
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let messages: Message[];
      try {
        this.receiveAbort = new AbortController();
        const response = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queues.wager,
            MaxNumberOfMessages: this.config.sqs.batchSize,
            WaitTimeSeconds: this.config.sqs.waitTimeSeconds,
            VisibilityTimeout: this.config.sqs.visibilityTimeoutSeconds,
            MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
            MessageAttributeNames: ["All"],
          }),
          { abortSignal: this.receiveAbort.signal },
        );
        messages = response.Messages ?? [];
      } catch (error) {
        if (this.stopping) {
          break;
        }
        this.logger.warn("falha ao receber mensagens do SQS", { reason: error instanceof Error ? error.name : "unknown" });
        await sleep(1_000);
        continue;
      }
      try {
        await this.processBatch(messages);
      } catch (error) {
        this.logger.error("falha ao processar lote", {}, error);
      }
    }
  }

  private async processBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const key = message.Attributes?.MessageGroupId ?? message.MessageId ?? "";
      groups.set(key, [...(groups.get(key) ?? []), message]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const message of group) {
          if (this.stopping) {
            await this.release(message);
            continue;
          }
          await this.handleSafely(message);
        }
      }),
    );
  }

  private async handleSafely(message: Message): Promise<void> {
    try {
      await this.handle(message);
    } catch (error) {
      this.logger.error("falha inesperada ao tratar mensagem; ela volta pela visibilidade", { sqsMessageId: message.MessageId }, error);
    }
  }

  private async handle(message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
    let envelope;
    try {
      envelope = parseWith(WagerTransactionMessageSchema, JSON.parse(message.Body ?? ""));
    } catch {
      this.logger.warn("mensagem malformada enviada para a DLQ", { sqsMessageId: message.MessageId });
      await this.deadLetter(message, "malformed_message");
      return;
    }

    const { data } = envelope;
    const correlationId = message.MessageAttributes?.correlationId?.StringValue ?? envelope.messageId;
    const log = this.logger.child({
      messageId: envelope.messageId,
      correlationId,
      walletId: data.walletId,
      providerId: data.providerId,
      externalTransactionId: data.externalTransactionId,
    });

    try {
      const outcome = await this.processWager.execute(data, {
        correlationId,
        source: "sqs",
        inbox: { consumerName: WAGER_CONSUMER_NAME, messageId: envelope.messageId },
      });
      await this.afterCommit?.(outcome);
      await this.ack(message);
      log.info("mensagem processada", {
        transactionId: outcome.transactionId,
        status: outcome.status,
        failureCode: outcome.failureCode,
        idempotentReplay: outcome.idempotentReplay,
      });
    } catch (error) {
      const classification = classify(error);
      if (classification === "dead_letter") {
        log.warn("mensagem inválida enviada para a DLQ", { reason: error instanceof Error ? error.message : "unknown" });
        await this.deadLetter(message, "invalid_payload");
      } else if (classification === "terminal") {
        log.warn("mensagem encerrada sem efeito", { reason: error instanceof Error ? error.name : "unknown" });
        await this.ack(message);
      } else {
        await this.retryLater(message, receiveCount, error, log);
      }
    }
  }

  private async retryLater(message: Message, receiveCount: number, error: unknown, log: Logger): Promise<void> {
    const delay = Math.min(this.config.sqs.transientBaseDelaySeconds * 2 ** (receiveCount - 1), MAX_VISIBILITY_SECONDS);
    const exhausted = receiveCount >= this.config.sqs.maxReceiveCount;
    this.telemetry.retry("sqs_message");
    if (exhausted) {
      this.telemetry.deadLettered("retries_exhausted");
    }
    log.warn(exhausted ? "tentativas esgotadas; a fila move a mensagem para a DLQ" : "falha transitória; nova tentativa agendada", {
      receiveCount,
      delaySeconds: delay,
      reason: error instanceof Error ? error.name : "unknown",
    });
    await this.changeVisibility(message, exhausted ? 0 : delay);
  }

  private async deadLetter(message: Message, reason: string): Promise<void> {
    this.telemetry.deadLettered(reason);
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queues.wagerDlq,
        MessageBody: message.Body ?? "",
        MessageGroupId: message.Attributes?.MessageGroupId ?? "dead-letter",
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: { deadLetterReason: { DataType: "String", StringValue: reason } },
      }),
    );
    await this.ack(message);
  }

  private async ack(message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queues.wager, ReceiptHandle: message.ReceiptHandle }));
  }

  private async release(message: Message): Promise<void> {
    await this.changeVisibility(message, 0);
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queues.wager,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: seconds,
        }),
      );
    } catch (error) {
      this.logger.warn("não foi possível alterar a visibilidade da mensagem", {
        sqsMessageId: message.MessageId,
        reason: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}

function classify(error: unknown): Classification {
  if (error instanceof InvalidRequestError || error instanceof DomainError) {
    return "dead_letter";
  }
  if (error instanceof IdempotencyConflictError || error instanceof WalletNotFoundError) {
    return "terminal";
  }
  return "retry";
}
