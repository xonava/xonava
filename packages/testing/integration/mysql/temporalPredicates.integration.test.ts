import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import mysql from "mysql2/promise"
import { drizzle } from "drizzle-orm/mysql2"
import { date, datetime, int, mysqlTable } from "drizzle-orm/mysql-core"
import { Predicate, type PredicateNode } from "core/domain"
import { compileDrizzlePredicate } from "adapters/drizzle-mysql"
import { mysqlCertificationUrl } from "./database.js"

/**
 * Regression (review M7): a calendar-date literal against a MySQL DATE column
 * (drizzle mode "date") was bound as a Date, which mysql2 serializes in the
 * connection's time zone ("local" by default): in a process west of UTC,
 * `day = 2024-01-01` matched 2023-12-31. Literals are now bound in a
 * time-zone-free form.
 */
const TABLE = "fw_temporal_predicates"
const rows = mysqlTable(TABLE, { id: int("id").primaryKey(), day: date("day"), at: datetime("at", { mode: "date", fsp: 3 }), atText: datetime("at_text", { mode: "string", fsp: 3 }) })
const columnMap = { id: rows.id, day: rows.day, at: rows.at, atText: rows.atText }

describe("MySQL temporal predicates do not depend on the process or connection time zone", () => {
  const originalTz = process.env.TZ
  let pool: mysql.Pool

  beforeAll(async () => {
    // Before any Date work in the connection: the driver default `timezone: "local"` now means New York.
    process.env.TZ = "America/New_York"
    const url = new URL(mysqlCertificationUrl())
    pool = mysql.createPool({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1), connectionLimit: 1 })
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`)
    await pool.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, day DATE NULL, at DATETIME(3) NULL, at_text DATETIME(3) NULL)`)
    await pool.query(`INSERT INTO ${TABLE} VALUES (1, '2024-01-01', '2024-01-01 10:00:00.000', '2024-01-01 10:00:00.000'), (2, '2023-12-31', '2023-12-31 23:00:00.000', '2023-12-31 23:00:00.000')`)
  }, 60_000)

  afterEach(() => { expect(new Date("2024-01-01T00:00:00Z").getTimezoneOffset()).toBe(300) })

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => undefined)
    await pool.end()
    if (originalTz === undefined) delete process.env.TZ
    else process.env.TZ = originalTz
  })

  const ids = async (filter: PredicateNode) => (await drizzle(pool).select({ id: rows.id }).from(rows).where(compileDrizzlePredicate(filter, columnMap)).orderBy(rows.id)).map((row) => row.id)

  it("compares DATE columns with calendar-date and UTC-midnight literals as that date", async () => {
    expect(await ids(Predicate.eq("day", "2024-01-01"))).toEqual([1])
    expect(await ids(Predicate.eq("day", new Date("2024-01-01T00:00:00Z")))).toEqual([1])
    expect(await ids(Predicate.lt("day", "2024-01-01"))).toEqual([2])
  })

  it("compares DATETIME columns (Date and string modes) with instants in UTC", async () => {
    expect(await ids(Predicate.eq("at", "2024-01-01T15:30:00+05:30"))).toEqual([1])
    expect(await ids(Predicate.gte("at", new Date("2024-01-01T00:00:00Z")))).toEqual([1])
    expect(await ids(Predicate.eq("atText", "2024-01-01T10:00:00Z"))).toEqual([1])
    // The driver's own text form of a string-mode column (cursor values carry it) compares natively.
    expect(await ids(Predicate.eq("atText", "2024-01-01 10:00:00.000"))).toEqual([1])
  })

  it("compares instants outside DATE/DATETIME's range as constants and never sends offsets", async () => {
    expect(await ids(Predicate.gt("day", "0500-01-01"))).toEqual([1, 2])
    expect(await ids(Predicate.eq("day", "0500-01-01"))).toEqual([])
    expect(await ids(Predicate.lt("at", "9999-12-31T23:00:00-05:00"))).toEqual([1, 2])
    expect(await ids(Predicate.not(Predicate.gte("atText", "0999-12-31T23:59:59Z")))).toEqual([])
    // A driver-form literal with an offset compares as text (core compares the hydrated string).
    expect(await ids(Predicate.eq("atText", "2024-01-01 10:00:00+01:00"))).toEqual([])
  })
})
