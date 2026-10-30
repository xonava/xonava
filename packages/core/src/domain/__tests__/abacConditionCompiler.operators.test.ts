import { describe, expect, it } from "vitest"
import type { AbacFieldDefinition } from "../abacCatalog"
import { conditionGroupToPredicate, normalizeContextAttribute, policyClauseToPredicate, policyConditionsToPredicate, type PredicateCompileResult } from "../abacConditionCompiler"
import { ALLOWED_USER_ATTRS, normalizeUserAttribute, type PolicyConditionGroup, type PolicyFilterClause } from "../abacPolicySchema"
import type { AbacContext } from "../abacTypes"
import { Predicate } from "../predicate"

const fields: Record<string, AbacFieldDefinition> = {
  text: { key: "text", type: "string", operators: ["equals", "notEquals", "contains", "startsWith", "endsWith", "in"] },
  num: { key: "num", type: "number", operators: ["equals", "between", "in", "greaterThan"] },
  flag: { key: "flag", type: "boolean", operators: ["equals", "isTrue", "isFalse"] },
  day: { key: "day", type: "date", operators: ["equals", "between", "after", "before"] },
  at: { key: "at", type: "datetime", operators: ["equals", "between", "after", "before"] },
  tags: { key: "tags", type: "string-array", operators: ["in", "includesAny", "includesAll"] },
}
const context: AbacContext = { userId: "u1", roleId: "r1", branchId: "b1", departmentId: "d1", tenantId: "t1" }

const clause = (value: Partial<PolicyFilterClause> & { field: string }): PolicyFilterClause => value as PolicyFilterClause
const compile = (c: Partial<PolicyFilterClause> & { field: string }, effect?: "allow" | "deny", ctx: AbacContext = context): PredicateCompileResult =>
  policyClauseToPredicate({ clause: clause(c), context: ctx, fieldCatalog: fields, ...(effect ? { effect } : {}) })
const ok = (predicate: unknown): PredicateCompileResult => ({ success: true, predicate } as PredicateCompileResult)
const fail = (error: string): PredicateCompileResult => ({ success: false, error })

describe("user attributes", () => {
  it("knows exactly the five context attributes", () => {
    expect([...ALLOWED_USER_ATTRS].sort()).toEqual(["user.branchId", "user.departmentId", "user.id", "user.roleId", "user.tenantId"])
    for (const attr of ALLOWED_USER_ATTRS) {
      expect(normalizeUserAttribute(attr)).toBe(attr)
      expect(normalizeContextAttribute(attr)).toBe(attr)
    }
    for (const bad of ["", "user", "user.name", "User.id", " user.id"]) {
      expect(normalizeUserAttribute(bad)).toBeUndefined()
      expect(normalizeContextAttribute(bad)).toBeUndefined()
    }
  })

  it("resolves each attribute from the context, by userAttr and by a value naming it", () => {
    const expected: Array<[string, string]> = [["user.id", "u1"], ["user.roleId", "r1"], ["user.branchId", "b1"], ["user.departmentId", "d1"], ["user.tenantId", "t1"]]
    for (const [attr, value] of expected) {
      expect(compile({ field: "text", operator: "equals", userAttr: attr })).toEqual(ok(Predicate.eq("text", value)))
      expect(compile({ field: "text", operator: "equals", value: attr })).toEqual(ok(Predicate.eq("text", value)))
    }
  })

  it("compiles an unresolved attribute to the fail-closed constant of the effect", () => {
    const empty: AbacContext = {}
    for (const attr of ["user.id", "user.roleId", "user.branchId", "user.departmentId", "user.tenantId"]) {
      expect(compile({ field: "text", operator: "equals", userAttr: attr }, "allow", empty)).toEqual(ok(Predicate.alwaysFalse()))
      expect(compile({ field: "text", operator: "equals", userAttr: attr }, undefined, empty)).toEqual(ok(Predicate.alwaysFalse()))
      expect(compile({ field: "text", operator: "equals", userAttr: attr }, "deny", empty)).toEqual(ok(Predicate.alwaysTrue()))
    }
    expect(compile({ field: "text", operator: "equals", userAttr: "user.roleId" }, "deny", { roleId: null })).toEqual(ok(Predicate.alwaysTrue()))
    expect(compile({ field: "text", operator: "equals", userAttr: "user.nope" }, "deny")).toEqual(ok(Predicate.alwaysTrue()))
  })

  it("keeps a literal value that merely looks like text", () => {
    expect(compile({ field: "text", operator: "equals", value: "user.name" })).toEqual(ok(Predicate.eq("text", "user.name")))
  })
})

