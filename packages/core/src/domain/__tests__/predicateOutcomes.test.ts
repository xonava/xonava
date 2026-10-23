import { describe, expect, it } from "vitest"
import type { AbacFieldDefinition } from "../abacCatalog"
import { findNonPortablePredicate, findUnsupportedPredicateCombination, Predicate, type PredicateNode } from "../predicate"

const fields: Record<string, AbacFieldDefinition> = {
  name: { key: "name", type: "string", operators: [] },
  code: { key: "code", type: "identifier", operators: [] },
  count: { key: "count", type: "number", operators: [] },
  active: { key: "active", type: "boolean", operators: [] },
  at: { key: "at", type: "date", operators: [] },
  tags: { key: "tags", type: "string-array", operators: [] },
}

function issueOf(node: PredicateNode): string | undefined {
  return findUnsupportedPredicateCombination(node, fields)?.message
}

describe("predicate builders produce exact AST nodes", () => {
  it("builds the group and literal constants", () => {
    expect(Predicate.alwaysTrue()).toStrictEqual({ kind: "and", filters: [] })
    expect(Predicate.alwaysFalse()).toStrictEqual({ kind: "or", filters: [] })
    expect(Predicate.literal(true)).toStrictEqual({ kind: "literal", value: true })
    expect(Predicate.literal(false)).toStrictEqual({ kind: "literal", value: false })
  })

  it("builds comparison conditions with their operator and value", () => {
    expect(Predicate.eq("a", 1)).toStrictEqual({ kind: "condition", field: "a", op: "eq", value: 1 })
    expect(Predicate.neq("a", "x")).toStrictEqual({ kind: "condition", field: "a", op: "neq", value: "x" })
    expect(Predicate.gt("a", 1)).toStrictEqual({ kind: "condition", field: "a", op: "gt", value: 1 })
    expect(Predicate.lt("a", 1)).toStrictEqual({ kind: "condition", field: "a", op: "lt", value: 1 })
    expect(Predicate.gte("a", 1)).toStrictEqual({ kind: "condition", field: "a", op: "gte", value: 1 })
    expect(Predicate.lte("a", 1)).toStrictEqual({ kind: "condition", field: "a", op: "lte", value: 1 })
    expect(Predicate.eq("a", null)).toStrictEqual({ kind: "condition", field: "a", op: "eq", value: null })
  })

  it("builds string matchers with their operator and value", () => {
    expect(Predicate.contains("a", "x")).toStrictEqual({ kind: "condition", field: "a", op: "contains", value: "x" })
    expect(Predicate.startsWith("a", "x")).toStrictEqual({ kind: "condition", field: "a", op: "startsWith", value: "x" })
    expect(Predicate.endsWith("a", "x")).toStrictEqual({ kind: "condition", field: "a", op: "endsWith", value: "x" })
  })

  it("omits the value key for valueless operators", () => {
    expect(Predicate.isEmpty("a")).toStrictEqual({ kind: "condition", field: "a", op: "isEmpty" })
    expect(Predicate.isNotEmpty("a")).toStrictEqual({ kind: "condition", field: "a", op: "isNotEmpty" })
    expect(Predicate.isTrue("a")).toStrictEqual({ kind: "condition", field: "a", op: "isTrue" })
    expect(Predicate.isFalse("a")).toStrictEqual({ kind: "condition", field: "a", op: "isFalse" })
    expect(Predicate.isNull("a")).toStrictEqual({ kind: "condition", field: "a", op: "isNull" })
    expect(Predicate.isNotNull("a")).toStrictEqual({ kind: "condition", field: "a", op: "isNotNull" })
    expect(Object.hasOwn(Predicate.isEmpty("a"), "value")).toBe(false)
  })

  it("builds list operators with their array value", () => {
    expect(Predicate.in("a", [1, 2])).toStrictEqual({ kind: "condition", field: "a", op: "in", value: [1, 2] })
    expect(Predicate.includesAny("a", ["x"])).toStrictEqual({ kind: "condition", field: "a", op: "includesAny", value: ["x"] })
    expect(Predicate.includesAll("a", ["x"])).toStrictEqual({ kind: "condition", field: "a", op: "includesAll", value: ["x"] })
  })

  it("normalises a bounds tuple into from and to, and passes a range object through", () => {
    expect(Predicate.between("a", [1, 2])).toStrictEqual({ kind: "condition", field: "a", op: "between", value: { from: 1, to: 2 } })
    expect(Predicate.between("a", { from: 1 })).toStrictEqual({ kind: "condition", field: "a", op: "between", value: { from: 1 } })
    expect(Predicate.between("a", { to: 9 })).toStrictEqual({ kind: "condition", field: "a", op: "between", value: { to: 9 } })
  })

  it("builds boolean composition nodes", () => {
    const left = Predicate.eq("a", 1)
    const right = Predicate.isNull("b")
    expect(Predicate.and(left, right)).toStrictEqual({ kind: "and", filters: [left, right] })
    expect(Predicate.or(left, right)).toStrictEqual({ kind: "or", filters: [left, right] })
    expect(Predicate.not(left)).toStrictEqual({ kind: "not", filter: left })
    expect(Predicate.and()).toStrictEqual({ kind: "and", filters: [] })
  })
})

