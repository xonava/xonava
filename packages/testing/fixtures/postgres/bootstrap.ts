import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
export interface PgFixtureClient { query(sql: string): Promise<unknown> }
export async function bootstrapPostgresFixture(client: PgFixtureClient): Promise<void> {
  const root = dirname(fileURLToPath(import.meta.url))
  await client.query(await readFile(join(root, "migrations/0001_framework.sql"), "utf8"))
}
