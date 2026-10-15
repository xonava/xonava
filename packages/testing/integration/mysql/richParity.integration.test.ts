import { afterAll, beforeAll, describe, expect, it } from "vitest"
import mysql from "mysql2/promise"
import { drizzle } from "drizzle-orm/mysql2"
import { boolean, date, datetime, decimal, double, int, json, mysqlTable, varchar } from "drizzle-orm/mysql-core"
import { assertMySqlBinaryCollation, compileDrizzlePredicate, createDrizzleMySqlRepository } from "@xonava/adapters/drizzle-mysql"
import type { UnversionedEntityDescriptor } from "@xonava/core/persistence"
import { ABAC_RUNS, PREDICATE_RUNS, checkAbacScopeParity, checkPredicateParity, generateDataset, orderingReports, orderingVerdict, roundTripMismatches, summary, type ParityDriver, type ParityRecord } from "../shared/richParity.js"
import { mysqlCertificationUrl } from "./database.js"

const TABLE = "fw_rich_parity"

const rows = mysqlTable(TABLE, {
  id: int("id").primaryKey(),
  name: varchar("name", { length: 64 }),
  code: varchar("code", { length: 64 }),
  ownerId: varchar("owner_id", { length: 64 }),
  amount: double("amount"),
  rank: double("rank"),
  active: boolean("active"),
  // Drizzle's default MySQL date mode is "date": rows hydrate as UTC-midnight Dates.
  dueOn: date("due_on"),
  updatedAt: datetime("updated_at", { mode: "date", fsp: 3 }),
  tags: json("tags"),
  // DECIMAL is returned as a string by the driver; the entity declares a number.
  price: decimal("price", { precision: 40, scale: 20 }),
})

const columnMap = {
  id: rows.id, name: rows.name, code: rows.code, ownerId: rows.ownerId, amount: rows.amount, rank: rows.rank, active: rows.active,
  dueOn: rows.dueOn, updatedAt: rows.updatedAt, tags: rows.tags, price: rows.price,
}
const TEXT_COLUMNS = ["name", "code", "owner_id"]

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

interface Variant {
  readonly collation: string
  /** Compare character columns directly (only valid on a verified NO PAD binary collation). */
  readonly binaryCollation: boolean
}

const VARIANTS: readonly Variant[] = [
  // Server default: case- and accent-insensitive; the compiler converts to utf8mb4_0900_bin.
  { collation: "utf8mb4_0900_ai_ci", binaryCollation: false },
  // NO PAD binary: verified by assertMySqlBinaryCollation, compared directly.
  { collation: "utf8mb4_0900_bin", binaryCollation: true },
  // PAD SPACE binary: rejected by the assertion, still exact through conversion.
  { collation: "utf8mb4_bin", binaryCollation: false },
]

async function openVariant(variant: Variant): Promise<{ pool: mysql.Pool; driver: ParityDriver }> {
  const url = new URL(mysqlCertificationUrl())
  const pool = mysql.createPool({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1), connectionLimit: 2, charset: "utf8mb4", timezone: "Z" })
  const text = `VARCHAR(64) CHARACTER SET utf8mb4 COLLATE ${variant.collation} NULL`
  await pool.query(`DROP TABLE IF EXISTS ${TABLE}`)
  await pool.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, name ${text}, code ${text}, owner_id ${text}, amount DOUBLE NULL, \`rank\` DOUBLE NULL, active BOOLEAN NULL, due_on DATE NULL, updated_at DATETIME(3) NULL, tags JSON NULL, price DECIMAL(40,20) NULL) ENGINE=InnoDB`)
  const db = drizzle(pool)
  await db.insert(rows).values(dataset.map((record) => ({ ...record, price: record.price === null ? null : String(record.price) }) as unknown as typeof rows.$inferInsert))
  const repository = createDrizzleMySqlRepository<ParityRecord, number>({ db, table: rows, entity, columnMap, maxPageSize: 10_000, mysqlBinaryCollation: variant.binaryCollation })
  const options = { mysqlBinaryCollation: variant.binaryCollation }
  return {
    pool,
    driver: {
      label: `MySQL ${variant.collation}${variant.binaryCollation ? " (direct)" : ""}`,
      explicitNulls: false,
      async findMany(query) {
        const result = await repository.findMany(query)
        return { ...result, rows: result.rows.map(hydrate) }
      },
      async selectIds(filter) {
        return (await db.select({ id: rows.id }).from(rows).where(compileDrizzlePredicate(filter, columnMap, options))).map((row) => row.id)
      },
    },
  }
}

for (const variant of VARIANTS) {
  describe(`real-database differential vs core (MySQL, ${variant.collation}${variant.binaryCollation ? ", direct comparison" : ""})`, () => {
    let pool: mysql.Pool
    let driver: ParityDriver
    let stored: ParityRecord[]

    beforeAll(async () => {
      ({ pool, driver } = await openVariant(variant))
      stored = (await driver.findMany({ pagination: { kind: "offset", page: 1, pageSize: 10_000 } })).rows
    }, 60_000)

    afterAll(async () => {
      await pool.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => undefined)
      await pool.end()
    })

    it("accepts direct comparison only on a NO PAD binary collation", async () => {
      const check = assertMySqlBinaryCollation(pool, TABLE, TEXT_COLUMNS)
      if (variant.collation === "utf8mb4_0900_bin") await expect(check).resolves.toBeUndefined()
      else await expect(check).rejects.toThrow(variant.collation === "utf8mb4_bin" ? "PAD SPACE" : "non-binary collation")
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
