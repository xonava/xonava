import type { SQL } from "drizzle-orm"
import type { PredicateNode } from "core/domain"
import { ConfigurationError } from "core/domain"
import { compileDrizzlePredicate as compileShared, type DrizzleColumnMap, type PredicateCompilerOptions } from "../drizzle-shared/predicateCompiler"

/** MySQL predicate compilation; defaults to case-sensitive, code-point text comparison. */
export function compileDrizzlePredicate(filter: PredicateNode, columnMap: DrizzleColumnMap, options: PredicateCompilerOptions = {}): SQL<unknown> {
  return compileShared(filter, columnMap, { dialect: "mysql", ...options })
}

interface CollationQueryable { query(sql: string, values?: unknown[]): Promise<[unknown, unknown]> }

/**
 * Verifies that every listed text column uses a binary (`*_bin`) collation, so
 * a repository may safely set `mysqlBinaryCollation: true` and compare columns
 * directly (keeping index use) without changing predicate semantics.
 */
export async function assertMySqlBinaryCollation(db: CollationQueryable, table: string, columns: readonly string[]): Promise<void> {
  if (!/^[A-Za-z0-9_]+$/.test(table) || columns.some((column) => !/^[A-Za-z0-9_]+$/.test(column))) throw new ConfigurationError("Unsafe MySQL identifier")
  if (columns.length === 0) return
  const [rows] = await db.query(`SELECT COLUMN_NAME AS name, COLLATION_NAME AS collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME IN (${columns.map(() => "?").join(",")})`, [table, ...columns])
  const found = new Map((rows as { name: string; collation: string | null }[]).map((row) => [row.name, row.collation]))
  for (const column of columns) {
    if (!found.has(column)) throw new ConfigurationError(`Column ${table}.${column} does not exist`)
    const collation = found.get(column)
    if (collation !== null && collation !== undefined && !collation.endsWith("_bin")) throw new ConfigurationError(`Column ${table}.${column} uses non-binary collation ${collation}; predicates would ignore case`)
  }
}