describe("findUnsupportedPredicateCombination reports exact messages", () => {
  it("accepts a well-typed condition and reports no issue", () => {
    expect(findUnsupportedPredicateCombination(Predicate.eq("name", "x"), fields)).toBeUndefined()
    expect(findUnsupportedPredicateCombination(Predicate.isEmpty("tags"), fields)).toBeUndefined()
  })

  it("names an unknown field and returns the offending condition itself", () => {
    const node = Predicate.eq("missing", 1)
    const issue = findUnsupportedPredicateCombination(node, fields)
    expect(issue?.message).toBe("Unknown field: missing")
    expect(issue?.condition).toBe(node)
  })

  it("treats inherited object keys as unknown fields", () => {
    expect(issueOf(Predicate.eq("toString", 1))).toBe("Unknown field: toString")
  })

  it("requires a scalar field for non-array operators on arrays", () => {
    expect(issueOf(Predicate.eq("tags", "x"))).toBe('Operator "eq" requires a scalar field')
    expect(issueOf(Predicate.in("tags", ["x"]))).toBe('Operator "in" requires a scalar field')
    expect(issueOf(Predicate.gt("tags", 1))).toBe('Operator "gt" requires a scalar field')
  })

  it("requires an array field for includesAny and includesAll", () => {
    expect(issueOf(Predicate.includesAny("count", [1]))).toBe('Operator "includesAny" requires an array field')
    expect(issueOf(Predicate.includesAll("name", ["x"]))).toBe('Operator "includesAll" requires an array field')
    expect(issueOf(Predicate.includesAny("tags", ["x"]))).toBeUndefined()
  })

  it("requires an array value for in", () => {
    expect(issueOf(Predicate.in("count", 5 as never))).toBe('Operator "in" requires an array value')
    expect(issueOf(Predicate.in("count", [1, 2]))).toBeUndefined()
  })

  it("requires scalar string operands for string matchers", () => {
    expect(issueOf(Predicate.contains("count", "x"))).toBe('Operator "contains" requires a string field and scalar string value')
    expect(issueOf(Predicate.startsWith("name", 5 as never))).toBe('Operator "startsWith" requires a string field and scalar string value')
    expect(issueOf(Predicate.endsWith("code", "x"))).toBeUndefined()
    expect(issueOf(Predicate.contains("name", "x"))).toBeUndefined()
  })

  it("requires an ordered scalar field for comparisons and between", () => {
    expect(issueOf(Predicate.gt("name", "a"))).toBe('Operator "gt" requires an ordered scalar field')
    expect(issueOf(Predicate.lte("code", "a"))).toBe('Operator "lte" requires an ordered scalar field')
    expect(issueOf(Predicate.between("name", { from: "a" }))).toBe('Operator "between" requires an ordered scalar field')
    expect(issueOf(Predicate.gte("at", new Date(0)))).toBeUndefined()
    expect(issueOf(Predicate.lt("count", 5))).toBeUndefined()
  })

  it("rejects array or object operands for comparisons but not for Date values", () => {
    expect(issueOf(Predicate.gt("count", [1] as never))).toBe('Operator "gt" requires an ordered scalar field')
    expect(issueOf(Predicate.lt("count", { from: 1 } as never))).toBe('Operator "lt" requires an ordered scalar field')
    expect(issueOf(Predicate.gte("at", new Date(0)))).toBeUndefined()
  })

  it("requires at least one bound for between", () => {
    expect(issueOf(Predicate.between("count", 5 as never))).toBe('Operator "between" requires at least one bound')
    expect(issueOf(Predicate.between("count", {}))).toBe('Operator "between" requires at least one bound')
    expect(issueOf(Predicate.between("count", { from: 1 }))).toBeUndefined()
    expect(issueOf(Predicate.between("count", { to: 2 }))).toBeUndefined()
  })

  it("requires a boolean field for isTrue and isFalse", () => {
    expect(issueOf(Predicate.isTrue("count"))).toBe('Operator "isTrue" requires a boolean field')
    expect(issueOf(Predicate.isFalse("name"))).toBe('Operator "isFalse" requires a boolean field')
    expect(issueOf(Predicate.isFalse("active"))).toBeUndefined()
  })

  it("requires a string or array field for isEmpty and isNotEmpty", () => {
    expect(issueOf(Predicate.isEmpty("count"))).toBe('Operator "isEmpty" requires a string or array field')
    expect(issueOf(Predicate.isNotEmpty("active"))).toBe('Operator "isNotEmpty" requires a string or array field')
    expect(issueOf(Predicate.isEmpty("name"))).toBeUndefined()
    expect(issueOf(Predicate.isNotEmpty("tags"))).toBeUndefined()
  })

  it("requires scalar members in an in list", () => {
    expect(issueOf(Predicate.in("count", [1, {} as never]))).toBe('Operator "in" requires a list of scalar values')
    expect(issueOf(Predicate.in("count", [null, new Date(0)]))).toBeUndefined()
  })

  it("requires a scalar value for scalar fields and non-range operators", () => {
    expect(issueOf(Predicate.eq("count", [1] as never))).toBe('Operator "eq" requires a scalar value')
    expect(issueOf(Predicate.neq("count", { a: 1 } as never))).toBe('Operator "neq" requires a scalar value')
    expect(issueOf(Predicate.eq("count", new Date(0)))).toBeUndefined()
    expect(issueOf(Predicate.eq("count", undefined as never))).toBeUndefined()
  })

  it("reports the first issue inside composed nodes and walks negations", () => {
    expect(issueOf(Predicate.not(Predicate.eq("missing", 1)))).toBe("Unknown field: missing")
    expect(issueOf(Predicate.and(Predicate.eq("count", 1), Predicate.isTrue("name"), Predicate.eq("missing", 1)))).toBe(
      'Operator "isTrue" requires a boolean field',
    )
    expect(issueOf(Predicate.or(Predicate.eq("name", "a"), Predicate.eq("missing", 1)))).toBe("Unknown field: missing")
    expect(issueOf(Predicate.literal(true))).toBeUndefined()
  })
})

