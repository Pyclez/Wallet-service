import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { Telemetry, type ProcessingSource } from "../shared/application/ports";

export function createMetricsRegistry(): Registry {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "wallet_process_" });
  return registry;
}

export class PrometheusTelemetry extends Telemetry {
  private readonly transactions: Counter<"status" | "source">;
  private readonly processingDuration: Histogram<"source">;
  private readonly duplicates: Counter<"source" | "mechanism">;
  private readonly conflicts: Counter<"source">;
  private readonly retries: Counter<"reason">;
  private readonly lockConflicts: Counter<"kind">;
  private readonly deadLetters: Counter<"reason">;
  private readonly divergences: Counter;
  private readonly published: Counter;

  constructor(registry: Registry) {
    super();
    const registers = [registry];
    this.transactions = new Counter({
      name: "wallet_wager_transactions_total",
      help: "Transações de aposta por status final e origem",
      labelNames: ["status", "source"],
      registers,
    });
    this.processingDuration = new Histogram({
      name: "wallet_wager_processing_duration_seconds",
      help: "Latência de processamento de uma transação",
      labelNames: ["source"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers,
    });
    this.duplicates = new Counter({
      name: "wallet_duplicates_detected_total",
      help: "Requisições ou mensagens repetidas respondidas como replay",
      labelNames: ["source", "mechanism"],
      registers,
    });
    this.conflicts = new Counter({
      name: "wallet_idempotency_conflicts_total",
      help: "Mesma chave de idempotência com payload diferente",
      labelNames: ["source"],
      registers,
    });
    this.retries = new Counter({
      name: "wallet_retries_total",
      help: "Novas tentativas por motivo",
      labelNames: ["reason"],
      registers,
    });
    this.lockConflicts = new Counter({
      name: "wallet_lock_conflicts_total",
      help: "Lock timeout, deadlock e falhas de serialização",
      labelNames: ["kind"],
      registers,
    });
    this.deadLetters = new Counter({
      name: "wallet_dlq_messages_total",
      help: "Mensagens enviadas ou destinadas à DLQ",
      labelNames: ["reason"],
      registers,
    });
    this.divergences = new Counter({
      name: "wallet_reconciliation_divergences_total",
      help: "Reconciliações em que saldo e ledger não bateram",
      registers,
    });
    this.published = new Counter({
      name: "wallet_outbox_published_total",
      help: "Eventos publicados a partir da outbox",
      registers,
    });
  }

  transactionSettled(status: string, source: ProcessingSource, durationSeconds: number): void {
    this.transactions.inc({ status, source });
    if (durationSeconds > 0) {
      this.processingDuration.observe({ source }, durationSeconds);
    }
  }

  duplicateDetected(source: ProcessingSource, mechanism: "idempotency_key" | "inbox"): void {
    this.duplicates.inc({ source, mechanism });
  }

  idempotencyConflict(source: ProcessingSource): void {
    this.conflicts.inc({ source });
  }

  retry(reason: string): void {
    this.retries.inc({ reason });
  }

  lockConflict(kind: string): void {
    this.lockConflicts.inc({ kind });
  }

  deadLettered(reason: string): void {
    this.deadLetters.inc({ reason });
  }

  reconciliationDivergence(): void {
    this.divergences.inc();
  }

  outboxPublished(count: number): void {
    this.published.inc(count);
  }
}

export function registerOutboxLagGauge(registry: Registry, probe: () => Promise<number>): void {
  new Gauge({
    name: "wallet_outbox_lag_seconds",
    help: "Idade do evento mais antigo ainda não publicado",
    registers: [registry],
    async collect() {
      try {
        this.set(await probe());
      } catch {}
    },
  });
}
