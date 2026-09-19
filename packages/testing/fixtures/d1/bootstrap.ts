import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { D1FixtureDatabase } from "./schema.js"
export async function bootstrapD1Fixture(database: D1FixtureDatabase): Promise<void> {
  const root = dirname(fileURLToPath(import.meta.url))
  await database.exec(await readFile(join(root, "migrations/0001_framework.sql"), "utf8"))
}
