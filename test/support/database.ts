import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmConfig, DEFAULT_DATABASE_URL } from "../../src/database/mikro-orm.config";

export function testDatabaseUrl(name: string): string {
  const parsed = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  parsed.pathname = `/wallet_test_${name}`;
  return parsed.toString();
}

export async function createTestDatabase(name = "schema"): Promise<MikroORM> {
  const adminUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const testUrl = testDatabaseUrl(name);
  const testDbName = new URL(testUrl).pathname.slice(1);

  const admin = await MikroORM.init(createOrmConfig(adminUrl));
  try {
    await admin.em.execute(`drop database if exists "${testDbName}" with (force)`);
    await admin.em.execute(`create database "${testDbName}"`);
  } finally {
    await admin.close(true);
  }

  const config = createOrmConfig(testUrl, { poolSize: 20 });
  const orm = await MikroORM.init({ ...config, migrations: { ...config.migrations, silent: true } });
  await orm.migrator.up();
  return orm;
}

export async function expectLedgerConsistent(orm: MikroORM): Promise<{ wallets: number }> {
  const rows = await orm.em.fork().execute<
    { id: string; balance: string; ledger: string; balance_matches: boolean; version_matches: boolean }[]
  >(
    `select w.id,
            w.balance::text as balance,
            coalesce(sum(case when e.direction = 'CREDIT' then e.amount else -e.amount end), 0)::text as ledger,
            w.balance = coalesce(sum(case when e.direction = 'CREDIT' then e.amount else -e.amount end), 0)
              as balance_matches,
            w.version = coalesce(max(e.wallet_version), 1) as version_matches
       from wallets w
       left join wallet_ledger_entries e on e.wallet_id = w.id
      group by w.id`,
  );
  const broken = rows.filter((row) => !row.balance_matches || !row.version_matches);
  if (broken.length > 0) {
    throw new Error(`saldo e ledger divergem em ${broken.length} wallet(s): ${JSON.stringify(broken.slice(0, 3))}`);
  }
  return { wallets: rows.length };
}
