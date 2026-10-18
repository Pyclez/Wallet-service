# Arquitetura

## Visão geral

O serviço tem três entradas (HTTP, fila `wager-transactions.fifo` e o worker de referências pendentes) que convergem para o mesmo use case, `ProcessWagerTransaction`, e uma saída assíncrona (outbox → `wallet-events.fifo`).

```
HTTP ─┐
      ├─> ProcessWagerTransaction ──> [ lock da wallet │ idempotência │ regras │ ledger │ outbox │ inbox ] ──> COMMIT
SQS ──┘                                                     uma transação SQL
Worker de PENDING_REFERENCE ──> WagerTransactionSettler (mesmas regras, mesma transação)
Publisher da outbox ──> wallet-events.fifo (depois do commit)
```

### Camadas

| Camada | Conteúdo | Depende de |
|---|---|---|
| `domain` | `Money`, `Wallet`, `WalletLedgerEntry`, `WagerTransaction`, `WagerSettlement`, eventos, `InboxMessage`, `OutboxMessage` | nada (nem ORM, nem Nest) |
| `application` | use cases e portas (`UnitOfWork`, repositórios, `EventPublisher`, `Clock`, `IdGenerator`, `Logger`, `Telemetry`) | domínio |
| `infrastructure` | MikroORM, SQS, controllers Nest, workers, pino, prom-client | aplicação e domínio |

Cada contexto tem seu módulo Nest (`WalletModule`, `WageringModule`, `MessagingModule`, `ObservabilityModule`) sobre um `CoreModule` global com a infraestrutura compartilhada (banco, SQS, logs, métricas) e as portas. Os use cases são classes simples instanciadas por factories, sem decorators; só os adaptadores (controllers, workers, filtro de erros) conhecem o Nest.

As regras de negócio ficam em `WagerSettlement`, uma função de domínio que recebe a wallet travada, a transação e a referência resolvida, decide o resultado e aplica na wallet e na transação. O use case cuida de lock, leitura e gravação. Isso deixa todas as regras testáveis sem banco (`test/unit/wager-settlement.test.ts`).

## Money

- `decimal.js` numa instância isolada (`Decimal.clone`), nunca `number`.
- Entrada e saída como string com 2 casas. Aceita `"25"`, `"25.5"` e `"25.00"`; recusa mais de 2 casas, sinal, notação científica, `NaN`, `Infinity`, string vazia e valores do tipo `number`.
- **Não há arredondamento**: valor com 3 casas é erro, não é arredondado. Arredondar em silêncio cria ou some com centavos.
- Limite de 17 dígitos inteiros, o mesmo do `NUMERIC(19,2)`: o que passa no domínio sempre cabe na coluna.
- `Money.from` (contrato de entrada) não aceita negativo, mas `subtract`/`negate` podem produzir negativo. Quem decide se um resultado negativo é permitido é a `Wallet`; a reconciliação precisa de diferenças negativas.
- Persistência: valor em `numeric(19,2)` e moeda em `char(3)`, em colunas separadas. O driver `pg` devolve `numeric` como string, que vai direto para `Money.from` na reidratação.

## Persistência

**Por que MikroORM e não TypeORM.** As duas opções resolveriam o problema; a escolha foi pelo que o MikroORM oferece de forma explícita e que este serviço usa diretamente:

- **um `EntityManager` por transação** (`fork()` + `transactional()`), com commit e rollback em um único ponto, em vez de um `QueryRunner` controlado à mão em cada caso de uso;
- **`LockMode` tipado** (`PESSIMISTIC_WRITE`, `PESSIMISTIC_READ` e `PESSIMISTIC_PARTIAL_WRITE`, que vira `FOR UPDATE SKIP LOCKED`), usados no lock da wallet, na reconciliação e no worker de referências pendentes, além de `em.execute` para o SQL específico da reserva da outbox;
- **`EntitySchema`** como forma de mapeamento de primeira classe, o que mantém o domínio livre de decorators. No TypeORM o caminho principal são decorators na própria entidade;
- **v7 sem knex e com ESM nativo**, sem atrito com Bun.

**MikroORM 7** com `EntitySchema` (sem decorators). Os registros de persistência (`WalletRecord` etc.) são separados do domínio; os mappers convertem com `rehydrate`, que não revalida transições.

