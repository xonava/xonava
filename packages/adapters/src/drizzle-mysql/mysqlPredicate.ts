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
 * Verifies that every listed text column uses a NO PAD binary collation (such
 * as `utf8mb4_0900_bin`), so a repository may safely set
 * `mysqlBinaryCollation: true` and compare columns directly (keeping index
 * use) without changing predicate semantics. PAD SPACE binary collations
 * (`utf8mb4_bin`) are rejected: they compare 'a' and 'a ' as equal and sort
 * 'a' after 'a\t', unlike code-point order.
 */
export async function assertMySqlBinaryCollation(db: CollationQueryable, table: string, columns: readonly string[]): Promise<void> {
  if (!/^[A-Za-z0-9_]+$/.test(table) || columns.some((column) => !/^[A-Za-z0-9_]+$/.test(column))) throw new ConfigurationError("Unsafe MySQL identifier")
  if (columns.length === 0) return
  const [rows] = await db.query(`SELECT c.COLUMN_NAME AS name, c.COLLATION_NAME AS collation, k.PAD_ATTRIBUTE AS pad FROM information_schema.COLUMNS c LEFT JOIN information_schema.COLLATIONS k ON k.COLLATION_NAME = c.COLLATION_NAME WHERE c.TABLE_SCHEMA=DATABASE() AND c.TABLE_NAME=? AND c.COLUMN_NAME IN (${columns.map(() => "?").join(",")})`, [table, ...columns])
  const found = new Map((rows as { name: string; collation: string | null; pad: string | null }[]).map((row) => [row.name, row]))
  for (const column of columns) {
    const row = found.get(column)
    if (!row) throw new ConfigurationError(`Column ${table}.${column} does not exist`)
    const collation = row.collation
    if (collation === null || collation === undefined) continue
    if (!collation.endsWith("_bin")) throw new ConfigurationError(`Column ${table}.${column} uses non-binary collation ${collation}; predicates would ignore case`)
    if (row.pad !== "NO PAD") throw new ConfigurationError(`Column ${table}.${column} uses PAD SPACE collation ${collation}; predicates would ignore trailing spaces (use utf8mb4_0900_bin)`)
  }
}
