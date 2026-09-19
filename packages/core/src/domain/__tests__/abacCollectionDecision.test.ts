import { describe, it, expect } from "vitest"
import { evaluateAbacActionForCollection } from "../abacDecision"
import { bindAbacSecurityDigest } from "../abacBundleIntegrity"
import type { NormalizedAbacPolicy, AbacPolicyBundle } from "../abacTypes"
import { Predicate, type PredicateNode } from "../predicate"

function makeNP(overrides: Partial<NormalizedAbacPolicy> = {}): NormalizedAbacPolicy {
  return {
    source: { policyId: `policy-${Math.random()}`, scopeType: "tenant_default" },
    moduleKey: "test.module",
    effect: "allow",
    priority: 100,
    payload: {
      actions: ["read"],
      capabilities: [],
      conditions: {
        version: 2,
        systemScope: { logic: "AND", conditions: [] },
        userFilters: { logic: "AND", conditions: [] },
      },
    },
    compiledConditions: { kind: "literal", value: true },
    ...overrides,
  }
}

async function makeBundle(overrides: Partial<AbacPolicyBundle> = {}): Promise<AbacPolicyBundle> {
  return bindAbacSecurityDigest({
    mode: "tenant",
    moduleKey: "test.module",
    policies: [] as NormalizedAbacPolicy[],
    context: { userId: "user-1" },
    defaultEffect: "deny",
    fieldCatalog: {},
    ...overrides,
  })
}

describe("evaluateAbacActionForCollection", () => {
  it("allows access when unrestricted allow policy exists", async () => {
    const result = evaluateAbacActionForCollection({
      bundle: await makeBundle({
        policies: [makeNP()],
      }),
      action: "read",
    })
    expect(result.allowed).toBe(true)
    expect(result.reasonCode).toBe("ACTION_SCOPE_AVAILABLE")
  })

  it("denies access when no allow policy exists and default is deny", async () => {
    const result = evaluateAbacActionForCollection({
      bundle: await makeBundle({ policies: [] }),
      action: "read",
    })
    expect(result.allowed).toBe(false)
    expect(result.reasonCode).toBe("STATICALLY_DENIED")
  })

  it("conditional deny does not deny collection — restricts scope", async () => {
    const result = evaluateAbacActionForCollection({
      bundle: await makeBundle({
        policies: [
          makeNP({
            effect: "deny",
            priority: 200,
            compiledConditions: { kind: "condition", field: "branchId", op: "eq", value: "branch-a" } as PredicateNode,
            payload: {
              actions: ["read"],
              capabilities: [],
              conditions: {
                version: 2,
                systemScope: { logic: "AND", conditions: [{ field: "branchId", operator: "equals", value: "branch-a" }] },
                userFilters: { logic: "AND", conditions: [] },
              },
            },
          }),
          makeNP({
            priority: 100,
            compiledConditions: { kind: "literal", value: true } as PredicateNode,
          }),
        ],
      }),
      action: "read",
    })
    expect(result.allowed).toBe(true)
  })

  it("conditional high-priority deny does not deny collection — restricts scope", async () => {
    const result = evaluateAbacActionForCollection({
      bundle: await makeBundle({
        policies: [
          makeNP({
            effect: "deny",
            priority: 200,
            compiledConditions: Predicate.eq("branchId", "branch-a"),
            payload: {
              actions: ["read"],
              capabilities: [],
              conditions: {
                version: 2,
                systemScope: { logic: "AND", conditions: [{ field: "branchId", operator: "equals", value: "branch-a" }] },
                userFilters: { logic: "AND", conditions: [] },
              },
            },
          }),
          makeNP({
            priority: 100,
            compiledConditions: Predicate.alwaysTrue(),
          }),
        ],
      }),
      action: "read",
    })
    expect(result.allowed).toBe(true)
  })
})
