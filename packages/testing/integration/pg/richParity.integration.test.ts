import { afterAll, beforeAll, describe, expect, it } from "vitest"
import pg from "pg"
import { drizzle } from "drizzle-orm/node-postgres"
import { boolean, date, doublePrecision, inet, integer, numeric, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { compileDrizzlePredicate, createDrizzleRepository } from "adapters/drizzle-pg"
import type { UnversionedEntityDescriptor } from "core/persistence"
import { ABAC_RUNS, PREDICATE_RUNS, checkAbacScopeParity, checkPredicateParity, generateDataset, orderingReports, type ExtraField, orderingVerdict, roundTripMismatches, summary, type ParityDriver, type ParityRecord } from "../shared/richParity.js"
import { pgCertificationUrl } from "./database.js"

const TABLE = "fw_rich_parity"
const STATUS_TYPE = "fw_rich_parity_status"
/** Declaration order deliberately differs from code-point order. */
const STATUS_VALUES = ["locked", "draft", "Active", "archived"] as const
const status = pgEnum(STATUS_TYPE, STATUS_VALUES)

/**
 * PostgreSQL-only columns: an enum (native declaration order: equality is
 * checked against core, ordering and cursor pages against the repository's
 * own ORDER BY) and inet (compared and sorted by its text form, like core).
 */
const EXTRA_FIELDS: readonly ExtraField[] = [
  { key: "status", values: STATUS_VALUES, literals: [...STATUS_VALUES, "zzz", "", "Draft", "act"], order: "native" },
  { key: "addr", values: ["10.0.0.1", "10.0.0.10", "10.0.0.2", "192.168.0.1", "::1", "2001:db8::1", "10.0.0.0/8"], literals: ["10.0.0.1", "10.0.0.10", "10.0.0.2", "::1", "10.0.0.0/8", "10.0.0", "1", "", "abc"], order: "core" },
]

const rows = pgTable(TABLE, {
  id: integer("id").primaryKey(),
  name: text("name"),
  code: text("code"),
  ownerId: text("owner_id"),
  amount: doublePrecision("amount"),
  rank: doublePrecision("rank"),
  active: boolean("active"),
  // Drizzle's default PostgreSQL date mode is "string": rows hydrate as YYYY-MM-DD.
  dueOn: date("due_on"),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date", precision: 3 }),
  tags: text("tags").array(),
  // NUMERIC is returned as a string by the driver; the entity declares a number.
  price: numeric("price", { precision: 40, scale: 20 }),
  status: status("status"),
  addr: inet("addr"),
})

const columnMap = {
  id: rows.id, name: rows.name, code: rows.code, ownerId: rows.ownerId, amount: rows.amount, rank: rows.rank, active: rows.active,
  dueOn: rows.dueOn, updatedAt: rows.updatedAt, tags: rows.tags, price: rows.price, status: rows.status, addr: rows.addr,
}

const entity = {
  name: "RichParityRow",
  primaryKey: "id",
  fields: {
    id: { type: "integer" }, name: { type: "string", nullable: true }, code: { type: "string", nullable: true }, ownerId: { type: "string", nullable: true },
    amount: { type: "number", nullable: true }, rank: { type: "number", nullable: true }, active: { type: "boolean", nullable: true },
    dueOn: { type: "date", nullable: true }, updatedAt: { type: "datetime", nullable: true }, tags: { type: "json", nullable: true }, price: { type: "decimal", nullable: true },
    status: { type: "enum", nullable: true, enumValues: STATUS_VALUES }, addr: { type: "string", nullable: true },
  },
} as unknown as UnversionedEntityDescriptor<ParityRecord>

function hydrate(row: Record<string, unknown>): ParityRecord {
  return { ...row, price: row.price === null || row.price === undefined ? null : Number(row.price) } as unknown as ParityRecord
}

const dataset = generateDataset(undefined, undefined, EXTRA_FIELDS)

async function openVariant(collation: string | null): Promise<{ pool: pg.Pool; driver: ParityDriver }> {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 2 })
  const textType = `text${collation ? ` COLLATE "${collation}"` : ""}`
  await pool.query(`DROP TABLE IF EXISTS ${TABLE}`)
  await pool.query(`DROP TYPE IF EXISTS ${STATUS_TYPE}`)
  await pool.query(`CREATE TYPE ${STATUS_TYPE} AS ENUM (${STATUS_VALUES.map((value) => `'${value}'`).join(", ")})`)
  await pool.query(`CREATE TABLE ${TABLE} (id integer PRIMARY KEY, name ${textType}, code ${textType}, owner_id ${textType}, amount double precision, rank double precision, active boolean, due_on date, updated_at timestamptz(3), tags text[], price numeric(40,20), status ${STATUS_TYPE}, addr inet)`)
  const db = drizzle(pool)
  await db.insert(rows).values(dataset.map((record) => ({ ...record, price: record.price === null ? null : String(record.price) }) as typeof rows.$inferInsert))
  const repository = createDrizzleRepository<ParityRecord, number>({ db: db as never, table: rows, entity, columnMap, maxPageSize: 10_000 })
  return {
    pool,
    driver: {
      label: `PostgreSQL${collation ? ` ${collation}` : ""}`,
      explicitNulls: true,
      extraFields: EXTRA_FIELDS,
      async findMany(options) {
        const result = await repository.findMany(options)
        return { ...result, rows: result.rows.map(hydrate) }
      },
      async selectIds(filter) {
        return (await db.select({ id: rows.id }).from(rows).where(compileDrizzlePredicate(filter, columnMap))).map((row) => row.id)
      },
    },
  }
}

for (const collation of [null, "en-US-x-icu"] as const) {
  describe(`real-database differential vs core (PostgreSQL, ${collation ?? "database default"} collation)`, () => {
    let pool: pg.Pool
    let driver: ParityDriver
    let stored: ParityRecord[]

    beforeAll(async () => {
      ({ pool, driver } = await openVariant(collation))
      stored = (await driver.findMany({ pagination: { kind: "offset", page: 1, pageSize: 10_000 } })).rows
    }, 60_000)

    afterAll(async () => {
      await pool.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => undefined)
      await pool.query(`DROP TYPE IF EXISTS ${STATUS_TYPE}`).catch(() => undefined)
      await pool.end()
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
}