describe("null-test and value-less operators", () => {
  it.each(["isEmpty", "isNotEmpty", "isTrue", "isFalse", "isNull", "isNotNull"] as const)("%s compiles to the matching predicate", (operator) => {
    const expected = { isEmpty: Predicate.isEmpty, isNotEmpty: Predicate.isNotEmpty, isTrue: Predicate.isTrue, isFalse: Predicate.isFalse, isNull: Predicate.isNull, isNotNull: Predicate.isNotNull }[operator]("flag")
    expect(compile({ field: "flag", operator })).toEqual(ok(expected))
    expect(compile({ field: "flag", operator, value: "ignored" })).toEqual(ok(expected))
  })

  it("rejects an unknown field and an unknown operator", () => {
    expect(compile({ field: "ghost", operator: "equals", value: "x" })).toEqual(fail("Unknown field: ghost"))
    expect(compile({ field: "toString", operator: "equals", value: "x" })).toEqual(fail("Unknown field: toString"))
    expect(compile({ field: "text", operator: "regex" as never, value: "x" })).toEqual(fail("Unsupported ABAC operator: regex"))
  })

  it("defaults the operator to equals", () => {
    expect(compile({ field: "text", value: "x" })).toEqual(ok(Predicate.eq("text", "x")))
  })
})

