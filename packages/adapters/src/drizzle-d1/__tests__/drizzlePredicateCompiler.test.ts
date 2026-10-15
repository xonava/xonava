import { describe, expect, it } from "vitest"
import { SQLiteSyncDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Predicate, simplifyPredicate } from "@xonava/core/domain"
import { compileDrizzlePredicate } from "@xonava/adapters/drizzle-d1"

const drugFormulary = sqliteTable("drug_formulary", {
  id: text("id"),
  tenantId: text("tenant_id"),
  genericName: text("generic_name"),
  status: text("status"),
})

const columnMap = {
  id: drugFormulary.id,
  tenantId: drugFormulary.tenantId,
  genericName: drugFormulary.genericName,
  status: drugFormulary.status,
}

const dialect = new SQLiteSyncDialect()

describe("drizzle predicate compiler", () => {
  it("compiles nested predicates to SQL", () => {
    const predicate = Predicate.and(
      Predicate.eq("tenantId", "tenant-1"),
      Predicate.or(
        Predicate.contains("genericName", "aspirin"),
        Predicate.eq("status", "active"),
      ),
    )

    const compiled = compileDrizzlePredicate(predicate, columnMap)
    const query = dialect.sqlToQuery(compiled)

    expect(query.sql).toContain("tenant_id")
    expect(query.sql).toContain("generic_name")
    expect(query.sql).toContain("status")
    expect(query.sql).toContain("instr(")
    expect(query.params).toEqual(["tenant-1", "aspirin", "active"])
  })

  it("compiles between and array predicates", () => {
    const predicate = Predicate.and(
      Predicate.between("id", ["a", "z"]),
      Predicate.in("status", ["active", "inactive"]),
    )

    const compiled = compileDrizzlePredicate(predicate, columnMap)
    const query = dialect.sqlToQuery(compiled)

    expect(query.params).toEqual(["a", "z", "active", "inactive"])
  })

  it("compiles literal nodes, including literals produced by simplification", () => {
    const trueQuery = dialect.sqlToQuery(compileDrizzlePredicate(Predicate.literal(true), columnMap))
    const falseQuery = dialect.sqlToQuery(compileDrizzlePredicate(Predicate.literal(false), columnMap))
    const simplifiedTrue = simplifyPredicate(Predicate.or(Predicate.eq("status", "active"), Predicate.literal(true)))
    const simplifiedFalse = simplifyPredicate(Predicate.and(Predicate.eq("status", "active"), Predicate.literal(false)))

    expect(trueQuery).toEqual({ sql: "1 = 1", params: [] })
    expect(falseQuery).toEqual({ sql: "1 = 0", params: [] })
    expect(dialect.sqlToQuery(compileDrizzlePredicate(simplifiedTrue, columnMap))).toEqual({ sql: "1 = 1", params: [] })
    expect(dialect.sqlToQuery(compileDrizzlePredicate(simplifiedFalse, columnMap))).toEqual({ sql: "1 = 0", params: [] })
  })

  it("uses SQL null semantics and escapes LIKE metacharacters", () => {
    const nullQuery = dialect.sqlToQuery(compileDrizzlePredicate(Predicate.eq("status", null), columnMap))
    const notNullQuery = dialect.sqlToQuery(compileDrizzlePredicate(Predicate.neq("status", null), columnMap))
    const inQuery = dialect.sqlToQuery(compileDrizzlePredicate(Predicate.in("status", [null, "active"]), columnMap))
    const likeQuery = dialect.sqlToQuery(compileDrizzlePredicate(Predicate.contains("genericName", "50%_\\path"), columnMap))

    expect(nullQuery).toEqual({ sql: 'COALESCE("drug_formulary"."status" is null, FALSE)', params: [] })
    expect(notNullQuery).toEqual({ sql: 'COALESCE("drug_formulary"."status" is not null, FALSE)', params: [] })
    expect(inQuery.params).toEqual(["active"])
    // SQLite LIKE is ASCII case-insensitive; instr() is exact, so no escaping is needed.
    expect(likeQuery).toMatchObject({ sql: 'COALESCE(instr("drug_formulary"."generic_name", ?) > 0, FALSE)', params: ["50%_\\path"] })
    const genericLike = dialect.sqlToQuery(compileDrizzlePredicate(Predicate.contains("genericName", "50%_\\path"), columnMap, { dialect: "generic" }))
    expect(genericLike.params).toEqual(["%50\\%\\_\\\\path%"])
    const prefix = dialect.sqlToQuery(compileDrizzlePredicate(Predicate.startsWith("genericName", "As"), columnMap))
    const suffix = dialect.sqlToQuery(compileDrizzlePredicate(Predicate.endsWith("genericName", "in"), columnMap))
    const empty = dialect.sqlToQuery(compileDrizzlePredicate(Predicate.contains("genericName", ""), columnMap))
    expect(prefix.sql).toBe('COALESCE(substr("drug_formulary"."generic_name", 1, length(?)) = ?, FALSE)')
    expect(suffix.sql).toBe('COALESCE(substr("drug_formulary"."generic_name", -length(?)) = ?, FALSE)')
    expect(empty.sql).toBe('COALESCE("drug_formulary"."generic_name" = "drug_formulary"."generic_name", FALSE)')
  })

  it("rejects includesAll instead of compiling non-portable array SQL", () => {
    expect(() => compileDrizzlePredicate(Predicate.includesAll("status", ["active"]), columnMap)).toThrow(
      "Unsupported predicate operator: includesAll",
    )
  })

  it("fails closed for an empty between range while preserving open bounds", () => {
    const empty = dialect.sqlToQuery(compileDrizzlePredicate({ kind: "condition", field: "id", op: "between", value: {} }, columnMap))
    const lowerOnly = dialect.sqlToQuery(compileDrizzlePredicate(Predicate.between("id", { from: "a" }), columnMap))
    const upperOnly = dialect.sqlToQuery(compileDrizzlePredicate(Predicate.between("id", { to: "z" }), columnMap))

    expect(empty).toEqual({ sql: "COALESCE(1 = 0, FALSE)", params: [] })
    expect(lowerOnly.params).toEqual(["a"])
    expect(upperOnly.params).toEqual(["z"])
  })
})

