import { afterAll, beforeAll, describe, expect, it } from "vitest"
import pg from "pg"
import { drizzle } from "drizzle-orm/node-postgres"
import { date, integer, pgTable, timestamp } from "drizzle-orm/pg-core"
import { Predicate, type PredicateNode } from "core/domain"
import { DrizzlePredicateCompiler } from "../../../adapters/src/drizzle-shared/predicateCompiler.js"
import { pgCertificationUrl } from "./database.js"

/**
 * Fourth-review regressions on PostgreSQL:
 * - keyset cursors built from string-mode BC / five-digit-year rows compared as text and skipped rows;
 * - instants below the type's range were folded to constants that treat every stored value as greater,
 *   which is false for the `-infinity` rows PostgreSQL stores.
 */
const TEXT_TABLE = "fw_temporal_range_text"
const INF_TABLE = "fw_temporal_range_inf"
const text = pgTable(TEXT_TABLE, { id: integer("id").primaryKey(), ts: timestamp("ts", { precision: 3, mode: "string" }), tz: timestamp("tz", { precision: 3, withTimezone: true, mode: "string" }), day: date("day") })
const inf = pgTable(INF_TABLE, { id: integer("id").primaryKey(), tz: timestamp("tz", { withTimezone: true, mode: "date" }), ts: timestamp("ts", { mode: "string" }), day: date("day") })
// 4714-11-24 BC is PostgreSQL's lower limit; one millisecond before it is out of range.
const MIN = (() => { const date = new Date(0); date.setUTCFullYear(-4713, 10, 24); return date.getTime() })()