describe("scalar operators and value coercion", () => {
  it("builds each comparison with its predicate", () => {
    expect(compile({ field: "text", operator: "notEquals", value: "x" })).toEqual(ok(Predicate.neq("text", "x")))
    expect(compile({ field: "text", operator: "contains", value: "x" })).toEqual(ok(Predicate.contains("text", "x")))
    expect(compile({ field: "text", operator: "startsWith", value: "x" })).toEqual(ok(Predicate.startsWith("text", "x")))
    expect(compile({ field: "text", operator: "endsWith", value: "x" })).toEqual(ok(Predicate.endsWith("text", "x")))
    expect(compile({ field: "num", operator: "greaterThan", value: "5" })).toEqual(ok(Predicate.gt("num", 5)))
    expect(compile({ field: "num", operator: "after" as never, value: 5 })).toEqual(ok(Predicate.gt("num", 5)))
    expect(compile({ field: "num", operator: "lessThan", value: 5 })).toEqual(ok(Predicate.lt("num", 5)))
    expect(compile({ field: "num", operator: "before" as never, value: 5 })).toEqual(ok(Predicate.lt("num", 5)))
    expect(compile({ field: "num", operator: "greaterOrEqual", value: 5 })).toEqual(ok(Predicate.gte("num", 5)))
    expect(compile({ field: "num", operator: "lessOrEqual", value: 5 })).toEqual(ok(Predicate.lte("num", 5)))
  })

  it("keeps booleans and coerces their string spellings", () => {
    expect(compile({ field: "flag", operator: "equals", value: true })).toEqual(ok(Predicate.eq("flag", true)))
    expect(compile({ field: "flag", operator: "equals", value: "false" })).toEqual(ok(Predicate.eq("flag", false)))
    expect(compile({ field: "flag", operator: "equals", value: "maybe" })).toEqual(fail('Cannot coerce value for field "flag": Invalid boolean value: maybe'))
  })

  it("requires string values for the text operators", () => {
    expect(compile({ field: "num", operator: "contains", value: 5 })).toEqual(fail('Operator "contains" requires a string value for field "num", got number'))
    expect(compile({ field: "num", operator: "startsWith", value: 5 })).toEqual(fail('Operator "startsWith" requires a string value for field "num", got number'))
    expect(compile({ field: "num", operator: "endsWith", value: 5 })).toEqual(fail('Operator "endsWith" requires a string value for field "num", got number'))
  })

  it("compiles a null value to a null comparison and an absent value to a null-safe predicate", () => {
    expect(compile({ field: "text", operator: "equals", value: null as never })).toEqual(ok(Predicate.eq("text", null)))
    expect(compile({ field: "text", operator: "equals" })).toEqual(fail('Cannot coerce value for field "text": Invalid string value of type undefined'))
  })

  it("reports a non-primitive coercion result as always false", () => {
    // string-array fields cannot take a scalar value: the coercion error surfaces.
    expect(compile({ field: "tags", operator: "equals", value: "a" })).toEqual(
      fail('Cannot coerce value for field "tags": string-array values must be provided through a list operator (in, includesAny, includesAll)'),
    )
  })

  it("keeps date literals as calendar dates and datetimes as instants", () => {
    expect(compile({ field: "day", operator: "equals", value: "2026-01-02" })).toEqual(ok(Predicate.eq("day", "2026-01-02")))
    expect(compile({ field: "day", operator: "equals", value: new Date("2026-01-02T00:00:00.000Z") as never })).toEqual(ok(Predicate.eq("day", "2026-01-02")))
    expect(compile({ field: "day", operator: "equals", value: new Date("2026-01-02T03:04:05.000Z") as never })).toEqual(
      fail('Cannot coerce value for field "day": not a calendar date: 2026-01-02T03:04:05.000Z'),
    )
    expect(compile({ field: "day", operator: "equals", value: new Date("+010000-01-01T00:00:00.000Z") as never })).toEqual(
      fail('Cannot coerce value for field "day": not a calendar date: +010000-01-01T00:00:00.000Z'),
    )
    expect(compile({ field: "at", operator: "equals", value: "2026-01-02T03:04:05Z" })).toEqual(ok(Predicate.eq("at", new Date("2026-01-02T03:04:05.000Z"))))
    expect(compile({ field: "day", operator: "equals", value: "not-a-date" })).toEqual(fail('Cannot coerce value for field "day": Invalid date value: not-a-date'))
  })
})

describe("list operators", () => {
  it("builds in/includesAny/includesAll for scalar fields from values", () => {
    expect(compile({ field: "num", operator: "in", values: [1, "2"] })).toEqual(ok(Predicate.in("num", [1, 2])))
    expect(compile({ field: "num", operator: "includesAny", values: [1] })).toEqual(ok(Predicate.includesAny("num", [1])))
    expect(compile({ field: "num", operator: "includesAll", values: [1] })).toEqual(ok(Predicate.includesAll("num", [1])))
  })

  it("falls back to the single value and to an empty, always false list", () => {
    expect(compile({ field: "text", operator: "in", value: "a" })).toEqual(ok(Predicate.in("text", ["a"])))
    expect(compile({ field: "text", operator: "in" })).toEqual(ok(Predicate.alwaysFalse()))
    expect(compile({ field: "text", operator: "in", values: [] })).toEqual(ok(Predicate.alwaysFalse()))
    expect(compile({ field: "text", operator: "in", values: [null as never] })).toEqual(ok(Predicate.in("text", [null])))
  })

  it("resolves attribute names inside the list and drops unresolved members for allow", () => {
    expect(compile({ field: "text", operator: "in", values: ["user.id", "x", "user.roleId"] })).toEqual(ok(Predicate.in("text", ["u1", "x", "r1"])))
    expect(compile({ field: "text", operator: "in", values: ["user.id", "x"] }, "allow", {})).toEqual(ok(Predicate.in("text", ["x"])))
    expect(compile({ field: "text", operator: "in", values: ["user.id"] }, "allow", {})).toEqual(ok(Predicate.alwaysFalse()))
    expect(compile({ field: "text", operator: "in", values: [5 as never, "x"] })).toEqual(ok(Predicate.in("text", ["5", "x"])))
  })

  it("an unresolved list member makes a deny apply", () => {
    expect(compile({ field: "text", operator: "in", values: ["user.id", "x"] }, "deny", {})).toEqual(ok(Predicate.alwaysTrue()))
    expect(compile({ field: "text", operator: "in", values: ["x"] }, "deny", {})).toEqual(ok(Predicate.in("text", ["x"])))
    expect(compile({ field: "text", operator: "in", value: "user.id" }, "deny", {})).toEqual(ok(Predicate.alwaysTrue()))
  })

  it("reports a failing list member from the scalar coercion", () => {
    expect(compile({ field: "num", operator: "in", values: [1, "abc"] })).toEqual(fail('Cannot coerce value for field "num": Invalid number value: abc'))
  })

  it("string-array fields use list coercion", () => {
    expect(compile({ field: "tags", operator: "includesAny", values: ["a", "b"] })).toEqual(ok(Predicate.includesAny("tags", ["a", "b"])))
    expect(compile({ field: "tags", operator: "includesAll", values: ["a"] })).toEqual(ok(Predicate.includesAll("tags", ["a"])))
    expect(compile({ field: "tags", operator: "in", values: ["a"] })).toEqual(ok(Predicate.in("tags", ["a"])))
    expect(compile({ field: "tags", operator: "in", values: [] })).toEqual(ok(Predicate.alwaysFalse()))
    expect(compile({ field: "tags", operator: "in", values: ["user.id"] })).toEqual(ok(Predicate.in("tags", ["u1"])))
    expect(compile({ field: "tags", operator: "includesAny", values: [1 as never, 2 as never] })).toEqual(fail("Expected string, got number"))
  })
})

