import { describe, expect, it } from "vitest"
import { PgDialect } from "drizzle-orm/pg-core/dialect"
import { Predicate, simplifyPredicate } from "core/domain"
import { compileDrizzlePredicate } from "adapters/drizzle-pg"
import { integer, pgTable, text } from "drizzle-orm/pg-core"

const dialect = new PgDialect()

const predicateTable = pgTable("predicate_table", {
  status: text("status"),
  value: integer("value"),
})

const columnMap = {
  status: predicateTable.status,
  value: predicateTable.value,
}

describe("drizzle predicate compiler", () => {
  it("compiles literal nodes, including literals produced by simplification", () => {
    const trueQuery = dialect.sqlToQuery(compileDrizzlePredicate(Predicate.literal(true), {}))
    const falseQuery = dialect.sqlToQuery(compileDrizzlePredicate(Predicate.literal(false), {}))
    const simplifiedTrue = simplifyPredicate(Predicate.or(Predicate.eq("status", "active"), Predicate.literal(true)))
    const simplifiedFalse = simplifyPredicate(Predicate.and(Predicate.eq("status", "active"), Predicate.literal(false)))

    expect(trueQuery).toEqual({ sql: "1 = 1", params: [] })
    expect(falseQuery).toEqual({ sql: "1 = 0", params: [] })
    expect(dialect.sqlToQuery(compileDrizzlePredicate(simplifiedTrue, {}))).toEqual({ sql: "1 = 1", params: [] })
    expect(dialect.sqlToQuery(compileDrizzlePredicate(simplifiedFalse, {}))).toEqual({ sql: "1 = 0", params: [] })
  })

  it("rejects includesAll instead of compiling non-portable array SQL", () => {
    expect(() => compileDrizzlePredicate(Predicate.includesAll("status", ["active"]), columnMap)).toThrow(
      "Unsupported predicate operator: includesAll",
    )
  })

  it("fails closed for an empty between range while preserving open bounds", () => {
    const empty = dialect.sqlToQuery(compileDrizzlePredicate({ kind: "condition", field: "value", op: "between", value: {} }, columnMap))
    const lowerOnly = dialect.sqlToQuery(compileDrizzlePredicate(Predicate.between("value", { from: 10 }), columnMap))
    const upperOnly = dialect.sqlToQuery(compileDrizzlePredicate(Predicate.between("value", { to: 10 }), columnMap))

    expect(empty).toEqual({ sql: 'COALESCE(1 = 0, FALSE)', params: [] })
    expect(lowerOnly.params).toEqual([10])
    expect(upperOnly.params).toEqual([10])
  })

  it("keeps NULL membership and scalar emptiness SQL-compatible", () => {
    expect(dialect.sqlToQuery(compileDrizzlePredicate(Predicate.in("status", [null, "active"]), columnMap))).toMatchObject({
      params: ["active"],
    })
    expect(dialect.sqlToQuery(compileDrizzlePredicate(Predicate.isEmpty("status"), columnMap))).toMatchObject({
      params: [""],
    })
  })

  it("does not resolve inherited column-map fields", () => {
    expect(() => compileDrizzlePredicate(Predicate.eq("toString", "x"), {})).toThrow("unmapped field")
    const prototypeFieldMap = Object.create(null) as Parameters<typeof compileDrizzlePredicate>[1]
    Reflect.set(prototypeFieldMap, "toString", predicateTable.status)
    expect(dialect.sqlToQuery(compileDrizzlePredicate(Predicate.eq("toString", "x"), prototypeFieldMap)).sql).toContain("status")
  })
})