A escrita usa operações nativas do `EntityManager` (`insert`, `nativeUpdate`) dentro de `em.fork().transactional()`, e não o change tracking automático da Unit of Work. Motivos:

- o aggregate de domínio não é a entidade gerenciada; copiar estado para entidades gerenciadas só para o flush calcular o diff não acrescenta garantia;
- a ordem das escritas importa para as constraints (transação → lançamento → saldo) e fica explícita no código;
- a atualização do saldo é condicionada à version lida (`where id = ? and version = ?`), o que um flush genérico esconderia.

O que a Unit of Work oferece de essencial continua sendo usado: um `EntityManager` por transação (fork), `transactional()` com commit/rollback, `LockMode.PESSIMISTIC_WRITE`, `PESSIMISTIC_READ` e `PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`).

Erros do banco são traduzidos na `MikroOrmUnitOfWork` pelo SQLSTATE, e não pela classe de exceção, porque erros de constraints verificadas no commit chegam crus do driver:

| SQLSTATE | Vira |
|---|---|
| `23505` | `UniqueViolationError` (com o nome da constraint) |
| `40001`, `40P01`, `55P03`, `57014`, `57P0x`, `53300`, `08xxx`, erros de rede | `TransientInfrastructureError` |

## Garantias no schema

A migration é escrita à mão porque o gerador do ORM não produz CHECKs compostos, índices parciais nem triggers. Tudo abaixo vale mesmo que a aplicação tenha um bug:

| Garantia | Como |
|---|---|
| Saldo nunca negativo | `CHECK (balance >= 0)` em `wallets` e `CHECK (balance_before >= 0 and balance_after >= 0)` no ledger |
| Uma wallet por player e moeda | `UNIQUE (player_id, currency)` |
| Toda mudança de saldo tem lançamento | Trigger de constraint `deferrable initially deferred`: no commit, o novo saldo precisa ter um lançamento com a mesma `wallet_version` e o mesmo `balance_after` |
| Todo lançamento corresponde a uma mudança de saldo | Trigger deferido: a transação do lançamento precisa estar `PROCESSED`, mover saldo e ter o mesmo valor e moeda; a wallet precisa ter chegado àquela version |
| Lost update é impossível | Cada lançamento grava a `wallet_version` resultante, com `UNIQUE (wallet_id, wallet_version)`; trigger exige `version = version + 1` em toda mudança de saldo e proíbe mudar version sem mudar saldo |
| Ledger imutável | Trigger bloqueia `UPDATE` e `DELETE` |
| Aritmética do lançamento | `CHECK` por direção: `after = before + amount` (crédito) ou `before - amount` (débito) |
| Moeda do lançamento = moeda da wallet | FK composta `(wallet_id, currency) → wallets (id, currency)` |
| Lançamento pertence à wallet da transação | FK composta `(transaction_id, wallet_id) → wager_transactions (id, wallet_id)` |
| Um lançamento por transação | `UNIQUE (transaction_id)` |
| Idempotência | `UNIQUE (provider_id, external_transaction_id)` e `UNIQUE (idempotency_key)` |
| Uma reversão efetiva por referência | Índice único parcial em `reference_transaction_id` onde `kind in (REFUND, ROLLBACK) and status = PROCESSED` |
| Uma abertura por wallet | Índice único parcial em `wallet_id` onde `kind = OPENING` |
| Estado terminal congelado | Trigger proíbe qualquer `UPDATE` em transação `PROCESSED`, `REJECTED` ou `FAILED`, e mudança de campos de negócio em qualquer estado |
| Consistência de status | `CHECK`s: `failure_code` sse `REJECTED/FAILED`; `processed_at` sse `PROCESSED`; REFUND/ROLLBACK exigem referência e, quando processados, a referência resolvida |
| Dedup do consumidor | `PRIMARY KEY (consumer_name, message_id)` em `inbox_messages` |

A migration é reversível (`bun run migrate:down`), e há teste que desce e sobe de novo.

## Concorrência

**Estratégia: lock pessimista por wallet.** Toda operação que muda saldo começa com `SELECT ... FOR UPDATE` na linha da wallet, dentro da transação, antes de qualquer leitura ou decisão.

Por que pessimista e não otimista:

- Numa hot wallet (várias apostas por segundo do mesmo jogador), optimistic locking gera uma tempestade de conflitos e retries; com o lock, as operações simplesmente entram em fila no Postgres.
- O lock serializa também a checagem de idempotência e de reversão já feita, que precisam ver o estado mais recente.
- O lock mora no banco, então vale para N instâncias sem coordenação extra. É por wallet, nunca global: wallets diferentes processam em paralelo.

Detalhes:

- **Deadlock entre wallets não acontece**: cada transação trava uma única wallet. O worker de referências trava sempre na mesma ordem (wallet, depois a transação pendente com `SKIP LOCKED`).
- **`lock_timeout` de 5 s** por transação (`SET LOCAL`): espera longa vira `TransientInfrastructureError` → HTTP 503 com `Retry-After` ou retry com backoff na fila, nunca espera infinita.
- **Defesa em profundidade**: a version continua sendo conferida no `UPDATE` e pelo `UNIQUE (wallet_id, wallet_version)`. Num experimento removendo o `FOR UPDATE`, os testes de concorrência falham (requisições passam a falhar), mas nenhuma wallet fica com saldo divergente do ledger: o banco recusa a escrita.

Cenário obrigatório (saldo 100.00, duas apostas de 80.00 simultâneas): a segunda transação espera o lock, lê 20.00 já commitado e sai `REJECTED / INSUFFICIENT_FUNDS`. O teste repete o cenário 20 vezes, distribuído entre 3 processos.

## Idempotência