describe("between", () => {
  it("accepts a two element array or a from/to object", () => {
    expect(compile({ field: "num", operator: "between", value: [1, 5] as never })).toEqual(ok(Predicate.between("num", { from: 1, to: 5 })))
    expect(compile({ field: "num", operator: "between", value: { from: 1, to: 5 } as never })).toEqual(ok(Predicate.between("num", { from: 1, to: 5 })))
    expect(compile({ field: "num", operator: "between", values: [1, 5] })).toEqual(ok(Predicate.between("num", { from: 1, to: 5 })))
    expect(compile({ field: "num", operator: "between", value: { from: "1" } as never })).toEqual(ok(Predicate.between("num", { from: 1 })))
    expect(compile({ field: "num", operator: "between", value: { to: "9" } as never })).toEqual(ok(Predicate.between("num", { to: 9 })))
    expect(compile({ field: "num", operator: "between", value: [1, {}] as never })).toEqual(ok(Predicate.between("num", { from: 1 })))
    expect(compile({ field: "num", operator: "between", value: [{}, 9] as never })).toEqual(ok(Predicate.between("num", { to: 9 })))
    expect(compile({ field: "day", operator: "between", value: ["2026-01-01", "2026-01-31"] as never })).toEqual(ok(Predicate.between("day", { from: "2026-01-01", to: "2026-01-31" })))
  })

  it("rejects malformed ranges", () => {
    const message = 'Invalid between value for field "num"'
    for (const value of [undefined, null, 5, "x", [1, 2, 3], [1], [], [{}, {}], {}, { from: {}, to: {} }, true]) {
      expect(compile({ field: "num", operator: "between", ...(value === undefined ? {} : { value: value as never }) })).toEqual(fail(message))
    }
  })

  it("reports which bound failed to coerce", () => {
    expect(compile({ field: "num", operator: "between", value: ["abc", 5] as never })).toEqual(fail('Cannot coerce value for field "num": Invalid number value: abc'))
    expect(compile({ field: "num", operator: "between", value: [1, "abc"] as never })).toEqual(fail('Cannot coerce value for field "num": Invalid number value: abc'))
    expect(compile({ field: "num", operator: "between", value: { from: "abc" } as never })).toEqual(fail('Cannot coerce value for field "num": Invalid number value: abc'))
    expect(compile({ field: "num", operator: "between", value: { to: "abc" } as never })).toEqual(fail('Cannot coerce value for field "num": Invalid number value: abc'))
  })

  it("an unresolved attribute short-circuits before the range", () => {
    expect(compile({ field: "num", operator: "between", userAttr: "user.id" }, "allow", {})).toEqual(ok(Predicate.alwaysFalse()))
    expect(compile({ field: "num", operator: "between", userAttr: "user.id" }, "deny", {})).toEqual(ok(Predicate.alwaysTrue()))
  })
})

