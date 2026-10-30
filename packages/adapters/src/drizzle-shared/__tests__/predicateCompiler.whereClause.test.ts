import { describe, expect, it } from "vitest"
import { sql, type SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core/dialect"
import { pgTable, text } from "drizzle-orm/pg-core"
import { Predicate } from "@xonava/core/domain"
import type { PredicateNode } from "@xonava/core/domain"
import { DrizzlePredicateCompiler, compileDrizzlePredicate, compileWhereClause, type DrizzleWhereCompiler } from "../predicateCompiler"

const pg = new PgDialect()
const rows = pgTable("rows", { name: text("name") })
const map = { name: rows.name }
const text_ = (expression: SQL<unknown>) => {
  const query = pg.sqlToQuery(expression)
  return { sql: query.sql, params: query.params }
}

describe("WHERE-clause compilation keeps the row filter and its three-valued shape", () => {
  const compiler = new DrizzlePredicateCompiler(map, { dialect: "postgres" })

  it("compile() is strictly two-valued for conditions and composites, and leaves literals bare", () => {
    expect(text_(compiler.compile(Predicate.eq("name", "a")))).toEqual({ sql: 'COALESCE("rows"."name" = $1, FALSE)', params: ["a"] })
    expect(text_(compiler.compile(Predicate.not(Predicate.eq("name", "a"))))).toEqual({ sql: 'COALESCE(not "rows"."name" = $1, FALSE)', params: ["a"] })
    expect(text_(compiler.compile(Predicate.literal(true)))).toEqual({ sql: "1 = 1", params: [] })
    expect(text_(compiler.compile(Predicate.literal(false)))).toEqual({ sql: "1 = 0", params: [] })
  })

  it("compileWhere() wraps the three-valued root in parentheses (no COALESCE) and leaves literals bare", () => {
    expect(text_(compiler.compileWhere(Predicate.eq("name", "a")))).toEqual({ sql: '("rows"."name" = $1)', params: ["a"] })
    expect(text_(compiler.compileWhere(Predicate.isNull("name")))).toEqual({ sql: '("rows"."name" is null)', params: [] })
    expect(text_(compiler.compileWhere(Predicate.literal(true)))).toEqual({ sql: "1 = 1", params: [] })
    expect(text_(compiler.compileWhere(Predicate.literal(false)))).toEqual({ sql: "1 = 0", params: [] })
  })

  it("a subclass overriding compile() keeps control of its WHERE clauses", () => {
    class Tenant extends DrizzlePredicateCompiler {
      override compile(filter: PredicateNode): SQL<unknown> {
        return sql`(${super.compile(filter)} and tenant_id = ${"t1"})`
      }
    }
    const scoped = new Tenant(map, { dialect: "postgres" })
    const expected = { sql: '(COALESCE("rows"."name" = $1, FALSE) and tenant_id = $2)', params: ["a", "t1"] }
    expect(text_(scoped.compileWhere(Predicate.eq("name", "a")))).toEqual(expected)
    expect(text_(compileWhereClause(scoped, Predicate.eq("name", "a")))).toEqual(expected)
    // Literals too: the override still applies.
    expect(text_(scoped.compileWhere(Predicate.literal(true)))).toEqual({ sql: "(1 = 1 and tenant_id = $1)", params: ["t1"] })
  })

  it("compileWhereClause() uses compileWhere when offered, compile otherwise", () => {
    expect(text_(compileWhereClause(compiler, Predicate.eq("name", "a")))).toEqual({ sql: '("rows"."name" = $1)', params: ["a"] })
    const compileOnly: DrizzleWhereCompiler = { compile: () => sql`compiled` }
    expect(text_(compileWhereClause(compileOnly, Predicate.literal(true)))).toEqual({ sql: "compiled", params: [] })
    const notAFunction = { compile: () => sql`compiled`, compileWhere: "nope" } as unknown as DrizzleWhereCompiler
    expect(text_(compileWhereClause(notAFunction, Predicate.literal(true)))).toEqual({ sql: "compiled", params: [] })
    const both: DrizzleWhereCompiler = { compile: () => sql`compiled`, compileWhere: () => sql`where` }
    expect(text_(compileWhereClause(both, Predicate.literal(true)))).toEqual({ sql: "where", params: [] })
  })

  it("compileDrizzlePredicate() defaults to the generic dialect and rejects unmapped fields", () => {
    expect(text_(compileDrizzlePredicate(Predicate.contains("name", "a_"), map))).toEqual({ sql: `COALESCE("rows"."name" LIKE $1 ESCAPE '\\', FALSE)`, params: ["%a\\_%"] })
    expect(() => compileDrizzlePredicate(Predicate.eq("other", "a"), map)).toThrow('Predicate references unmapped field "other"')
    expect(() => compileDrizzlePredicate(Predicate.eq("toString", "a"), map)).toThrow('Predicate references unmapped field "toString"')
    expect(() => compileDrizzlePredicate(Predicate.eq("name", "a"), { name: undefined as never })).toThrow('Predicate references unmapped field "name"')
  })
})
