import { describe, expect, it } from "vitest"
import { conditionGroupToPredicate, policyClauseToPredicate, policyConditionsToPredicate } from "../abacConditionCompiler"
import { evaluatePredicate } from "../evaluatePredicate"
import type { AbacContext } from "../abacTypes"
import type { AbacFieldDefinition } from "../abacCatalog"
import type { PolicyFilterClause } from "../abacPolicySchema"

const fields: Record<string, AbacFieldDefinition> = {
  status: { key: "status", type: "string", operators: ["equals", "in"] },
  age: { key: "age", type: "number", operators: ["greaterOrEqual", "between"] },
  active: { key: "active", type: "boolean", operators: ["isTrue"] },
  tags: { key: "tags", type: "string-array", operators: ["includesAny"] },
}
const context: AbacContext = { userId: "user-1", roleId: "role-1", branchId: "branch-1", tenantId: "tenant-1", custom: "value" }

describe("ABAC condition compiler", () => {
  const clauseCases: Array<[string, PolicyFilterClause, Record<string, unknown>, boolean]> = [
    [{ field: "status", operator: "equals", value: "active" }, { status: "active" }, true],
    [{ field: "age", operator: "greaterOrEqual", value: "18" }, { age: 21 }, true],
    [{ field: "active", operator: "isTrue" }, { active: true }, true],
    [{ field: "tags", operator: "includesAny", values: ["urgent", "vip"] }, { tags: ["vip"] }, true],
    [{ field: "status", operator: "equals", userAttr: "user.branchId" }, { status: "branch-1" }, true],
  ].map(([clause, record, expected], index) => [`case ${index}`, clause, record, expected]) as Array<[string, PolicyFilterClause, Record<string, unknown>, boolean]>

  it.each(clauseCases)("compiles %s", (_name, clause, record, expected) => {
    const result = policyClauseToPredicate({ clause, context, fieldCatalog: fields })
    expect(result.success).toBe(true)
    if (result.success) expect(evaluatePredicate(record, result.predicate)).toBe(expected)
  })

  it("compiles nested groups and combines system and user filters", () => {
    const result = policyConditionsToPredicate({
      context,
      fieldCatalog: fields,
      conditions: {
        version: 2,
        systemScope: { logic: "AND", conditions: [{ field: "status", operator: "equals", value: "active" }] },
        userFilters: { logic: "OR", conditions: [{ field: "age", operator: "greaterOrEqual", value: "18" }, { field: "active", operator: "isTrue" }] },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) expect(evaluatePredicate({ status: "active", age: 21, active: false }, result.predicate)).toBe(true)
  })

  const invalidCases: Array<[string, PolicyFilterClause, string]> = [
    ["unknown field", { field: "missing", operator: "equals", value: "x" }, "Unknown field"],
    ["invalid between", { field: "age", operator: "between", value: "18" }, "Invalid between value"],
    ["wrong contains type", { field: "age", operator: "contains", value: "1" }, "requires a string"],
    ["unsupported operator", { field: "status", operator: "unsupported" as never, value: "x" }, "Unsupported ABAC operator"],
  ]

  it.each(invalidCases)("reports %s", (_name, clause, message) => {
    const result = policyClauseToPredicate({ clause, context, fieldCatalog: fields })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain(message)
  })

  it("uses the correct identity for empty groups", () => {
    expect(conditionGroupToPredicate({ group: { logic: "AND", conditions: [] }, context, fieldCatalog: fields })).toMatchObject({ success: true, predicate: { kind: "and", filters: [] } })
    expect(conditionGroupToPredicate({ group: { logic: "OR", conditions: [] }, context, fieldCatalog: fields })).toMatchObject({ success: true, predicate: { kind: "or", filters: [] } })
  })

  it("maps string-array list operators to the exact matching predicate operator", () => {
    const arrayFields: Record<string, AbacFieldDefinition> = {
      tags: { key: "tags", type: "string-array", operators: ["includesAny", "includesAll", "in"] },
    }
    const includesAny = policyClauseToPredicate({ clause: { field: "tags", operator: "includesAny", values: ["urgent", "vip"] }, context, fieldCatalog: arrayFields })
    expect(includesAny.success).toBe(true)
    if (includesAny.success) expect(includesAny.predicate).toMatchObject({ kind: "condition", field: "tags", op: "includesAny" })

    const includesAll = policyClauseToPredicate({ clause: { field: "tags", operator: "includesAll", values: ["urgent", "vip"] }, context, fieldCatalog: arrayFields })
    expect(includesAll.success).toBe(true)
    if (includesAll.success) expect(includesAll.predicate).toMatchObject({ kind: "condition", field: "tags", op: "includesAll" })

    const inOp = policyClauseToPredicate({ clause: { field: "tags", operator: "in", values: ["urgent", "vip"] }, context, fieldCatalog: arrayFields })
    expect(inOp.success).toBe(true)
    if (inOp.success) expect(inOp.predicate).toMatchObject({ kind: "condition", field: "tags", op: "in" })
  })
})