describe("groups", () => {
  const a = clause({ field: "text", operator: "equals", value: "a" })
  const b = clause({ field: "text", operator: "equals", value: "b" })
  const group = (logic: "AND" | "OR", conditions: PolicyConditionGroup["conditions"]): PolicyConditionGroup => ({ logic, conditions })
  const run = (g: PolicyConditionGroup, effect?: "allow" | "deny") => conditionGroupToPredicate({ group: g, context, fieldCatalog: fields, ...(effect ? { effect } : {}) })

  it("an empty group is true for AND and false for OR", () => {
    expect(run(group("AND", []))).toEqual(ok(Predicate.alwaysTrue()))
    expect(run(group("OR", []))).toEqual(ok(Predicate.alwaysFalse()))
  })

  it("a single member is returned unwrapped, several are combined", () => {
    expect(run(group("AND", [a]))).toEqual(ok(Predicate.eq("text", "a")))
    expect(run(group("OR", [a]))).toEqual(ok(Predicate.eq("text", "a")))
    expect(run(group("AND", [a, b]))).toEqual(ok(Predicate.and(Predicate.eq("text", "a"), Predicate.eq("text", "b"))))
    expect(run(group("OR", [a, b]))).toEqual(ok(Predicate.or(Predicate.eq("text", "a"), Predicate.eq("text", "b"))))
  })

  it("nests groups and passes the effect down", () => {
    const unresolved = clause({ field: "text", operator: "equals", userAttr: "user.nope" })
    expect(run(group("AND", [group("OR", [a, b])]))).toEqual(ok(Predicate.or(Predicate.eq("text", "a"), Predicate.eq("text", "b"))))
    expect(run(group("AND", [group("OR", [unresolved])]), "deny")).toEqual(ok(Predicate.alwaysTrue()))
    expect(run(group("AND", [group("OR", [unresolved])]), "allow")).toEqual(ok(Predicate.alwaysFalse()))
    expect(run(group("AND", [unresolved]), "deny")).toEqual(ok(Predicate.alwaysTrue()))
    expect(run(group("AND", [unresolved]))).toEqual(ok(Predicate.alwaysFalse()))
  })

  it("joins every member error with a semicolon", () => {
    const bad1 = clause({ field: "ghost", operator: "equals", value: "x" })
    const bad2 = clause({ field: "ghost2", operator: "equals", value: "x" })
    expect(run(group("AND", [a, bad1, bad2]))).toEqual(fail("Unknown field: ghost; Unknown field: ghost2"))
    expect(run(group("OR", [group("AND", [bad1]), bad2]))).toEqual(fail("Unknown field: ghost; Unknown field: ghost2"))
  })

  it("treats an object with logic but no conditions array as a clause", () => {
    const odd = { logic: "AND", field: "text", operator: "equals", value: "a" } as never
    expect(run(group("AND", [odd]))).toEqual(ok(Predicate.eq("text", "a")))
    const notGroup = { conditions: [], field: "text", operator: "equals", value: "a" } as never
    expect(run(group("AND", [notGroup]))).toEqual(ok(Predicate.eq("text", "a")))
  })

  it("policyConditionsToPredicate combines the system scope and user filters", () => {
    const result = policyConditionsToPredicate({
      conditions: { version: 2, systemScope: group("AND", [a]), userFilters: group("AND", [b]) },
      context, fieldCatalog: fields,
    })
    expect(result).toEqual(ok(Predicate.and(Predicate.eq("text", "a"), Predicate.eq("text", "b"))))
  })
})
