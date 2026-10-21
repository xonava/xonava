import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { D1_FIXTURE_MIGRATIONS, type D1FixtureDatabase } from "./schema.js"

export async function readD1Migration(name: (typeof D1_FIXTURE_MIGRATIONS)[number]): Promise<string> {
  return readFile(join(dirname(fileURLToPath(import.meta.url)), "migrations", name), "utf8")
}

/** One statement per line (D1 `exec` contract); comment and blank lines are dropped. */
export function d1MigrationStatements(source: string): string[] {
  return source.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("--"))
}

const isDuplicateColumn = (error: unknown): boolean => /duplicate column name/i.test(String((error as { message?: unknown } | null)?.message ?? error)) || /duplicate column name/i.test(String(((error as { cause?: { message?: unknown } } | null)?.cause)?.message ?? ""))

/**
 * Applies the fixture migrations. 0001 is idempotent; later migrations alter existing tables, which SQLite cannot
 * guard, so a migration whose first statement fails with "duplicate column name" is already applied and is skipped
 * (a persisted fixture is bootstrapped repeatedly).
 */
export async function bootstrapD1Fixture(database: D1FixtureDatabase): Promise<void> {
  const [first, ...later] = D1_FIXTURE_MIGRATIONS
  await database.exec(await readD1Migration(first))
  for (const name of later) await applyD1Migration(database, name)
}

const isMissingTable = (error: unknown): boolean => /no such table/i.test(String((error as { message?: unknown } | null)?.message ?? error)) || /no such table/i.test(String(((error as { cause?: { message?: unknown } } | null)?.cause)?.message ?? ""))

/**
 * Applies one D1 fixture migration statement by statement; returns false when it was already applied (or, for an index
 * on a deployment-owned table such as `jobs`, when that table does not exist in the fixture database).
 */
export async function applyD1Migration(database: D1FixtureDatabase, name: (typeof D1_FIXTURE_MIGRATIONS)[number]): Promise<boolean> {
  const statements = d1MigrationStatements(await readD1Migration(name))
  for (const [index, statement] of statements.entries()) {
    try { await database.exec(statement) } catch (error) {
      if (index === 0 && isDuplicateColumn(error)) return false
      if (/^CREATE (UNIQUE )?INDEX /i.test(statement) && isMissingTable(error)) return false
      // Column additions to deployment-owned tables (jobs, schedules): one missing table or already-added column must not stop the others.
      if (index > 0 && /^ALTER TABLE \w+ ADD COLUMN /i.test(statement) && (isMissingTable(error) || isDuplicateColumn(error))) continue
      if (index === 0 && /^ALTER TABLE \w+ ADD COLUMN /i.test(statement) && isMissingTable(error)) continue
      throw error
    }
  }
  return true
}
