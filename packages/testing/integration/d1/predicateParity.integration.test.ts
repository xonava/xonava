import { describe, expect, it } from "vitest"
import { Miniflare } from "miniflare"
import { drizzle } from "drizzle-orm/d1"
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { compileDrizzlePredicate } from "adapters/drizzle-d1"
import { tolerateStaleConnections } from "./staleConnection.js"
import { findParityMismatches, parityDataset } from "../shared/predicateParity.js"

const rows = sqliteTable("parity_rows", { id: integer("id").primaryKey(), n: real("n"), s: text("s"), b: integer("b", { mode: "boolean" }) })
const columnMap = { n: rows.n, s: rows.s, b: rows.b }

describe("predicate semantics parity: core evaluator vs compiled SQL (SQLite/D1)", () => {
  it("selects identical rows for every generated predicate", async () => {
    const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", compatibilityDate: "2025-09-01", d1Databases: { DB: "predicate-parity" } })
    try {
      const d1 = tolerateStaleConnections(await mf.getD1Database("DB"))
      await d1.exec("CREATE TABLE parity_rows (id INTEGER PRIMARY KEY, n REAL, s TEXT, b INTEGER)")
      const db = drizzle(d1 as never)
      const data = parityDataset()
      for (let index = 0; index < data.length; index += 20) await db.insert(rows).values(data.slice(index, index + 20))
      const mismatches = await findParityMismatches(async (predicate) => (await db.select({ id: rows.id }).from(rows).where(compileDrizzlePredicate(predicate, columnMap))).map((row) => row.id))
      expect(mismatches, mismatches.join("\n")).toEqual([])
    } finally {
      await mf.dispose()
    }
  }, 120_000)
})
