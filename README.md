# wallet-service

Serviço de carteira que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) vindas de provedores de jogos, por HTTP e por SQS, com saldo e ledger sempre consistentes mesmo com várias instâncias, mensagens duplicadas e entregas fora de ordem.

Decisões de arquitetura, trade-offs e limitações estão em [ARCHITECTURE.md](./ARCHITECTURE.md).

## Stack

Bun 1.x · TypeScript estrito · NestJS 12 · MikroORM 7 · PostgreSQL 17 · SQS (MiniStack) · Docker Compose

## Requisitos

- Bun 1.x
- Docker com Docker Compose

## Rodando

### Stack completa em containers

```bash
docker compose up --build -d
```

Sobe Postgres, MiniStack, roda as migrations (serviço `migrate`) e inicia a aplicação em `http://localhost:3000`. As filas são criadas pela própria aplicação na inicialização.

Três instâncias atrás das portas 3000, 3001 e 3002:

```bash
docker compose up --build -d --scale app=3
```

### Desenvolvimento local

```bash
docker compose up -d postgres sqs
bun install
bun run migrate
bun run dev
```

## Testes

Os testes de integração usam Postgres e MiniStack reais. Com a infraestrutura de pé (`docker compose up -d postgres sqs`):

```bash
bun test                    # suíte completa (~1 min)
bun run test:unit           # só domínio, não precisa de Docker
bun run test:integration    # integração, concorrência e mensageria
bun run typecheck
```

| Pasta | O que cobre |
|---|---|
| `test/unit` | Money, Wallet, ledger, regras de BET/WIN/LOSS/REFUND/ROLLBACK, conflito de moeda, hash do payload, eventos, inbox e outbox |
| `test/integration` | Constraints e migrations (sobe e desce), API HTTP, status HTTP, reconciliação, atomicidade entre wallet, ledger e outbox |
| `test/concurrency` | 3 processos reais: 50 requisições iguais em paralelo, cenário 100/80/80, hot wallet, wallets distintas em paralelo |
| `test/messaging` | Consumidor SQS, inbox e redelivery, atomicidade com inbox, 3 consumidores na mesma wallet, DLQ, retry com backoff, worker morto após commit e antes do ack, reinício, SIGTERM, referência fora de ordem, publishers concorrentes, lease da outbox |

Cada arquivo cria o próprio banco (`wallet_test_<nome>`) e filas com sufixo único, e termina verificando a invariante `saldo da wallet == saldo reconstruído pelo ledger` para todas as wallets.

## API

| Método | Rota | Descrição |
|---|---|---|
| POST | `/wallets` | Cria wallet (`playerId`, `initialBalance`) |
| GET | `/wallets/:walletId` | Consulta wallet |
| GET | `/wallets/:walletId/ledger?cursor=&limit=50` | Ledger paginado, do mais recente ao mais antigo |
| POST | `/wallets/:walletId/reconciliation` | Compara saldo gravado com o saldo reconstruído pelo ledger |
| POST | `/wagering/transactions` | Submete transação (header `Idempotency-Key` obrigatório) |
| GET | `/wagering/transactions/:transactionId` | Consulta por id interno |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta por id do provedor |
| GET | `/health/live` | Processo vivo |
| GET | `/health/ready` | Postgres e SQS alcançáveis |
| GET | `/metrics` | Métricas Prometheus |

Status HTTP de `POST /wagering/transactions`:

| Situação | Status |
|---|---|
| Processada agora | 201 |
| Replay de transação processada | 200 (`idempotentReplay: true`) |
| Aguardando referência | 202 |
| Payload inválido ou header ausente | 400 |
| Wallet inexistente | 404 |
| Mesma chave com payload diferente | 409 |
| Rejeitada por regra de negócio (inclusive no replay) | 422 com `failureCode` |
| Falha transitória de infraestrutura | 503 com `Retry-After` |

Exemplo:

```bash
curl -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id da wallet>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

## Filas

| Fila | Uso |
|---|---|
| `wager-transactions.fifo` | Entrada de transações (`WagerTransactionRequested`), consumida pelo serviço |
| `wager-transactions-dlq.fifo` | Mensagens inválidas e mensagens que esgotaram as tentativas |
| `wallet-events.fifo` | Eventos publicados pela outbox |

## Configuração

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `DATABASE_URL` | `postgresql://wallet:wallet@localhost:5432/wallet` | Conexão com o Postgres |
| `DATABASE_POOL_SIZE` | `10` | Conexões por instância |
| `LOCK_TIMEOUT_MS` | `5000` | Espera máxima pelo lock da wallet antes de virar falha transitória |
| `SQS_ENDPOINT` | — | Endpoint do MiniStack/LocalStack (vazio usa a AWS) |
| `WAGER_QUEUE_NAME`, `WAGER_DLQ_NAME`, `EVENTS_QUEUE_NAME` | ver tabela de filas | Nomes das filas |
| `SQS_CREATE_QUEUES` | `true` | Cria as filas na inicialização |
| `SQS_MAX_RECEIVE_COUNT` | `5` | Recebimentos antes da DLQ |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | `30` | Visibilidade padrão de uma mensagem recebida |
| `SQS_TRANSIENT_BASE_DELAY_SECONDS` | `2` | Base do backoff de falhas transitórias |
| `WORKERS` | `consumer,outbox,references` | Workers ativos na instância (`none` para só HTTP) |
| `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_BATCH_SIZE`, `OUTBOX_LEASE_MS` | `500`, `50`, `30000` | Publisher da outbox |
| `REFERENCE_RETRY_BASE_MS`, `REFERENCE_RETRY_MAX_MS`, `REFERENCE_RETRY_MAX_ATTEMPTS` | `1000`, `60000`, `10` | Backoff de `PENDING_REFERENCE` |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Espera pelas mensagens em voo no SIGTERM |
| `LOG_LEVEL` | `info` | Nível do log JSON |

## Estrutura

```
src/
  main.ts        Entrada da aplicação (bootstrap.ts monta o Nest)
  core.module.ts Infraestrutura compartilhada: banco, SQS, logs, métricas, portas
  shared/        Money, erros, IntegrationEvent, portas (UnitOfWork, Clock, IdGenerator, Logger, Telemetry)
  wallet/        Wallet, WalletLedgerEntry, abertura, consultas, reconciliação, controller
  wagering/      WagerTransaction, regras de liquidação, idempotência, consumidor SQS, worker de referência
  messaging/     Inbox, Outbox, publisher da outbox
  database/      Schemas do MikroORM, mappers, repositórios, unidade de trabalho, migrations
  observability/ Logs, métricas, health checks
  http/          Validação, mapeamento de erros, correlation id
  auth/          Guard de autenticação (ponto de extensão)
scripts/         migrate.ts
test/            unit, integration, concurrency, messaging
```
