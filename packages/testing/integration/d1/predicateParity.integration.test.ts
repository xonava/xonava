import { describe, expect, it } from "vitest"
import { Miniflare } from "miniflare"
import { drizzle } from "drizzle-orm/d1"
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Predicate, evaluatePredicate, type PredicateNode, type PredicatePrimitive } from "core/domain"
import { compileDrizzlePredicate } from "adapters/drizzle-d1"

/**
 * Differential test for the normative predicate semantics: the core in-memory
 * evaluator and the compiled SQL must select exactly the same rows for every
 * generated predicate, including NULLs, negation, and non-ASCII ordering.
 */
const rows = sqliteTable("parity_rows", {
  id: integer("id").primaryKey(),
  n: real("n"),
  s: text("s"),
  b: integer("b", { mode: "boolean" }),
})
const columnMap = { n: rows.n, s: rows.s, b: rows.b }

const NUMBERS = [null, -2, 0, 1, 2.5, 10] as const
const STRINGS = [null, "", "a", "A", "ab", "Ab", "b", "é", "z", "😀", "a%_\\"] as const
const BOOLEANS = [null, true, false] as const

interface Row { id: number; n: number | null; s: string | null; b: boolean | null }

function dataset(): Row[] {
  const out: Row[] = []
  let id = 1
  for (const n of NUMBERS) for (const s of STRINGS) for (const b of BOOLEANS) out.push({ id: id++, n, s, b })
  return out
}

function generator(seed: number) {
  let state = seed >>> 0
  const next = (): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state }
  const pick = <T>(values: readonly T[]): T => values[next() % values.length]!
  const nonNull = <T>(values: readonly (T | null)[]): T[] => values.filter((value): value is T => value !== null)
  const condition = (): PredicateNode => {
    const field = pick(["n", "s", "b"] as const)
    if (field === "b") return pick([
      () => Predicate.isTrue("b"), () => Predicate.isFalse("b"), () => Predicate.isNull("b"), () => Predicate.isNotNull("b"),
      () => Predicate.eq("b", pick(BOOLEANS)), () => Predicate.neq("b", pick(BOOLEANS)),
    ])()
    const values = (field === "n" ? NUMBERS : STRINGS) as readonly PredicatePrimitive[]
    const scalars = nonNull(values)
    const common = [
      () => Predicate.eq(field, pick(values)), () => Predicate.neq(field, pick(values)),
      () => Predicate.gt(field, pick(scalars)), () => Predicate.lt(field, pick(scalars)),
      () => Predicate.gte(field, pick(scalars)), () => Predicate.lte(field, pick(scalars)),
      () => Predicate.between(field, { from: pick(scalars), to: pick(scalars) }),
      () => Predicate.between(field, { from: pick(scalars) }),
      () => Predicate.in(field, [pick(values), pick(values), pick(values)]),
      () => Predicate.in(field, []),
      () => Predicate.isNull(field), () => Predicate.isNotNull(field),
    ]
    const strings = field === "s" ? [
      () => Predicate.contains("s", pick(nonNull(STRINGS))), () => Predicate.startsWith("s", pick(nonNull(STRINGS))),
      () => Predicate.endsWith("s", pick(nonNull(STRINGS))), () => Predicate.isEmpty("s"), () => Predicate.isNotEmpty("s"),
    ] : []
    return pick([...common, ...strings])()
  }
  const node = (depth: number): PredicateNode => {
    const roll = next() % 10
    if (depth >= 3 || roll < 4) return condition()
    if (roll < 6) return Predicate.not(node(depth + 1))
    const children = Array.from({ length: 1 + (next() % 3) }, () => node(depth + 1))
    return roll < 8 ? Predicate.and(...children) : Predicate.or(...children)
  }
  return () => node(0)
}

describe("predicate semantics parity: core evaluator vs compiled SQL (SQLite/D1)", () => {
  it("selects identical rows for 1500 generated predicates", async () => {
    const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", compatibilityDate: "2025-09-01", d1Databases: { DB: "predicate-parity" } })
    try {
      const d1 = await mf.getD1Database("DB")
      await d1.exec("CREATE TABLE parity_rows (id INTEGER PRIMARY KEY, n REAL, s TEXT, b INTEGER)")
      const data = dataset()
      const db = drizzle(d1 as never)
      for (let index = 0; index < data.length; index += 20) await db.insert(rows).values(data.slice(index, index + 20))
      const next = generator(0x5eed2026)
      const mismatches: string[] = []
      for (let iteration = 0; iteration < 1500 && mismatches.length < 5; iteration++) {
        const predicate = next()
        const expected = data.filter((row) => evaluatePredicate(row as unknown as Record<string, unknown>, predicate)).map((row) => row.id)
        const selected = await db.select({ id: rows.id }).from(rows).where(compileDrizzlePredicate(predicate, columnMap)).orderBy(rows.id)
        const actual = selected.map((row) => row.id)
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          mismatches.push(`${JSON.stringify(predicate)}\n  js:  ${JSON.stringify(expected)}\n  sql: ${JSON.stringify(actual)}`)
        }
      }
      expect(mismatches, mismatches.join("\n")).toEqual([])
    } finally {
      await mf.dispose()
    }
  }, 120_000)
})
