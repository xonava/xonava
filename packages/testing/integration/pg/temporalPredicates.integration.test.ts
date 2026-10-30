import { afterAll, beforeAll, describe, expect, it } from "vitest"
import pg from "pg"
import { drizzle } from "drizzle-orm/node-postgres"
import { date, integer, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { Predicate, createAbacAuthorizer, type PredicateNode } from "@xonava/core/domain"
import type { UnversionedEntityDescriptor } from "@xonava/core/persistence"
import { createDrizzleRepository } from "@xonava/adapters/drizzle-pg"
import { DrizzlePredicateCompiler } from "../../../adapters/src/drizzle-shared/predicateCompiler.js"
import { predicateFromFilterCondition } from "../../../adapters/src/http/filterInterop.js"
import { bindPolicies, makePolicy } from "../../../core/src/__tests__/differential/abacArbitraries.js"
import { pgCertificationUrl } from "./database.js"

/**
 * Regressions from review of the differential fixes (H1/H2):
 * - temporal columns compared through their text form made the HTTP layer's
 *   date filter (a between of full ISO instants) match nothing and defeated
 *   indexes;
 * - enum columns compared as text (no index) while sorting natively;
 * - the root COALESCE(..., FALSE) hid every comparison from the planner.
 */
const TABLE = "fw_temporal_predicates"
const STATUS_TYPE = "fw_temporal_predicates_status"
const status = pgEnum(STATUS_TYPE, ["locked", "draft", "Active"])
// Drizzle defaults: date() is string mode; this timestamp is string mode too.
const rows = pgTable(TABLE, { id: integer("id").primaryKey(), day: date("day"), at: timestamp("at", { withTimezone: true, mode: "string" }), st: status("st"), name: text("name") })
const columnMap = { id: rows.id, day: rows.day, at: rows.at, st: rows.st, name: rows.name }
const ROWS = 5000

describe("PostgreSQL temporal and enum predicates (native, index-usable)", () => {
  let pool: pg.Pool
  let db: ReturnType<typeof drizzle>
  const compiler = new DrizzlePredicateCompiler(columnMap, { dialect: "postgres" })
  const ids = async (filter: PredicateNode) => (await db.select({ id: rows.id }).from(rows).where(compiler.compileWhere(filter)).orderBy(rows.id)).map((row) => row.id)

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 1 })
    db = drizzle(pool)
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`)
    await pool.query(`DROP TYPE IF EXISTS ${STATUS_TYPE}`)
    await pool.query(`CREATE TYPE ${STATUS_TYPE} AS ENUM ('locked', 'draft', 'Active')`)
    await pool.query(`CREATE TABLE ${TABLE} (id integer PRIMARY KEY, day date, at timestamptz, st ${STATUS_TYPE}, name text)`)
    // Row 1 is the probe; the rest give the planner a reason to prefer indexes.
    await pool.query(`INSERT INTO ${TABLE} VALUES (1, '2024-01-01', '2024-01-01T10:00:00Z', 'draft', 'probe')`)
    await pool.query(`INSERT INTO ${TABLE} SELECT g, date '2020-01-01' + (g % 1000), timestamptz '2020-01-01T00:00:00Z' + g * interval '1 hour', (ARRAY['locked','Active'])[1 + g % 2]::${STATUS_TYPE}, 'n' || g FROM generate_series(2, ${ROWS}) g`)
    await pool.query(`INSERT INTO ${TABLE} (id) VALUES (${ROWS + 1})`)
    for (const column of ["day", "at", "st", "name"]) await pool.query(`CREATE INDEX ON ${TABLE} (${column})`)
    await pool.query(`ANALYZE ${TABLE}`)
  }, 60_000)

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => undefined)
    await pool.query(`DROP TYPE IF EXISTS ${STATUS_TYPE}`).catch(() => undefined)
    await pool.end()
  })

  it("the HTTP date filter finds the row on a string-mode date column", async () => {
    // filterInterop turns `day eq 2024-01-01` into a between of the day's first and last instants.
    const filter = predicateFromFilterCondition({ field: "day", operator: "eq", value: "2024-01-01" }, undefined, { day: { kind: "date" } })!
    expect(await ids(filter)).toContain(1)
    expect(await ids(Predicate.eq("day", "2024-01-01"))).toContain(1)
  })

  it("string-mode timestamptz compares instants for RFC 3339 literals and its own text form", async () => {
    const day = predicateFromFilterCondition({ field: "at", operator: "eq", value: "2024-01-01" }, undefined, { at: { kind: "date" } })!
    expect(await ids(day)).toContain(1)
    expect(await ids(Predicate.eq("at", "2024-01-01T15:30:00+05:30"))).toEqual([1])
    const [row] = await db.select({ at: rows.at }).from(rows).where(compiler.compileWhere(Predicate.eq("id", 1)))
    // The driver hydrates PostgreSQL's text form ("2024-01-01 10:00:00+00"): a cursor value must find it again.
    expect(await ids(Predicate.eq("at", row!.at!))).toEqual([1])
    expect(await ids(Predicate.not(Predicate.eq("at", "not a time")))).not.toContain(ROWS + 1)
  })

  it("enum equality is native; a non-member equals nothing without a server error", async () => {
    expect(await ids(Predicate.eq("st", "draft"))).toEqual([1])
    expect(await ids(Predicate.eq("st", "nope"))).toEqual([])
    expect(await ids(Predicate.not(Predicate.eq("st", "nope")))).toHaveLength(ROWS)
  })

  it("orders enum values by code point, so an ABAC scope agrees with the record decision", async () => {
    // Declaration order is locked < draft < Active; code-point order is Active < draft < locked.
    const all = await db.select({ id: rows.id, st: rows.st }).from(rows)
    expect(await ids(Predicate.lt("st", "draft"))).toEqual(all.filter((row) => row.st === "Active").map((row) => row.id).sort((a, b) => a - b))
    // A deny `st lessThan <literal>` must deny exactly what the record decision denies,
    // for a member ("draft": natively only "locked" is below it) and a non-member ("e": only "locked"
    // is not below it by code point).
    for (const literal of ["draft", "e"]) {
      const authorizer = createAbacAuthorizer(await bindPolicies([
        makePolicy({ id: "deny", effect: "deny", priority: 10, actions: ["read"], when: Predicate.lt("st", literal) }),
        makePolicy({ id: "allow", effect: "allow", priority: 1, actions: ["read"] }),
      ]))
      const scope = authorizer.authorizeCollection("read").scope
      const allowed = all.filter((row) => authorizer.canRecordAction("read", row)).map((row) => row.id).sort((a, b) => a - b)
      expect(allowed.length).toBeGreaterThan(0)
      expect(allowed.length).toBeLessThan(all.length)
      expect(await ids(scope), literal).toEqual(allowed)
    }
  })

  it("never sends a temporal literal PostgreSQL would reject", async () => {
    const nonNull = ROWS
    expect(await ids(Predicate.eq("day", "0000-01-01"))).toEqual([])
    expect(await ids(Predicate.gt("day", "0000-01-01"))).toHaveLength(nonNull)
    expect(await ids(Predicate.gt("at", "9999-12-31T23:00:00-05:00"))).toEqual([])
    expect(await ids(Predicate.lt("at", "0000-06-01T00:00:00Z"))).toEqual([])
    for (const literal of ["2024-01-01 10:00:00+99", "2024-01-01 10:00:00+16:00", "0000-12-31 10:00:00+00"]) {
      await expect(ids(Predicate.gt("at", literal))).resolves.toBeDefined()
    }
    expect(await ids(Predicate.eq("at", "2024-01-01 15:59:00+05:59"))).toEqual([1])
  })

  it("plans index scans for date, timestamptz, enum and text predicates", async () => {
    const filters: PredicateNode[] = [
      predicateFromFilterCondition({ field: "day", operator: "eq", value: "2024-01-01" }, undefined, { day: { kind: "date" } })!,
      Predicate.between("at", { from: "2024-01-01T00:00:00Z", to: "2024-01-01T23:59:59.999Z" }),
      Predicate.eq("st", "draft"),
      Predicate.eq("name", "probe"),
    ]
    const client = await pool.connect()
    try {
      await client.query("SET enable_seqscan = off")
      for (const filter of filters) {
        const query = db.select({ id: rows.id }).from(rows).where(compiler.compileWhere(filter)).toSQL()
        const plan = (await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${query.sql}`, query.params)).rows.map((row) => row["QUERY PLAN"]).join("\n")
        expect(plan, `${JSON.stringify(filter)}\n${plan}`).toMatch(/Index/)
        expect(plan).not.toMatch(/Seq Scan/)
      }
    } finally {
      await client.query("RESET enable_seqscan").catch(() => undefined)
      client.release()
    }
  })

  it("the repository's filtered reads go through the index-usable form", async () => {
    const entity = { name: "TemporalRow", primaryKey: "id", fields: { id: { type: "integer" }, day: { type: "date" }, at: { type: "datetime" }, st: { type: "enum" }, name: { type: "string" } } } as unknown as UnversionedEntityDescriptor<Record<string, unknown>>
    const repository = createDrizzleRepository<Record<string, unknown>, number>({ db: db as never, table: rows, entity, columnMap })
    const filter = predicateFromFilterCondition({ field: "day", operator: "eq", value: "2024-01-01" }, undefined, { day: { kind: "date" } })!
    expect((await repository.findMany({ filter })).rows.map((row) => row.id)).toContain(1)
  })
})
