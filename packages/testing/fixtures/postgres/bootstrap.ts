import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { POSTGRES_FIXTURE_MIGRATIONS, POSTGRES_FIXTURE_SCHEMA } from "./schema.js"
export interface PgFixtureClient { query(sql: string): Promise<unknown> }

/** Reads one fixture migration, optionally re-targeted at another schema (the migrations are written against `framework_test`). */
export async function readPostgresMigration(name: (typeof POSTGRES_FIXTURE_MIGRATIONS)[number], schema: string = POSTGRES_FIXTURE_SCHEMA): Promise<string> {
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), "migrations", name), "utf8")
  return schema === POSTGRES_FIXTURE_SCHEMA ? source : source.replaceAll(POSTGRES_FIXTURE_SCHEMA, schema)
}

/** Applies every fixture migration in order. All of them are idempotent on PostgreSQL. */
export async function bootstrapPostgresFixture(client: PgFixtureClient): Promise<void> {
  for (const name of POSTGRES_FIXTURE_MIGRATIONS) await client.query(await readPostgresMigration(name))
}
