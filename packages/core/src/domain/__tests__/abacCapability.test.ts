import { describe, it, expect } from "vitest"
import { hasGlobalAbacCapability, hasRecordAbacCapability as _hasRecordAbacCapability } from "../abacCapabilities"
import type { NormalizedAbacPolicy, AbacPolicyBundle } from "../abacTypes"

function makeNP(overrides: Partial<NormalizedAbacPolicy> = {}): NormalizedAbacPolicy {
  const payloadConds = overrides.payload?.conditions
  const hasConditions =
    (payloadConds?.systemScope?.conditions?.length ?? 0) > 0 ||
    (payloadConds?.userFilters?.conditions?.length ?? 0) > 0

  return {
    source: { policyId: "test", scopeType: "tenant_default" },
    moduleKey: "test.module",
    effect: "allow",
    priority: 100,
    payload: {
      actions: [],
      capabilities: ["export"],
      conditions: {
        version: 2,
        systemScope: { logic: "AND", conditions: payloadConds?.systemScope?.conditions ?? [] },
        userFilters: { logic: "AND", conditions: payloadConds?.userFilters?.conditions ?? [] },
      },
    },
    compiledConditions: hasConditions
      ? { kind: "condition", field: "branchId", op: "eq", value: "branch-1" }
      : { kind: "literal", value: true },
    ...overrides,
  }
}

function makeBundle(overrides: Partial<AbacPolicyBundle> = {}): AbacPolicyBundle {
  return {
    mode: "tenant",
    moduleKey: "test.module",
    policies: [] as NormalizedAbacPolicy[],
    context: {},
    defaultEffect: "deny",
    fieldCatalog: {},
    ...overrides,
  }
}

describe("hasGlobalAbacCapability", () => {
  it("allows unrestricted capability", () => {
    const result = hasGlobalAbacCapability({
      bundle: { mode: "tenant", moduleKey: "test.module", policies: [makeNP()], context: {}, defaultEffect: "deny", fieldCatalog: {} },
      capabilityKey: "export",
    })
    expect(result).toBe(true)
  })

  it("rejects conditioned capability as global", () => {
    const result = hasGlobalAbacCapability({
      bundle: {
        mode: "tenant",
        moduleKey: "test.module",
        policies: [makeNP({
          payload: {
            actions: [],
            capabilities: ["export"],
            conditions: {
              version: 2,
              systemScope: { logic: "AND", conditions: [{ field: "branchId", operator: "equals", value: "branch-1" }] },
              userFilters: { logic: "AND", conditions: [] },
            },
          },
        })],
        context: {},
        defaultEffect: "deny",
        fieldCatalog: {},
      },
      capabilityKey: "export",
    })
    expect(result).toBe(false)
  })

  it("conditioned capability cannot grant global access", () => {
    const result = hasGlobalAbacCapability({
      bundle: makeBundle({
        policies: [makeNP({
          payload: {
            actions: [],
            capabilities: ["export"],
            conditions: {
              version: 2,
              systemScope: { logic: "AND", conditions: [{ field: "branchId", operator: "equals", value: "branch-1" }] },
              userFilters: { logic: "AND", conditions: [] },
            },
          },
        })],
      }),
      capabilityKey: "export",
    })
    expect(result).toBe(false)
  })
})
