import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Miniflare } from "miniflare"
import { ASYNC_D1_WORKER_SCRIPT, asyncD1Binding } from "./asyncD1.js"
import { drizzle } from "drizzle-orm/d1"
import { integer, numeric, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { compileDrizzlePredicate, createDrizzleRepository } from "@xonava/adapters/drizzle-d1"
import type { UnversionedEntityDescriptor } from "@xonava/core/persistence"
import { tolerateStaleConnections } from "./staleConnection.js"
import { checkAbacScopeParity, checkPredicateParity, generateDataset, orderingReports, orderingVerdict, roundTripMismatches, summary, type ParityDriver, type ParityRecord } from "../shared/richParity.js"

const TABLE = "fw_rich_parity"

const rows = sqliteTable(TABLE, {
  id: integer("id").primaryKey(),
  name: text("name"),
  code: text("code"),
  ownerId: text("owner_id"),
  amount: real("amount"),
  rank: real("rank"),
  active: integer("active", { mode: "boolean" }),
  // SQLite has no date type: dates are stored and hydrated as YYYY-MM-DD text.
  dueOn: text("due_on"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  tags: text("tags", { mode: "json" }),
  // NUMERIC affinity; drizzle returns strings, the entity declares a number.
  price: numeric("price"),
})

const columnMap = {
  id: rows.id, name: rows.name, code: rows.code, ownerId: rows.ownerId, amount: rows.amount, rank: rows.rank, active: rows.active,
  dueOn: rows.dueOn, updatedAt: rows.updatedAt, tags: rows.tags, price: rows.price,
}

const entity = {
  name: "RichParityRow",
  primaryKey: "id",
  fields: {
    id: { type: "integer" }, name: { type: "string", nullable: true }, code: { type: "string", nullable: true }, ownerId: { type: "string", nullable: true },
    amount: { type: "number", nullable: true }, rank: { type: "number", nullable: true }, active: { type: "boolean", nullable: true },
    dueOn: { type: "date", nullable: true }, updatedAt: { type: "datetime", nullable: true }, tags: { type: "json", nullable: true }, price: { type: "decimal", nullable: true },
  },
} as unknown as UnversionedEntityDescriptor<ParityRecord>

function hydrate(row: Record<string, unknown>): ParityRecord {
  return { ...row, price: row.price === null || row.price === undefined ? null : Number(row.price) } as unknown as ParityRecord
}

const dataset = generateDataset()

/** Miniflare round trips are ~20x slower than a local server; fewer cases keep the suite near a minute. */
const PREDICATE_RUNS = 700
const ABAC_RUNS = 300

describe("real-database differential vs core (SQLite/D1)", () => {
  let mf: Miniflare
  let driver: ParityDriver
  let stored: ParityRecord[]

  beforeAll(async () => {
    mf = new Miniflare({ modules: true, script: ASYNC_D1_WORKER_SCRIPT, compatibilityDate: "2025-09-01", d1Databases: { DB: "rich-parity" } })
    const d1 = tolerateStaleConnections(asyncD1Binding(mf))
    await d1.exec(`DROP TABLE IF EXISTS ${TABLE}`)
    await d1.exec(`CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY, name TEXT, code TEXT, owner_id TEXT, amount REAL, rank REAL, active INTEGER, due_on TEXT, updated_at INTEGER, tags TEXT, price NUMERIC)`)
    const db = drizzle(d1 as never)
    const values = dataset.map((record) => ({ ...record, price: record.price === null ? null : String(record.price) }) as unknown as typeof rows.$inferInsert)
    // D1 binds at most 100 parameters per statement.
    for (let index = 0; index < values.length; index += 8) await db.insert(rows).values(values.slice(index, index + 8))
    const repository = createDrizzleRepository<ParityRecord, number>({ db: db as never, table: rows, entity, columnMap, maxPageSize: 10_000 })
    driver = {
      label: "SQLite/D1",
      explicitNulls: true,
      // Each Miniflare D1 round trip costs ~25ms: larger pages, still crossing every NULL boundary.
      pageSize: 40,
      async findMany(options) {
        const result = await repository.findMany(options)
        return { ...result, rows: result.rows.map(hydrate) }
      },
      async selectIds(filter) {
        return (await db.select({ id: rows.id }).from(rows).where(compileDrizzlePredicate(filter, columnMap))).map((row) => row.id)
      },
    }
    stored = (await driver.findMany({ pagination: { kind: "offset", page: 1, pageSize: 10_000 } })).rows
  }, 60_000)

  afterAll(async () => {
    await mf?.dispose()
  })

  it("stores and reads back every generated value unchanged", async () => {
    const mismatches = await roundTripMismatches(driver, dataset)
    expect(mismatches, mismatches.join("\n")).toEqual([])
  })

  it("selects exactly the rows core accepts for every generated predicate", async () => {
    console.info(summary(`${driver.label} predicates`, await checkPredicateParity(driver, stored, PREDICATE_RUNS)))
  }, 300_000)

  it("orders and cursor-paginates every scalar field exactly as core compares", async () => {
    const verdict = orderingVerdict(await orderingReports(driver, stored), () => false)
    expect(verdict.unexpected, verdict.unexpected.join("\n")).toEqual([])
  }, 300_000)

  it("selects exactly the rows the ABAC record decision allows through the compiled action scope", async () => {
    console.info(summary(`${driver.label} ABAC`, await checkAbacScopeParity(driver, stored, ABAC_RUNS)))
  }, 300_000)
})