describe("findNonPortablePredicate", () => {
  it("flags the array-semantics and empty-check operators as non-portable", () => {
    const includesAny = Predicate.includesAny("tags", ["x"])
    const isEmpty = Predicate.isEmpty("name")
    expect(findNonPortablePredicate(includesAny)).toBe(includesAny)
    expect(findNonPortablePredicate(Predicate.includesAll("tags", ["x"]))).toStrictEqual({ kind: "condition", field: "tags", op: "includesAll", value: ["x"] })
    expect(findNonPortablePredicate(isEmpty)).toBe(isEmpty)
    expect(findNonPortablePredicate(Predicate.isNotEmpty("name"))).toStrictEqual({ kind: "condition", field: "name", op: "isNotEmpty" })
  })

  it("accepts portable operators", () => {
    expect(findNonPortablePredicate(Predicate.eq("a", 1))).toBeUndefined()
    expect(findNonPortablePredicate(Predicate.in("a", [1]))).toBeUndefined()
    expect(findNonPortablePredicate(Predicate.isNull("a"))).toBeUndefined()
    expect(findNonPortablePredicate(Predicate.literal(false))).toBeUndefined()
  })

  it("returns the first non-portable child of and/or and walks negations", () => {
    const bad = Predicate.isEmpty("name")
    expect(findNonPortablePredicate(Predicate.and(Predicate.eq("a", 1), bad, Predicate.isNotEmpty("b")))).toBe(bad)
    expect(findNonPortablePredicate(Predicate.or(Predicate.eq("a", 1), Predicate.includesAll("tags", ["x"])))).toStrictEqual({
      kind: "condition",
      field: "tags",
      op: "includesAll",
      value: ["x"],
    })
    expect(findNonPortablePredicate(Predicate.not(bad))).toBe(bad)
    expect(findNonPortablePredicate(Predicate.and(Predicate.eq("a", 1)))).toBeUndefined()
  })
})