describe("PostgreSQL temporal range edges", () => {
  let pool: pg.Pool
  let db: ReturnType<typeof drizzle>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 1 })
    db = drizzle(pool)
    await pool.query("SET TIME ZONE 'UTC'")
    for (const table of [TEXT_TABLE, INF_TABLE]) await pool.query(`DROP TABLE IF EXISTS ${table}`)
    await pool.query(`CREATE TABLE ${TEXT_TABLE} (id integer PRIMARY KEY, ts timestamp(3), tz timestamptz(3), day date)`)
    await pool.query(`INSERT INTO ${TEXT_TABLE} VALUES
      (0, '4714-11-24 00:00:00 BC', '4714-11-24 00:00:00+00 BC', '4714-11-24 BC'),
      (1, '0044-03-15 12:00:00 BC', '0044-03-15 12:00:00+00 BC', '0044-03-15 BC'),
      (2, '0030-01-01 00:00:00', '0030-01-01 00:00:00+00', '0030-01-01'),
      (3, '2020-01-01 10:00:00', '2020-01-01 10:00:00+00', '2020-01-01'),
      (4, '12000-01-01 00:00:00', '12000-01-01 00:00:00+00', '12000-01-01'),
      (5, NULL, NULL, NULL)`)
    await pool.query(`CREATE TABLE ${INF_TABLE} (id integer PRIMARY KEY, tz timestamptz, ts timestamp, day date)`)
    await pool.query(`INSERT INTO ${INF_TABLE} VALUES (1, '-infinity', '-infinity', '-infinity'), (2, 'infinity', 'infinity', 'infinity'), (3, '2024-01-01T10:00:00Z', '2024-01-01 10:00:00', '2024-01-01'), (4, NULL, NULL, NULL)`)
  }, 60_000)

  afterAll(async () => {
    for (const table of [TEXT_TABLE, INF_TABLE]) await pool.query(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined)
    await pool.end()
  })

  describe("engine text form (string-mode cursor values)", () => {
    const compiler = new DrizzlePredicateCompiler({ id: text.id, ts: text.ts, tz: text.tz, day: text.day }, { dialect: "postgres" })
    const ids = async (filter: PredicateNode) => (await db.select({ id: text.id }).from(text).where(compiler.compileWhere(filter)).orderBy(text.id)).map((row) => row.id)

    it("a BC cursor value compares natively (timestamp)", async () => {
      expect(await ids(Predicate.gt("ts", "0044-03-15 12:00:00 BC"))).toEqual([2, 3, 4])
      expect(await ids(Predicate.gte("ts", "0044-03-15 12:00:00 BC"))).toEqual([1, 2, 3, 4])
      expect(await ids(Predicate.lt("ts", "0044-03-15 12:00:00 BC"))).toEqual([0])
      expect(await ids(Predicate.eq("ts", "0044-03-15 12:00:00 BC"))).toEqual([1])
    })

    it("a five-digit-year cursor value compares natively", async () => {
      expect(await ids(Predicate.lt("ts", "12000-01-01 00:00:00"))).toEqual([0, 1, 2, 3])
      expect(await ids(Predicate.eq("ts", "12000-01-01 00:00:00"))).toEqual([4])
    })

    it("every hydrated value finds its keyset successors", async () => {
      for (const column of ["ts", "tz", "day"] as const) {
        const hydrated = await db.select({ id: text.id, value: text[column] }).from(text).orderBy(text.id)
        const values = hydrated.filter((row) => row.value !== null)
        for (const [index, row] of values.entries()) {
          expect(await ids(Predicate.gt(column, row.value!)), `${column} > ${row.value}`).toEqual(values.slice(index + 1).map((other) => other.id))
          expect(await ids(Predicate.eq(column, row.value!)), `${column} = ${row.value}`).toEqual([row.id])
        }
      }
    })

    it("a BC value below the type's range is a constant, never a server error", async () => {
      expect(await ids(Predicate.gt("ts", "9000-01-01 00:00:00 BC"))).toEqual([0, 1, 2, 3, 4])
      expect(await ids(Predicate.lt("ts", "9000-01-01 00:00:00 BC"))).toEqual([])
      expect(await ids(Predicate.eq("ts", "9000-01-01 00:00:00 BC"))).toEqual([])
    })

    it("malformed engine text never reaches the server", async () => {
      for (const literal of ["0000-01-01 00:00:00 BC", "2024-02-30 00:00:00", "2024-01-01 25:00:00", "2024-01-01 10:00:00 AD BC", "999999-01-01 00:00:00"]) {
        await expect(ids(Predicate.gt("ts", literal)), literal).resolves.toBeDefined()
      }
    })
  })

  describe("-infinity / infinity rows against out-of-range literals", () => {
    const compiler = new DrizzlePredicateCompiler({ id: inf.id, tz: inf.tz, ts: inf.ts, day: inf.day }, { dialect: "postgres" })
    const ids = async (filter: PredicateNode) => (await db.select({ id: inf.id }).from(inf).where(compiler.compileWhere(filter)).orderBy(inf.id)).map((row) => row.id)
    const below = new Date(MIN - 1)

    it("compares every operator as PostgreSQL would against the infinities", async () => {
      // A literal below every finite value is above only -infinity's neighbours: -infinity < literal < everything finite.
      expect(await ids(Predicate.gt("tz", below))).toEqual([2, 3])
      expect(await ids(Predicate.gte("tz", below))).toEqual([2, 3])
      expect(await ids(Predicate.lt("tz", below))).toEqual([1])
      expect(await ids(Predicate.lte("tz", below))).toEqual([1])
      expect(await ids(Predicate.eq("tz", below))).toEqual([])
      expect(await ids(Predicate.neq("tz", below))).toEqual([1, 2, 3])
      expect(await ids(Predicate.between("tz", { from: below }))).toEqual([2, 3])
      expect(await ids(Predicate.between("tz", { to: below }))).toEqual([1])
      expect(await ids(Predicate.between("tz", { from: below, to: new Date("2025-01-01T00:00:00Z") }))).toEqual([3])
      expect(await ids(Predicate.in("tz", [below]))).toEqual([])
      expect(await ids(Predicate.in("tz", [below, new Date("2024-01-01T10:00:00Z")]))).toEqual([3])
    })

    it("keeps NULL rows UNKNOWN under not()", async () => {
      expect(await ids(Predicate.not(Predicate.gt("tz", below)))).toEqual([1])
      expect(await ids(Predicate.not(Predicate.gte("tz", below)))).toEqual([1])
      expect(await ids(Predicate.not(Predicate.lt("tz", below)))).toEqual([2, 3])
      expect(await ids(Predicate.not(Predicate.lte("tz", below)))).toEqual([2, 3])
      expect(await ids(Predicate.not(Predicate.eq("tz", below)))).toEqual([1, 2, 3])
      expect(await ids(Predicate.not(Predicate.neq("tz", below)))).toEqual([])
      expect(await ids(Predicate.not(Predicate.between("tz", { from: below })))).toEqual([1])
      expect(await ids(Predicate.not(Predicate.in("tz", [below])))).toEqual([1, 2, 3])
    })

    it("applies to string-mode timestamp and date columns, with Date and string literals", async () => {
      expect(await ids(Predicate.gt("ts", below))).toEqual([2, 3])
      expect(await ids(Predicate.lt("ts", "9000-01-01 00:00:00 BC"))).toEqual([1])
      expect(await ids(Predicate.gt("ts", "9000-01-01 00:00:00 BC"))).toEqual([2, 3])
      expect(await ids(Predicate.gt("day", below))).toEqual([2, 3])
      expect(await ids(Predicate.not(Predicate.lte("day", below)))).toEqual([2, 3])
    })
  })
})
