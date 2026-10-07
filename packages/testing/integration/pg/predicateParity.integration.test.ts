import { describe, expect, it } from "vitest"
import pg from "pg"
import { drizzle } from "drizzle-orm/node-postgres"
import { boolean, doublePrecision, integer, pgTable, text } from "drizzle-orm/pg-core"
import { compileDrizzlePredicate } from "adapters/drizzle-pg"
import { findParityMismatches, parityDataset } from "../shared/predicateParity.js"
import { pgCertificationUrl } from "./database.js"

const rows = pgTable("framework_predicate_parity", { id: integer("id").primaryKey(), n: doublePrecision("n"), s: text("s"), b: boolean("b") })
const columnMap = { n: rows.n, s: rows.s, b: rows.b }

async function parity(collation: string | null): Promise<string[]> {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 2 })
  try {
    await pool.query("DROP TABLE IF EXISTS framework_predicate_parity")
    // A locale collation (the production default for many clusters) must not change predicate results.
    await pool.query(`CREATE TABLE framework_predicate_parity (id integer PRIMARY KEY, n double precision, s text${collation ? ` COLLATE "${collation}"` : ""}, b boolean)`)
    const db = drizzle(pool)
    await db.insert(rows).values(parityDataset())
    return await findParityMismatches(async (predicate) => (await db.select({ id: rows.id }).from(rows).where(compileDrizzlePredicate(predicate, columnMap))).map((row) => row.id))
  } finally {
    await pool.query("DROP TABLE IF EXISTS framework_predicate_parity").catch(() => undefined)
    await pool.end()
  }
}

describe("predicate semantics parity: core evaluator vs compiled SQL (PostgreSQL)", () => {
  it("selects identical rows with the database default collation", async () => {
    const mismatches = await parity(null)
    expect(mismatches, mismatches.join("\n")).toEqual([])
  }, 120_000)

  it("selects identical rows when the column uses an ICU locale collation", async () => {
    const mismatches = await parity("und-x-icu")
    expect(mismatches, mismatches.join("\n")).toEqual([])
  }, 120_000)
})
