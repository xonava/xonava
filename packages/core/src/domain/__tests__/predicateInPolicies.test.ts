import { describe, expect, it } from "vitest"
import { findUnsupportedPredicateCombination, Predicate } from "../predicate"
import type { AbacFieldDefinition } from "../abacCatalog"

const fields: Record<string, AbacFieldDefinition> = {
  ownerId: { key: "ownerId", type: "identifier", operators: [] },
  amount: { key: "amount", type: "number", operators: [] },
  tags: { key: "tags", type: "string-array", operators: [] },
}

describe("`in` is a supported policy operator on scalar fields", () => {
  it("accepts a list of scalars", () => {
    expect(findUnsupportedPredicateCombination(Predicate.in("ownerId", ["u1", "u2"]), fields)).toBeUndefined()
    expect(findUnsupportedPredicateCombination(Predicate.in("amount", [1, 2.5, null]), fields)).toBeUndefined()
    expect(findUnsupportedPredicateCombination(Predicate.in("ownerId", []), fields)).toBeUndefined()
  })

  it("still rejects non-scalar members, non-list values, and array fields", () => {
    expect(findUnsupportedPredicateCombination({ kind: "condition", field: "ownerId", op: "in", value: [["u1"]] as never }, fields)?.message).toMatch(/scalar/)
    expect(findUnsupportedPredicateCombination({ kind: "condition", field: "ownerId", op: "in", value: [{ from: 1 }] as never }, fields)?.message).toMatch(/scalar/)
    expect(findUnsupportedPredicateCombination({ kind: "condition", field: "ownerId", op: "in", value: "u1" }, fields)?.message).toMatch(/array value/)
    expect(findUnsupportedPredicateCombination(Predicate.in("tags", ["x"]), fields)?.message).toMatch(/scalar field/)
  })
})

describe("an `in` policy condition normalizes end to end", () => {
  it("is accepted by the policy normalizer and evaluates as membership", async () => {
    const { normalizeAbacPolicy } = await import("../abacPolicyNormalizer")
    const { evaluatePredicate } = await import("../evaluatePredicate")
    const result = normalizeAbacPolicy({
      policy: {
        source: { policyId: "p-in", scopeType: "tenant_default" },
        moduleKey: "m",
        effect: "allow",
        priority: 1,
        payload: {
          actions: ["read"],
          capabilities: [],
          conditions: { version: 2, systemScope: { logic: "AND", conditions: [{ field: "status", operator: "in", values: ["draft", "open"] }] }, userFilters: { logic: "AND", conditions: [] } },
        },
      },
      catalog: { moduleKey: "m", actions: ["read"], capabilities: [], fields: { status: { key: "status", type: "string", operators: ["in"] } } },
      context: { userId: "u1", tenantId: "t1" },
    })
    expect(result.success, JSON.stringify(result)).toBe(true)
    if (!result.success) return
    expect(evaluatePredicate({ status: "open" }, result.policy.compiledConditions)).toBe(true)
    expect(evaluatePredicate({ status: "closed" }, result.policy.compiledConditions)).toBe(false)
  })
})
