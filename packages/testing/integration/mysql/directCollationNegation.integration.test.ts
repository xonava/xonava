import { describe, expect, it } from "vitest"
import mysql from "mysql2/promise"
import { drizzle } from "drizzle-orm/mysql2"
import { int, mysqlTable, varchar } from "drizzle-orm/mysql-core"
import { Predicate, markTrustedPredicate, type PredicateNode } from "@xonava/core/domain"
import type { UnversionedEntityDescriptor } from "@xonava/core/persistence"
import { compileDrizzlePredicate, createDrizzleMySqlRepository } from "@xonava/adapters/drizzle-mysql"
import { mysqlCertificationUrl } from "./database.js"

/**
 * Regression: with `mysqlBinaryCollation` the bare column was compared with bare literals. MySQL's equality
 * propagation turned `owner_id = 'U1' AND owner_id <> 'u1'` into a comparison of the two constants under the
 * connection collation (case-insensitive), so rows with owner 'U1' passed `NOT owner_id <> 'u1'`.
 * The text literals now carry utf8mb4_0900_bin explicitly.
 */
type Row = { id: number; ownerId: string | null }
const TABLE = "framework_direct_collation_negation"
const table = mysqlTable(TABLE, { id: int("id").primaryKey(), ownerId: varchar("owner_id", { length: 64 }) })
const columnMap = { id: table.id, ownerId: table.ownerId }
const entity = { name: "DirectCollationNegation", table: TABLE, primaryKey: "id" } as unknown as UnversionedEntityDescriptor<Row>

const owner = (op: "eq" | "neq", value: string): PredicateNode => ({ kind: "condition", field: "ownerId", op, value })
const not = (filter: PredicateNode): PredicateNode => ({ kind: "not", filter })
// The shrunk ABAC scope: ownerId != U1, or (ownerId == U1 and ownerId == u1).
const scope: PredicateNode = { kind: "or", filters: [not(owner("eq", "U1")), { kind: "and", filters: [not(not(owner("eq", "U1"))), not(owner("neq", "u1"))] }] }

describe("MySQL direct binary-collation comparison with negated, case-differing equalities", () => {
  // `charset: "utf8mb4"` selects the case-insensitive utf8mb4_general_ci connection collation, as most applications do.
  it.each(["utf8mb4_general_ci", "utf8mb4_0900_ai_ci"])("excludes every row the core evaluator rejects (connection collation %s)", async (connectionCollation) => {
    const url = new URL(mysqlCertificationUrl())
    const pool = mysql.createPool({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1), connectionLimit: 1, charset: connectionCollation.toUpperCase() })
    try {
      await pool.query(`DROP TABLE IF EXISTS ${TABLE}`)
      await pool.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, owner_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL) ENGINE=InnoDB`)
      const db = drizzle(pool)
      await db.insert(table).values([{ id: 1, ownerId: "U1" }, { id: 2, ownerId: "u1" }, { id: 3, ownerId: "x" }, { id: 4, ownerId: null }])
      const repository = createDrizzleMySqlRepository<Row, number>({ db, table, entity, columnMap, mysqlBinaryCollation: true })
      // Core: U1 -> false (not eq false; and(true, not neq u1 = false)), u1 -> true, x -> true, NULL -> excluded.
      const page = await repository.findMany({ filter: Predicate.and(markTrustedPredicate(Predicate.isNotNull("id")), markTrustedPredicate(scope)), pagination: { kind: "offset", page: 1, pageSize: 100 } })
      expect(page.rows.map((row) => row.id).sort()).toEqual([2, 3])
      const ids = (await db.select({ id: table.id }).from(table).where(compileDrizzlePredicate(scope, columnMap, { mysqlBinaryCollation: true }))).map((row) => row.id).sort()
      expect(ids).toEqual([2, 3])
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => undefined)
      await pool.end()
    }
  }, 60_000)
})
