import { describe, expect, it } from "vitest"
import mysql from "mysql2/promise"
import { drizzle } from "drizzle-orm/mysql2"
import { boolean, double, int, mysqlTable, varchar } from "drizzle-orm/mysql-core"
import { assertMySqlBinaryCollation, compileDrizzlePredicate } from "adapters/drizzle-mysql"
import { findParityMismatches, parityDataset } from "../shared/predicateParity.js"
import { mysqlCertificationUrl } from "./database.js"

const rows = mysqlTable("framework_predicate_parity", { id: int("id").primaryKey(), n: double("n"), s: varchar("s", { length: 64 }), b: boolean("b") })
const columnMap = { n: rows.n, s: rows.s, b: rows.b }

async function withTable<T>(collation: string, work: (pool: mysql.Pool) => Promise<T>): Promise<T> {
  const url = new URL(mysqlCertificationUrl())
  const pool = mysql.createPool({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1), connectionLimit: 2, charset: "utf8mb4" })
  try {
    await pool.query("DROP TABLE IF EXISTS framework_predicate_parity")
    await pool.query(`CREATE TABLE framework_predicate_parity (id INT PRIMARY KEY, n DOUBLE NULL, s VARCHAR(64) CHARACTER SET utf8mb4 COLLATE ${collation} NULL, b BOOLEAN NULL) ENGINE=InnoDB`)
    await drizzle(pool).insert(rows).values(parityDataset())
    return await work(pool)
  } finally {
    await pool.query("DROP TABLE IF EXISTS framework_predicate_parity").catch(() => undefined)
    await pool.end()
  }
}

describe("predicate semantics parity: core evaluator vs compiled SQL (MySQL)", () => {
  it("selects identical rows on the server default case-insensitive collation", async () => {
    const mismatches = await withTable("utf8mb4_0900_ai_ci", async (pool) => {
      await expect(assertMySqlBinaryCollation(pool, "framework_predicate_parity", ["s"])).rejects.toThrow("non-binary collation")
      const db = drizzle(pool)
      return findParityMismatches(async (predicate) => (await db.select({ id: rows.id }).from(rows).where(compileDrizzlePredicate(predicate, columnMap))).map((row) => row.id))
    })
    expect(mismatches, mismatches.join("\n")).toEqual([])
  }, 180_000)

  it("rejects direct comparison on a PAD SPACE binary collation", async () => {
    await withTable("utf8mb4_bin", async (pool) => {
      await expect(assertMySqlBinaryCollation(pool, "framework_predicate_parity", ["s"])).rejects.toThrow("PAD SPACE")
    })
  }, 60_000)

  it("selects identical rows comparing columns directly on a verified NO PAD binary collation", async () => {
    const mismatches = await withTable("utf8mb4_0900_bin", async (pool) => {
      await assertMySqlBinaryCollation(pool, "framework_predicate_parity", ["s"])
      const db = drizzle(pool)
      return findParityMismatches(async (predicate) => (await db.select({ id: rows.id }).from(rows).where(compileDrizzlePredicate(predicate, columnMap, { mysqlBinaryCollation: true }))).map((row) => row.id))
    })
    expect(mismatches, mismatches.join("\n")).toEqual([])
  }, 180_000)
})
