import { describe, expect, it } from "vitest"
import { conditionGroupToPredicate, normalizeContextAttribute, policyClauseToPredicate, policyConditionsToPredicate } from "../abacConditionCompiler"
import { findUnsupportedPredicateCombination } from "../predicate"
import { evaluatePredicate } from "../evaluatePredicate"
import type { AbacContext } from "../abacTypes"
import type { AbacFieldDefinition } from "../abacCatalog"

const fields: Record<string, AbacFieldDefinition> = {
  text: { key: "text", type: "string", operators: ["contains", "startsWith", "endsWith", "between"] },
  number: { key: "number", type: "number", operators: ["lessThan", "greaterThan", "lessOrEqual", "greaterOrEqual", "between"] },
  bool: { key: "bool", type: "boolean", operators: ["isFalse"] },
  tags: { key: "tags", type: "string-array", operators: ["in"] },
  date: { key: "date", type: "date", operators: ["after", "before"] },
}
const context: AbacContext = { userId: "u1", roleId: "r1", branchId: "b1", departmentId: "d1", tenantId: "t1", custom: "custom" }

describe("ABAC compiler uncovered values and operators", () => {
  it("normalizes known and unknown context attributes", () => {
    expect(normalizeContextAttribute("user.id")).toBe("user.id")
    expect(normalizeContextAttribute("@@user.id")).toBeUndefined()
    expect(normalizeContextAttribute("unknown")).toBeUndefined()
    expect(normalizeContextAttribute(1)).toBeUndefined()
  })

  it.each([
    ["equals", { field: "text", operator: "equals", value: "x" }, { text: "x" }],
    ["notEquals", { field: "text", operator: "notEquals", value: "x" }, { text: "y" }],
    ["notEquals", { field: "text", operator: "notEquals", value: "x" }, { text: "y" }],
    ["startsWith", { field: "text", operator: "startsWith", value: "x" }, { text: "xyz" }],
    ["endsWith", { field: "text", operator: "endsWith", value: "z" }, { text: "xyz" }],
    ["greaterThan", { field: "number", operator: "greaterThan", value: "2" }, { number: 3 }],
    ["lessThan", { field: "number", operator: "lessThan", value: "4" }, { number: 3 }],
    ["lessOrEqual", { field: "number", operator: "lessOrEqual", value: "3" }, { number: 3 }],
    ["greaterOrEqual", { field: "number", operator: "greaterOrEqual", value: "3" }, { number: 3 }],
    ["isFalse", { field: "bool", operator: "isFalse" }, { bool: false }],
    ["date aliases", { field: "date", operator: "after", value: "2026-01-01" }, { date: new Date("2026-02-01T00:00:00.000Z") }],
    ["before alias", { field: "date", operator: "before", value: "2026-03-01" }, { date: new Date("2026-02-01T00:00:00.000Z") }],
  ] as const)("compiles %s", (_name, clause, record) => {
    const result = policyClauseToPredicate({ clause, context, fieldCatalog: fields })
    expect(result.success).toBe(true)
    if (result.success) expect(evaluatePredicate(record, result.predicate)).toBe(true)
  })

  it("compiles closed and open between ranges", () => {
    const closed = policyClauseToPredicate({ clause: { field: "text", operator: "between", value: { from: "b", to: "d" } }, context, fieldCatalog: fields })
    expect(closed.success).toBe(true)
    if (closed.success) {
      expect(evaluatePredicate({ text: "c" }, closed.predicate)).toBe(true)
      expect(evaluatePredicate({ text: "e" }, closed.predicate)).toBe(false)
    }

    const lowerOnly = policyClauseToPredicate({ clause: { field: "text", operator: "between", value: { from: "b" } }, context, fieldCatalog: fields })
    expect(lowerOnly.success).toBe(true)
    if (lowerOnly.success) expect(evaluatePredicate({ text: "z" }, lowerOnly.predicate)).toBe(true)

    const upperOnly = policyClauseToPredicate({ clause: { field: "text", operator: "between", value: { to: "d" } }, context, fieldCatalog: fields })
    expect(upperOnly.success).toBe(true)
    if (upperOnly.success) expect(evaluatePredicate({ text: "a" }, upperOnly.predicate)).toBe(true)

    const emptyRange = policyClauseToPredicate({ clause: { field: "text", operator: "between", value: { from: undefined, to: undefined } }, context, fieldCatalog: fields })
    expect(emptyRange).toMatchObject({ success: false, error: "Invalid between value for field \"text\"" })

    const arrayRange = policyClauseToPredicate({ clause: { field: "text", operator: "between", values: ["b", "d"] }, context, fieldCatalog: fields })
    expect(arrayRange.success).toBe(true)
    const lowerArray = policyClauseToPredicate({ clause: { field: "text", operator: "between", value: ["b", undefined] }, context, fieldCatalog: fields })
    expect(lowerArray.success).toBe(true)
  })

  it("handles list operators and list coercion errors", () => {
    const empty = policyClauseToPredicate({ clause: { field: "tags", operator: "in", values: [] }, context, fieldCatalog: fields })
    expect(empty.success).toBe(true)
    if (empty.success) expect(evaluatePredicate({ tags: ["other"] }, empty.predicate)).toBe(false)

    const list = policyClauseToPredicate({ clause: { field: "tags", operator: "in", values: ["vip"] }, context, fieldCatalog: fields })
    expect(list.success).toBe(true)
    if (list.success) expect(list.predicate).toMatchObject({ kind: "condition", field: "tags", op: "in" })
    if (list.success) expect(evaluatePredicate({ tags: ["vip", "other"] }, list.predicate)).toBe(false)

    const overlap = policyClauseToPredicate({ clause: { field: "tags", operator: "includesAny", values: ["vip"] }, context, fieldCatalog: fields })
    expect(overlap.success).toBe(true)
    if (overlap.success) expect(evaluatePredicate({ tags: ["vip", "other"] }, overlap.predicate)).toBe(true)

    const invalidList = policyClauseToPredicate({ clause: { field: "tags", operator: "includesAny", values: ["vip", 3] }, context, fieldCatalog: fields })
    expect(invalidList).toMatchObject({ success: false, error: "Expected string, got number" })

    const invalidNumberList = policyClauseToPredicate({ clause: { field: "number", operator: "in", values: ["3", "not-a-number"] }, context, fieldCatalog: fields })
    expect(invalidNumberList).toMatchObject({ success: false, error: "Cannot coerce value for field \"number\": Invalid number value: not-a-number" })

    const numberList = policyClauseToPredicate({ clause: { field: "number", operator: "in", values: [2, 3] }, context, fieldCatalog: fields })
    expect(numberList.success).toBe(true)
    if (numberList.success) expect(evaluatePredicate({ number: 3 }, numberList.predicate)).toBe(true)
  })

  it("compiles boolean true and object values that become non-matching primitives", () => {
    const truth = policyClauseToPredicate({ clause: { field: "bool", operator: "isTrue" }, context, fieldCatalog: fields })
    expect(truth.success).toBe(true)
    if (truth.success) expect(evaluatePredicate({ bool: true }, truth.predicate)).toBe(true)

    const objectValue = policyClauseToPredicate({ clause: { field: "text", operator: "equals", value: { unexpected: true } }, context, fieldCatalog: fields })
    expect(objectValue.success).toBe(true)
    if (objectValue.success) expect(evaluatePredicate({ text: "[object Object]" }, objectValue.predicate)).toBe(true)
  })

  it("resolves every supported user attribute", () => {
    const cases = [
      ["user.id", "u1"],
      ["user.roleId", "r1"],
      ["user.branchId", "b1"],
      ["user.departmentId", "d1"],
      ["user.tenantId", "t1"],
    ] as const

    for (const [userAttr, expected] of cases) {
      const result = policyClauseToPredicate({ clause: { field: "text", operator: "equals", userAttr }, context, fieldCatalog: fields })
      expect(result.success).toBe(true)
      if (result.success) expect(evaluatePredicate({ text: expected }, result.predicate)).toBe(true)
    }

    const inlineAttribute = policyClauseToPredicate({ clause: { field: "text", operator: "equals", value: "user.roleId" }, context, fieldCatalog: fields })
    expect(inlineAttribute.success).toBe(true)
    if (inlineAttribute.success) expect(evaluatePredicate({ text: "r1" }, inlineAttribute.predicate)).toBe(true)

    const unknownAttribute = policyClauseToPredicate({ clause: { field: "text", operator: "equals", userAttr: "user.custom" }, context, fieldCatalog: fields })
    expect(unknownAttribute.success).toBe(true)
    if (unknownAttribute.success) expect(evaluatePredicate({ text: "custom" }, unknownAttribute.predicate)).toBe(false)
  })

  it("reports invalid values and string operator type errors", () => {
    expect(policyClauseToPredicate({ clause: { field: "text", value: "x" }, context, fieldCatalog: fields }).success).toBe(true)
    const invalidNumber = policyClauseToPredicate({ clause: { field: "number", operator: "equals", value: "not-a-number" }, context, fieldCatalog: fields })
    expect(invalidNumber).toMatchObject({ success: false, error: "Cannot coerce value for field \"number\": Invalid number value: not-a-number" })
    const badType = policyClauseToPredicate({ clause: { field: "number", operator: "contains", value: 1 }, context, fieldCatalog: fields })
    expect(badType).toMatchObject({ success: false, error: "Operator \"contains\" requires a string value for field \"number\", got number" })
    expect(policyClauseToPredicate({ clause: { field: "number", operator: "startsWith", value: 1 }, context, fieldCatalog: fields })).toMatchObject({ success: false, error: "Operator \"startsWith\" requires a string value for field \"number\", got number" })
    expect(policyClauseToPredicate({ clause: { field: "number", operator: "endsWith", value: 1 }, context, fieldCatalog: fields })).toMatchObject({ success: false, error: "Operator \"endsWith\" requires a string value for field \"number\", got number" })
    expect(policyClauseToPredicate({ clause: { field: "text", operator: "isEmpty" }, context, fieldCatalog: fields }).success).toBe(true)
    expect(policyClauseToPredicate({ clause: { field: "text", operator: "isNotEmpty" }, context, fieldCatalog: fields }).success).toBe(true)
    expect(policyClauseToPredicate({ clause: { field: "tags", operator: "includesAny", values: ["user.branchId"] }, context, fieldCatalog: fields })).toMatchObject({ success: true })
    expect(policyClauseToPredicate({ clause: { field: "number", operator: "in", values: [] }, context, fieldCatalog: fields })).toMatchObject({ success: true })
    expect(policyClauseToPredicate({ clause: { field: "text", operator: "unknown" as never, value: "x" }, context, fieldCatalog: fields })).toMatchObject({ success: false, error: "Unsupported ABAC operator: unknown" })
  })

  it("combines empty and singleton groups", () => {
    const emptyAnd = conditionGroupToPredicate({ group: { logic: "AND", conditions: [] }, context, fieldCatalog: fields })
    const emptyOr = conditionGroupToPredicate({ group: { logic: "OR", conditions: [] }, context, fieldCatalog: fields })
    const singleton = conditionGroupToPredicate({ group: { logic: "OR", conditions: [{ field: "text", operator: "equals", value: "x" }] }, context, fieldCatalog: fields })
    expect(emptyAnd.success && evaluatePredicate({}, emptyAnd.predicate)).toBe(true)
    expect(emptyOr.success && evaluatePredicate({}, emptyOr.predicate)).toBe(false)
    expect(singleton.success && evaluatePredicate({ text: "x" }, singleton.predicate)).toBe(true)
  })

  it("combines multiple successful predicates and handles non-primitive values", () => {
    const and = conditionGroupToPredicate({ group: { logic: "AND", conditions: [
      { field: "text", operator: "equals", value: "x" },
      { field: "number", operator: "greaterThan", value: 1 },
    ] }, context, fieldCatalog: fields })
    const or = conditionGroupToPredicate({ group: { logic: "OR", conditions: [
      { field: "text", operator: "equals", value: "x" },
      { field: "text", operator: "equals", value: "y" },
    ] }, context, fieldCatalog: fields })
    expect(and.success && evaluatePredicate({ text: "x", number: 2 }, and.predicate)).toBe(true)
    expect(or.success && evaluatePredicate({ text: "y" }, or.predicate)).toBe(true)

    const invalidBetween = policyClauseToPredicate({ clause: { field: "text", operator: "between", value: { from: { bad: true } } }, context, fieldCatalog: fields })
    expect(invalidBetween).toMatchObject({ success: false, error: 'Invalid between value for field "text"' })
  })

  it("rejects an empty between range during predicate validation", () => {
    expect(findUnsupportedPredicateCombination({ kind: "condition", field: "number", op: "between", value: {} }, fields))
      .toMatchObject({ message: 'Operator "between" requires at least one bound' })
  })

  it("combines nested groups and propagates all compilation errors", () => {
    const nested = conditionGroupToPredicate({ group: { logic: "AND", conditions: [{ logic: "OR", conditions: [{ field: "text", operator: "equals", value: "x" }, { field: "text", operator: "equals", value: "y" }] }, { field: "text", operator: "equals", value: "x" }] }, context, fieldCatalog: fields })
    expect(nested.success).toBe(true)
    if (nested.success) {
      expect(evaluatePredicate({ text: "x" }, nested.predicate)).toBe(true)
      expect(evaluatePredicate({ text: "z" }, nested.predicate)).toBe(false)
    }

    const nestedFailure = conditionGroupToPredicate({ group: { logic: "OR", conditions: [{ field: "bad" }, { field: "number", operator: "equals", value: "bad" }] }, context, fieldCatalog: fields })
    expect(nestedFailure).toMatchObject({ success: false, error: "Unknown field: bad; Cannot coerce value for field \"number\": Invalid number value: bad" })

    const failed = policyConditionsToPredicate({ conditions: { version: 2, systemScope: { logic: "AND", conditions: [{ field: "bad" }] }, userFilters: { logic: "AND", conditions: [{ field: "number", operator: "equals", value: "bad" }] } }, context, fieldCatalog: fields })
    expect(failed).toMatchObject({ success: false, error: "Unknown field: bad" })

    const userFailure = policyConditionsToPredicate({ conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [{ field: "bad" }] } }, context, fieldCatalog: fields })
    expect(userFailure).toMatchObject({ success: false, error: "Unknown field: bad" })
    const nonPrimitive = policyClauseToPredicate({ clause: { field: "tags", operator: "equals", value: ["x"] }, context, fieldCatalog: fields })
    expect(nonPrimitive).toMatchObject({ success: false })
  })
})
