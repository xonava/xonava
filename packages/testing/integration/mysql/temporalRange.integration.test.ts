import { afterAll, beforeAll, describe, expect, it } from "vitest"
import mysql from "mysql2/promise"
import { drizzle } from "drizzle-orm/mysql2"
import { datetime, int, mysqlTable, timestamp } from "drizzle-orm/mysql-core"
import { Predicate, type PredicateNode } from "@xonava/core/domain"
import { assertMySqlUtcSession, compileDrizzlePredicate } from "@xonava/adapters/drizzle-mysql"
import { mysqlCertificationUrl } from "./database.js"

/**
 * Fourth-review regressions on MySQL:
 * - the engine-text path still required year >= 1000 although years 0000-0999 are bound natively, so a
 *   string-mode DATETIME(3) cursor value for year 500 compared as text and matched nothing;
 * - TIMESTAMP columns compare in the session time zone while literals are bound as UTC: a non-UTC
 *   session silently shifts every instant. The adapter cannot set the session of a caller-supplied
 *   pool, so the requirement is documented and {@link assertMySqlUtcSession} verifies it.
 */
const DT_TABLE = "fw_temporal_range_dt"
const TS_TABLE = "fw_temporal_range_ts"
const dt = mysqlTable(DT_TABLE, { id: int("id").primaryKey(), at: datetime("at", { mode: "string", fsp: 3 }) })
const ts = mysqlTable(TS_TABLE, { id: int("id").primaryKey(), at: timestamp("at", { mode: "date", fsp: 3 }), atText: timestamp("at_text", { mode: "string", fsp: 3 }) })

describe("MySQL temporal range edges", () => {
  let pool: mysql.Pool
  const dtIds = async (filter: PredicateNode) => (await drizzle(pool).select({ id: dt.id }).from(dt).where(compileDrizzlePredicate(filter, { id: dt.id, at: dt.at })).orderBy(dt.id)).map((row) => row.id)
  const tsIds = async (filter: PredicateNode) => (await drizzle(pool).select({ id: ts.id }).from(ts).where(compileDrizzlePredicate(filter, { id: ts.id, at: ts.at, atText: ts.atText })).orderBy(ts.id)).map((row) => row.id)

  beforeAll(async () => {
    const url = new URL(mysqlCertificationUrl())
    // One connection, so the session settings below apply to every query.
    pool = mysql.createPool({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1), connectionLimit: 1 })
    await pool.query("SET time_zone = '+00:00'")
    for (const table of [DT_TABLE, TS_TABLE]) await pool.query(`DROP TABLE IF EXISTS ${table}`)
    await pool.query(`CREATE TABLE ${DT_TABLE} (id INT PRIMARY KEY, at DATETIME(3) NULL)`)
    await pool.query(`INSERT INTO ${DT_TABLE} VALUES (1, '0000-06-15 12:00:00.000'), (2, '0500-01-01 10:00:00.000'), (3, '1500-01-01 10:00:00.000'), (4, '2024-01-01 10:00:00.000'), (5, NULL)`)
    await pool.query(`CREATE TABLE ${TS_TABLE} (id INT PRIMARY KEY, at TIMESTAMP(3) NULL, at_text TIMESTAMP(3) NULL)`)
    await pool.query(`INSERT INTO ${TS_TABLE} VALUES (1, '2024-01-01 10:00:00.000', '2024-01-01 10:00:00.000'), (2, '2023-12-31 23:00:00.000', '2023-12-31 23:00:00.000')`)
  }, 60_000)

  afterAll(async () => {
    for (const table of [DT_TABLE, TS_TABLE]) await pool.query(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined)
    await pool.end()
  })

  it("a string-mode DATETIME cursor value for years 0000-0999 compares natively", async () => {
    expect(await dtIds(Predicate.eq("at", "0500-01-01 10:00:00"))).toEqual([2])
    expect(await dtIds(Predicate.eq("at", "0500-01-01 10:00:00.000"))).toEqual([2])
    expect(await dtIds(Predicate.gt("at", "0500-01-01 10:00:00.000"))).toEqual([3, 4])
    expect(await dtIds(Predicate.lt("at", "0500-01-01 10:00:00.000"))).toEqual([1])
    expect(await dtIds(Predicate.eq("at", "0000-06-15 12:00:00"))).toEqual([1])
    expect(await dtIds(Predicate.eq("at", "1500-01-01 10:00:00"))).toEqual([3])
    const hydrated = await drizzle(pool).select({ id: dt.id, at: dt.at }).from(dt).orderBy(dt.id)
    const values = hydrated.filter((row) => row.at !== null)
    for (const [index, row] of values.entries()) {
      expect(await dtIds(Predicate.gt("at", row.at!)), `at > ${row.at}`).toEqual(values.slice(index + 1).map((other) => other.id))
    }
  })

  it("TIMESTAMP columns compare instants correctly in a UTC session", async () => {
    await pool.query("SET time_zone = '+00:00'")
    await expect(assertMySqlUtcSession(pool)).resolves.toBeUndefined()
    expect(await tsIds(Predicate.eq("at", "2024-01-01T10:00:00Z"))).toEqual([1])
    expect(await tsIds(Predicate.gt("at", new Date("2024-01-01T00:00:00Z")))).toEqual([1])
    expect(await tsIds(Predicate.eq("atText", "2024-01-01 10:00:00.000"))).toEqual([1])
  })

  it("a non-UTC session shifts TIMESTAMP comparisons, and the guard refuses it", async () => {
    try {
      await pool.query("SET time_zone = '+05:00'")
      // The stored UTC instant 10:00Z reads 15:00 in this session; the UTC-bound literal no longer matches it.
      expect(await tsIds(Predicate.eq("at", "2024-01-01T10:00:00Z"))).toEqual([])
      await expect(assertMySqlUtcSession(pool)).rejects.toThrow(/UTC/)
      await pool.query("SET time_zone = 'SYSTEM'")
      const [[system]] = (await pool.query("SELECT @@system_time_zone AS tz")) as unknown as [[{ tz: string }]]
      if (system!.tz === "UTC" || system!.tz === "+00:00") await expect(assertMySqlUtcSession(pool)).resolves.toBeUndefined()
    } finally {
      await pool.query("SET time_zone = '+00:00'")
    }
  })
})