- O header `Idempotency-Key` é obrigatório e é a fonte da verdade. Na fila, o campo `idempotencyKey` da mensagem cumpre o mesmo papel.
- **payloadHash** = SHA-256 (hex) do JSON canônico dos campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId`. Chaves ordenadas por code unit, sem espaços, campos ausentes omitidos, `amount` normalizado para 2 casas (`"25"` e `"25.00"` são o mesmo payload). A chave e metadados de transporte não entram.
- Depois de travar a wallet, o use case procura transações com a mesma chave **ou** o mesmo `(providerId, externalTransactionId)`:
  - mesma chave, mesmo par externo e mesmo hash → replay: devolve o resultado gravado, incluindo o saldo observado na época (`balance_after`), com `idempotentReplay: true`;
  - qualquer outra combinação → `409 IDEMPOTENCY_CONFLICT`. Isso inclui usar uma chave diferente do padrão para um par externo já visto.
- O saldo do replay vem de `balance_after`, gravado em toda transação decidida (inclusive LOSS e REJECTED, que não têm lançamento de onde tirar o saldo).
- **Corrida entre wallets diferentes com a mesma chave**: os dois requests travam wallets distintas, então o lock não os serializa. O segundo `INSERT` viola o `UNIQUE`, o use case refaz a operação (até 3 tentativas), encontra a transação gravada e responde 409.
- Replay de uma transação rejeitada devolve 422 de novo; replay de uma pendente devolve 202 com o estado atual.

## Regras de negócio e interpretações

| Operação | Efeito | Ledger | Referência |
|---|---|---|---|
| BET | débito | DEBIT | não aceita |
| WIN | crédito | CREDIT | opcional, só BET |
| LOSS | nenhum (valor pode ser 0.00) | nenhum | opcional, só BET |
| REFUND | crédito | CREDIT | obrigatória, só BET, mesmo valor |
| ROLLBACK | inverso da referência | invertido | obrigatória, BET, WIN ou REFUND, mesmo valor |

Transições de `WagerTransaction`:

```
PENDING            → PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
PENDING_REFERENCE  → PENDING_REFERENCE (nova tentativa) | PROCESSED | REJECTED | FAILED
PROCESSED, REJECTED, FAILED → nenhuma (terminal; tentar é erro de programação)
```

`PENDING` só existe em memória durante a decisão; a transação é gravada já no estado decidido.

Interpretações do enunciado:

1. **Uma reversão efetiva por referência, não uma por tipo.** "Não pode ser revertida duas vezes pelo mesmo tipo" permitiria REFUND e depois ROLLBACK da mesma BET, creditando duas vezes. A regra adotada impede qualquer segunda reversão `PROCESSED` da mesma referência (`REFERENCE_ALREADY_REVERSED`), garantida também pelo índice único parcial.
2. **A abertura não incrementa a version.** O exemplo da API mostra `version: 1` com saldo de 1000.00; o crédito de abertura entra na própria version 1.
3. **Referência que ainda está pendente conta como ausente.** Um ROLLBACK de um REFUND que espera a BET também espera.
4. **WIN de uma BET rejeitada é rejeitado** (`REFERENCE_NOT_PROCESSED`): não se paga prêmio de aposta que não foi debitada.
5. **Reversão que deixaria saldo negativo** (ROLLBACK de WIN ou REFUND depois de o jogador gastar o valor) é rejeitada com `REVERSAL_INSUFFICIENT_FUNDS`, distinto de `INSUFFICIENT_FUNDS`, e fica auditável.
6. **Moeda ou player diferentes da wallet** geram transação `REJECTED` gravada (auditável e com replay estável), não erro 400.
7. **Wallet inexistente** não gera transação gravada (a FK impede) e responde 404; na fila, a mensagem é confirmada com log de aviso. Reenviar dá o mesmo resultado enquanto a wallet não existir.
8. **ROLLBACK de ROLLBACK** não é permitido (`INVALID_REFERENCE_KIND`).

## Códigos de falha

| `failureCode` | Situação | O que o provedor deve fazer |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | Desistir; reenviar a mesma transação dá o mesmo resultado |
| `REVERSAL_INSUFFICIENT_FUNDS` | Reversão deixaria saldo negativo | Tratamento operacional (não é igual a aposta sem saldo) |
| `CURRENCY_MISMATCH` | Moeda diferente da wallet | Corrigir e enviar com outro `externalTransactionId` |
| `PLAYER_MISMATCH` | Player não é dono da wallet | Corrigir e enviar com outro `externalTransactionId` |
| `REFERENCE_NOT_FOUND` | Referência não chegou dentro da janela de retry | Investigar; desistir |
| `REFERENCE_NOT_PROCESSED` | Referência existe mas foi rejeitada ou falhou | Desistir |
| `REFERENCE_MISMATCH` | Referência de outro provider, player, wallet, moeda ou rodada | Corrigir a referência |
| `INVALID_REFERENCE_KIND` | Tipo de referência não permitido | Corrigir a referência |
| `REFERENCE_ALREADY_REVERSED` | Referência já tem reversão processada | Desistir (já foi revertida) |
| `REVERSAL_AMOUNT_MISMATCH` | Valor diferente da referência | Corrigir o valor |
| `PROCESSING_FAILED` | Erro permanente ao reprocessar uma pendente (status `FAILED`) | Contato operacional |

## Status HTTP

Mesmo critério em todos os endpoints. O corpo de erro é sempre `{ "error": { "code", "message", "details?" } }`.

| Situação | Status |
|---|---|
| Criado / processado agora | 201 |
| Replay de processada, consultas | 200 |
| Aceito, aguardando referência | 202 |
| Payload inválido, header ausente, id malformado, cursor inválido | 400 |
| Recurso inexistente | 404 |
| Conflito de idempotência, wallet duplicada | 409 |
| Rejeição de negócio (com `failureCode`), inclusive no replay | 422 |
| Erro inesperado | 500 |
| Falha transitória (lock timeout, deadlock, banco fora) | 503 + `Retry-After` |

Com isso o provedor decide sem ler mensagem: 503 pode reenviar igual; 409 e 400 exigem correção; 422 é resposta definitiva; 202 é aguardar.

## Referências fora de ordem

- REFUND, ROLLBACK (ou WIN/LOSS com referência) cuja referência ainda não existe ficam `PENDING_REFERENCE`, sem mexer no saldo, e publicam `WagerTransactionPendingReference`.
- Na fila, a mensagem é confirmada depois de gravar: o reprocessamento sai do banco, não da fila, o que evita prender o grupo FIFO da wallet.
- O worker roda a cada 500 ms em toda instância, pega as pendentes vencidas, trava a wallet e a transação (`FOR UPDATE SKIP LOCKED`) e reaplica as mesmas regras.
- **Backoff exponencial**: 1 s, 2 s, 4 s, ... até 60 s, por no máximo 10 novas tentativas (cerca de 5 minutos no total). Entrega fora de ordem costuma se resolver em segundos; 5 minutos cobrem redeliveries e reinícios sem deixar o provedor sem resposta definitiva. Tudo configurável por variável de ambiente.
- Esgotado o limite: `REJECTED / REFERENCE_NOT_FOUND` e evento `WagerTransactionRejected`.

## Consumidor SQS

- Mesmo use case da entrada HTTP, com o contexto de inbox `(consumerName, messageId)`.
- **Inbox na mesma transação**: a linha em `inbox_messages` é gravada junto com a transação, o lançamento, o saldo e a outbox. Mensagem já vista vira replay e é confirmada.
- **Ack só depois do commit**: `DeleteMessage` acontece depois que o use case retorna. Se o processo morrer entre os dois, a mensagem volta após o visibility timeout e o inbox evita o efeito duplicado (há teste com o processo encerrado exatamente nesse ponto).
- **Ordenação**: mensagens do mesmo `MessageGroupId` (a wallet) são processadas em sequência dentro do lote; grupos diferentes em paralelo. É otimização: a correção vem do lock e das constraints.

| Erro | Classificação | Ação |
|---|---|---|
| JSON malformado, envelope inválido, payload que viola o domínio (ex.: `OPENING`) | permanente | Envia para a DLQ com o motivo em `deadLetterReason` e confirma |
| Conflito de idempotência, wallet inexistente | negócio, terminal | Confirma e registra aviso |
| Rejeição de negócio | resultado normal | Transação `REJECTED` gravada e confirmada |
| Transitório (lock, banco, rede) ou inesperado | retry | `ChangeMessageVisibility` com backoff de 2 s × 2^(n−1) até 900 s; depois de `maxReceiveCount = 5` recebimentos a redrive policy move para a DLQ |

**SIGTERM**: `enableShutdownHooks` dispara o encerramento. O consumidor para de receber (o long poll em andamento é abortado), termina as mensagens que já começou e devolve visibilidade 0 às que recebeu mas não começou. Se passar de `SHUTDOWN_TIMEOUT_MS`, as que estiverem em voo voltam sozinhas pelo visibility timeout. Os workers de outbox e referências terminam o ciclo atual. O banco fecha por último.

## Transactional Outbox

- Os eventos são gravados em `outbox_messages` na mesma transação da operação financeira: ou tudo é confirmado junto, ou nada. Há dois testes que forçam falha na gravação da outbox: um pela API (transação, lançamento e saldo não são gravados) e outro pela fila, em que a linha do inbox também é desfeita e a mensagem volta e é processada uma única vez.
- **Publisher com lease**: cada instância reserva um lote com `UPDATE ... SET locked_until = now() + lease WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING`. A reserva é uma transação curta; a chamada ao SQS acontece fora dela, sem segurar conexão.
- Publicou → marca `published_at`. Falhou → `attempts + 1` e `next_attempt_at` com backoff de 1 s a 60 s.
- **Processo morre depois do commit e antes de publicar**: o evento continua pendente e outra instância publica. **Morre depois de publicar e antes de marcar**: o lease expira e outra instância publica de novo. Por isso a entrega é *at-least-once*, e o consumidor do evento deve deduplicar por `eventId`. A fila FIFO recebe `MessageDeduplicationId = eventId` e `MessageGroupId = walletId`, o que elimina duplicatas dentro da janela de 5 minutos do SQS, mas isso é otimização e não garantia.
- Fila de destino: `wallet-events.fifo` (o enunciado não define uma).

| Evento | Quando | aggregateId |
|---|---|---|
| `WagerTransactionProcessed` | Qualquer transação aplicada, inclusive LOSS e OPENING | id da transação |
| `WagerTransactionRejected` | Rejeição de negócio, inclusive por referência não encontrada | id da transação |
| `WalletBalanceChanged` | Somente quando o saldo muda | id da wallet |
| `WagerTransactionPendingReference` | Primeira vez que a transação fica aguardando referência | id da transação |

Envelope: `eventId`, `eventType`, `aggregateId`, `correlationId`, `causationId` (messageId da fila, quando houver), `occurredAt` (ISO-8601), `version` e `data`, sempre com `MoneyProps` (string decimal), nunca a instância de `Money`.

## Reconciliação

`POST /wallets/:id/reconciliation` trava a wallet com `FOR SHARE` (as escritas esperam, as leituras não), soma o ledger no SQL e compara. Divergência não é corrigida: é logada como erro, incrementa `wallet_reconciliation_divergences_total` e volta com `consistent: false` e a diferença.

## Observabilidade

- **Logs** JSON (pino) com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, status e `failureCode`. Valores, saldos e payloads não são logados; há redaction como segunda proteção. O `correlationId` vem do header `x-correlation-id` (ou é gerado) e volta na resposta.
- **Métricas** em `/metrics`:

| Métrica | O que mede |
|---|---|
| `wallet_wager_transactions_total{status,source}` | Transações por status final e origem |
| `wallet_wager_processing_duration_seconds{source}` | Latência de processamento |
| `wallet_duplicates_detected_total{source,mechanism}` | Replays por chave de idempotência ou inbox |
| `wallet_idempotency_conflicts_total{source}` | Mesma chave com payload diferente |
| `wallet_retries_total{reason}` | Retries de fila, outbox, referência e corrida de unicidade |
| `wallet_lock_conflicts_total{kind}` | Lock timeout, deadlock, serialização |
| `wallet_dlq_messages_total{reason}` | Mensagens enviadas ou destinadas à DLQ |
| `wallet_outbox_lag_seconds` | Idade do evento mais antigo não publicado |
| `wallet_outbox_published_total` | Eventos publicados |
| `wallet_reconciliation_divergences_total` | Reconciliações divergentes |

- **Health**: `/health/live` (processo) e `/health/ready` (Postgres e SQS, com timeout de 2 s cada; 503 se algum falhar).

## Autenticação

Não implementada: vale zero pontos e competiria com as garantias financeiras. O ponto de extensão é o `ProviderAuthGuard`, hoje no-op, aplicado às rotas de wallets e de transações; health e métricas ficam abertos, e a fila é tratada como canal interno confiável.

Desenho que seria adotado:

- **Keycloak** com um client por provedor, fluxo *client credentials*.
- O guard valida o JWT pela JWKS do realm (assinatura, `iss`, `aud`, expiração) e extrai o `providerId` de uma claim.
- Regra de autorização: o `providerId` do token precisa ser igual ao do payload; operações de wallet ficam restritas a um papel administrativo.
- A identidade do provedor nas mensagens da fila continua sujeita às mesmas validações de domínio (referência do mesmo provider etc.).

## Testes

- **Unidade**: domínio puro, sem banco.
- **Integração**: Postgres e MiniStack reais. Cada arquivo cria seu banco e filas com sufixo único.
- **Concorrência**: três processos reais da aplicação (`Bun.spawn`) recebendo requisições em paralelo, e três consumidores SQS recebendo mensagens da mesma wallet em grupos FIFO diferentes, com duplicatas, para mostrar que a correção não depende da ordenação da fila.
- **Falhas**: lock segurado pelo próprio teste (falha transitória real), processo encerrado depois do commit e antes do ack, `SIGKILL` no meio de um lote, `SIGTERM`, lease de outbox abandonado, trigger temporário para quebrar a outbox no meio da transação.
- O código de produção não tem injeção de falha. O consumidor expõe um ponto de extensão opcional, `AFTER_COMMIT_HOOK`, chamado depois do commit e antes do ack e vazio em produção; o teste de crash sobe a aplicação por uma entrada própria (`test/support/crash-after-commit.ts`) que registra um hook encerrando o processo nesse ponto.
- Todo arquivo termina verificando, no SQL, que o saldo de cada wallet é igual à soma do ledger e que a version é a do último lançamento.

## Limitações e próximos passos

- **Um consumidor de eventos** para `wallet-events.fifo` não faz parte do serviço; o contrato é deduplicar por `eventId`.
- **Limpeza da outbox e da inbox**: as linhas publicadas/processadas ficam para sempre; em produção haveria um job de retenção.
- **Hot wallet extrema**: o lock serializa as operações de uma wallet. Para volumes muito acima do comum, o próximo passo seria agrupar operações da mesma wallet numa única transação.
- **Moeda**: o modelo é multi-moeda e os conflitos são testados, mas os cenários rodam em BRL.
- **MiniStack x SQS real**: o emulador foi suficiente para FIFO, deduplicação, visibilidade e redrive. Contra a AWS, basta não definir `SQS_ENDPOINT` e criar as filas pela infraestrutura (`SQS_CREATE_QUEUES=false`).
- **Windows**: o teste de SIGTERM é ignorado no Windows, que não entrega sinais POSIX para o processo filho.
- **OpenTelemetry e dashboard** não foram feitos (opcionais).
