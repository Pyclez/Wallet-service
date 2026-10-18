import { Migration } from "@mikro-orm/migrations";

export class Migration001InitialSchema extends Migration {
  override name = "Migration001InitialSchema";

  override up(): void {
    this.addSql(`
      create function forbid_mutation() returns trigger language plpgsql as $$
      begin
        raise exception '% em % não é permitido (registro imutável)', tg_op, tg_table_name;
      end;
      $$;
    `);

    this.addSql(`
      create table wallets (
        id          uuid primary key,
        player_id   uuid          not null,
        currency    char(3)       not null,
        balance     numeric(19,2) not null,
        version     integer       not null,
        created_at  timestamptz   not null default now(),
        updated_at  timestamptz   not null default now(),
        constraint wallets_player_currency_uq   unique (player_id, currency),
        constraint wallets_id_currency_uq       unique (id, currency),
        constraint wallets_currency_ck          check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_balance_non_negative check (balance >= 0),
        constraint wallets_version_ck           check (version >= 1)
      );
    `);

    this.addSql(`
      create function wallets_guard_update() returns trigger language plpgsql as $$
      begin
        if (new.id, new.player_id, new.currency, new.created_at)
           is distinct from (old.id, old.player_id, old.currency, old.created_at) then
          raise exception 'wallets: id, player_id, currency e created_at são imutáveis';
        end if;
        if new.balance <> old.balance and new.version <> old.version + 1 then
          raise exception 'wallets: mudança de saldo exige version = % (recebido %)',
            old.version + 1, new.version;
        end if;
        if new.balance = old.balance and new.version <> old.version then
          raise exception 'wallets: version só muda quando o saldo muda';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger wallets_guard_update before update on wallets
        for each row execute function wallets_guard_update();
    `);
    this.addSql(`
      create trigger wallets_no_delete before delete on wallets
        for each row execute function forbid_mutation();
    `);

    this.addSql(`
      create table wager_transactions (
        id                                uuid primary key,
        provider_id                       varchar(64)   not null,
        external_transaction_id           varchar(128)  not null,
        idempotency_key                   varchar(255)  not null,
        payload_hash                      char(64)      not null,
        wallet_id                         uuid          not null references wallets (id),
        player_id                         uuid          not null,
        round_id                          varchar(128)  not null,
        game_id                           varchar(128)  not null,
        kind                              varchar(16)   not null,
        amount                            numeric(19,2) not null,
        currency                          char(3)       not null,
        reference_external_transaction_id varchar(128),
        reference_transaction_id          uuid references wager_transactions (id),
        status                            varchar(24)   not null,
        failure_code                      varchar(64),
        balance_after                     numeric(19,2),
        reference_attempts                integer       not null default 0,
        next_attempt_at                   timestamptz,
        created_at                        timestamptz   not null default now(),
        updated_at                        timestamptz   not null default now(),
        processed_at                      timestamptz,
        constraint wager_tx_provider_external_uq unique (provider_id, external_transaction_id),
        constraint wager_tx_idempotency_key_uq   unique (idempotency_key),
        constraint wager_tx_id_wallet_uq         unique (id, wallet_id),
        constraint wager_tx_kind_ck check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        constraint wager_tx_status_ck check (
          status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        constraint wager_tx_currency_ck check (currency ~ '^[A-Z]{3}$'),
        constraint wager_tx_amount_ck check (amount > 0 or (kind = 'LOSS' and amount >= 0)),
        constraint wager_tx_reference_required_ck check (
          kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_tx_reversal_resolved_ck check (
          status <> 'PROCESSED' or kind not in ('REFUND','ROLLBACK') or reference_transaction_id is not null),
        constraint wager_tx_failure_code_ck check (
          (status in ('REJECTED','FAILED')) = (failure_code is not null)),
        constraint wager_tx_processed_at_ck check ((status = 'PROCESSED') = (processed_at is not null)),
        constraint wager_tx_balance_after_ck check (
          (balance_after is null or balance_after >= 0)
          and (status <> 'PROCESSED' or balance_after is not null)),
        constraint wager_tx_reference_attempts_ck check (reference_attempts >= 0)
      );
    `);

    this.addSql(`
      create unique index wager_tx_single_reversal_uq on wager_transactions (reference_transaction_id)
        where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED';
    `);
    this.addSql(`
      create unique index wager_tx_single_opening_uq on wager_transactions (wallet_id)
        where kind = 'OPENING';
    `);
    this.addSql(`
      create index wager_tx_pending_reference_due_idx on wager_transactions (next_attempt_at)
        where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      create index wager_tx_waiting_reference_idx
        on wager_transactions (provider_id, reference_external_transaction_id)
        where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`create index wager_tx_wallet_idx on wager_transactions (wallet_id, created_at);`);

    this.addSql(`
      create function wager_transactions_guard_update() returns trigger language plpgsql as $$
      begin
        if old.status in ('PROCESSED','REJECTED','FAILED') then
          raise exception 'wager_transactions: transação % está em estado terminal (%)', old.id, old.status;
        end if;
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
            new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
            old.reference_external_transaction_id, old.created_at) then
          raise exception 'wager_transactions: campos de negócio são imutáveis';
        end if;
        if new.status = 'PENDING' and old.status <> 'PENDING' then
          raise exception 'wager_transactions: transição inválida % -> PENDING', old.status;
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger wager_transactions_guard_update before update on wager_transactions
        for each row execute function wager_transactions_guard_update();
    `);
    this.addSql(`
      create trigger wager_transactions_no_delete before delete on wager_transactions
        for each row execute function forbid_mutation();
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id             uuid primary key,
        wallet_id      uuid          not null,
        transaction_id uuid          not null,
        direction      varchar(6)    not null,
        amount         numeric(19,2) not null,
        currency       char(3)       not null,
        balance_before numeric(19,2) not null,
        balance_after  numeric(19,2) not null,
        wallet_version integer       not null,
        created_at     timestamptz   not null default now(),
        constraint ledger_wallet_fk foreign key (wallet_id, currency) references wallets (id, currency),
        constraint ledger_transaction_fk foreign key (transaction_id, wallet_id)
          references wager_transactions (id, wallet_id),
        constraint ledger_transaction_uq    unique (transaction_id),
        constraint ledger_wallet_version_uq unique (wallet_id, wallet_version),
        constraint ledger_direction_ck      check (direction in ('DEBIT','CREDIT')),
        constraint ledger_amount_positive   check (amount > 0),
        constraint ledger_balances_non_negative check (balance_before >= 0 and balance_after >= 0),
        constraint ledger_version_ck        check (wallet_version >= 1),
        constraint ledger_arithmetic_ck     check (
          (direction = 'CREDIT' and balance_after = balance_before + amount)
          or (direction = 'DEBIT' and balance_after = balance_before - amount))
      );
    `);
    this.addSql(`
      create trigger ledger_append_only before update or delete on wallet_ledger_entries
        for each row execute function forbid_mutation();
    `);

    this.addSql(`
      create function ledger_entry_consistency() returns trigger language plpgsql as $$
      begin
        if not exists (
          select 1 from wager_transactions t
           where t.id = new.transaction_id
             and t.status = 'PROCESSED'
             and t.kind <> 'LOSS'
             and t.amount = new.amount
             and t.currency = new.currency
        ) then
          raise exception 'ledger: transação % precisa estar PROCESSED, mover saldo e ter o mesmo valor',
            new.transaction_id;
        end if;
        if not exists (
          select 1 from wallets w where w.id = new.wallet_id and w.version >= new.wallet_version
        ) then
          raise exception 'ledger: lançamento na version % sem alteração correspondente na wallet %',
            new.wallet_version, new.wallet_id;
        end if;
        return null;
      end;
      $$;
    `);
    this.addSql(`
      create constraint trigger ledger_entry_consistency after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function ledger_entry_consistency();
    `);

    this.addSql(`
      create function wallets_require_ledger_entry() returns trigger language plpgsql as $$
      begin
        if tg_op = 'INSERT' and new.balance = 0 then
          return null;
        end if;
        if tg_op = 'UPDATE' and new.balance = old.balance then
          return null;
        end if;
        if not exists (
          select 1 from wallet_ledger_entries e
           where e.wallet_id = new.id
             and e.wallet_version = new.version
             and e.balance_after = new.balance
        ) then
          raise exception 'wallets: saldo % (version %) da wallet % sem lançamento no ledger',
            new.balance, new.version, new.id;
        end if;
        return null;
      end;
      $$;
    `);
    this.addSql(`
      create constraint trigger wallets_require_ledger_entry after insert or update on wallets
        deferrable initially deferred
        for each row execute function wallets_require_ledger_entry();
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name varchar(64)  not null,
        message_id    varchar(128) not null,
        payload_hash  char(64)     not null,
        received_at   timestamptz  not null default now(),
        processed_at  timestamptz,
        constraint inbox_messages_pk primary key (consumer_name, message_id)
      );
    `);

    this.addSql(`
      create table outbox_messages (
        id              uuid primary key,
        aggregate_id    uuid         not null,
        event_type      varchar(64)  not null,
        payload         jsonb        not null,
        occurred_at     timestamptz  not null,
        attempts        integer      not null default 0,
        next_attempt_at timestamptz  not null default now(),
        locked_until    timestamptz,
        published_at    timestamptz,
        last_error      varchar(500),
        constraint outbox_attempts_ck check (attempts >= 0)
      );
    `);
    this.addSql(`
      create index outbox_due_idx on outbox_messages (next_attempt_at)
        where published_at is null;
    `);
  }

  override down(): void {
    this.addSql(`drop table if exists outbox_messages;`);
    this.addSql(`drop table if exists inbox_messages;`);
    this.addSql(`drop table if exists wallet_ledger_entries;`);
    this.addSql(`drop table if exists wager_transactions;`);
    this.addSql(`drop table if exists wallets;`);
    this.addSql(`drop function if exists wallets_require_ledger_entry();`);
    this.addSql(`drop function if exists ledger_entry_consistency();`);
    this.addSql(`drop function if exists wager_transactions_guard_update();`);
    this.addSql(`drop function if exists wallets_guard_update();`);
    this.addSql(`drop function if exists forbid_mutation();`);
  }
}
