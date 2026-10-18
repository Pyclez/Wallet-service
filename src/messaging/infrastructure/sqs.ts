import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { AppConfig } from "../../config";
import type { Logger } from "../../shared/application/ports";
import { sleep } from "../../shared/infrastructure/system";
import { EventPublisher } from "../application/ports";
import type { OutboxMessage } from "../domain/outbox-message";

export interface QueueUrls {
  wager: string;
  wagerDlq: string;
  events: string;
}

export function createSqsClient(config: AppConfig["sqs"]): SQSClient {
  return new SQSClient({
    region: config.region,
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
}

export async function prepareQueues(
  sqs: SQSClient,
  config: AppConfig["sqs"],
  logger: Logger,
  attempts = 30,
): Promise<QueueUrls> {
  for (let attempt = 1; ; attempt++) {
    try {
      return config.createQueues ? await createQueues(sqs, config) : await resolveQueues(sqs, config);
    } catch (error) {
      if (attempt >= attempts) {
        throw error;
      }
      logger.warn("SQS indisponível, tentando de novo", { attempt });
      await sleep(1_000);
    }
  }
}

async function createQueues(sqs: SQSClient, config: AppConfig["sqs"]): Promise<QueueUrls> {
  const fifo = { FifoQueue: "true" };
  const wagerDlq = await sqs.send(new CreateQueueCommand({ QueueName: config.wagerDlqName, Attributes: fifo }));
  const dlqArn = await queueArn(sqs, wagerDlq.QueueUrl!);
  const wager = await sqs.send(
    new CreateQueueCommand({
      QueueName: config.wagerQueueName,
      Attributes: {
        ...fifo,
        VisibilityTimeout: String(config.visibilityTimeoutSeconds),
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: config.maxReceiveCount }),
      },
    }),
  );
  const events = await sqs.send(new CreateQueueCommand({ QueueName: config.eventsQueueName, Attributes: fifo }));
  return { wager: wager.QueueUrl!, wagerDlq: wagerDlq.QueueUrl!, events: events.QueueUrl! };
}

async function resolveQueues(sqs: SQSClient, config: AppConfig["sqs"]): Promise<QueueUrls> {
  const url = async (name: string) => (await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
  return {
    wager: await url(config.wagerQueueName),
    wagerDlq: await url(config.wagerDlqName),
    events: await url(config.eventsQueueName),
  };
}

async function queueArn(sqs: SQSClient, queueUrl: string): Promise<string> {
  const result = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }));
  return result.Attributes!.QueueArn!;
}

export class SqsEventPublisher extends EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {
    super();
  }

  async publish(message: OutboxMessage): Promise<void> {
    const data = message.payload.data as Record<string, unknown> | undefined;
    const groupId = typeof data?.walletId === "string" ? data.walletId : message.aggregateId;
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: groupId,
        MessageDeduplicationId: message.id,
      }),
    );
  }
}
