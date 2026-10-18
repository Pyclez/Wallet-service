import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { Migration001InitialSchema } from "./migrations/Migration001InitialSchema";
import { ENTITY_SCHEMAS } from "./schemas";

export const DEFAULT_DATABASE_URL = "postgresql://wallet:wallet@localhost:5432/wallet";

export function createOrmConfig(
  clientUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  options: { poolSize?: number } = {},
) {
  return defineConfig({
    clientUrl,
    entities: ENTITY_SCHEMAS,
    extensions: [Migrator],
    migrations: {
      migrationsList: [Migration001InitialSchema],
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      snapshotOnMigrate: false,
    },
    pool: { min: 0, max: options.poolSize ?? 10 },
    debug: process.env.ORM_DEBUG === "true",
  });
}
