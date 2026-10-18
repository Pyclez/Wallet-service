import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Controller, Get, Header, Inject, Res } from "@nestjs/common";
import type { Registry } from "prom-client";
import type { HttpResponse } from "../http/http-types";
import type { QueueUrls } from "../messaging/infrastructure/sqs";
import { METRICS_REGISTRY, QUEUE_URLS } from "../tokens";

const CHECK_TIMEOUT_MS = 2_000;

async function probe(check: () => Promise<unknown>): Promise<"up" | "down"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), CHECK_TIMEOUT_MS);
      }),
    ]);
    return "up";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

@Controller()
export class HealthController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(QUEUE_URLS) private readonly queues: QueueUrls,
    @Inject(METRICS_REGISTRY) private readonly registry: Registry,
  ) {}

  @Get("health/live")
  live() {
    return { status: "ok" };
  }

  @Get("health/ready")
  async ready(@Res({ passthrough: true }) response: HttpResponse) {
    const [postgres, sqs] = await Promise.all([
      probe(() => this.orm.em.fork().execute("select 1")),
      probe(() =>
        this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: this.queues.wager, AttributeNames: ["QueueArn"] })),
      ),
    ]);
    const ready = postgres === "up" && sqs === "up";
    response.status(ready ? 200 : 503);
    return { status: ready ? "ok" : "unavailable", checks: { postgres, sqs } };
  }

  @Get("metrics")
  @Header("Content-Type", "text/plain; version=0.0.4")
  metrics() {
    return this.registry.metrics();
  }
}
