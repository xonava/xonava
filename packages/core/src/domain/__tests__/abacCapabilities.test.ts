import { describe, expect, it } from "vitest"
import { hasGlobalAbacCapability, hasRecordAbacCapability, resolveGrantedGlobalCapabilities } from "../abacCapabilities"
import { Predicate } from "../predicate"
import type { AbacPolicyBundle, NormalizedAbacPolicy } from "../abacTypes"

function policy(overrides: Partial<NormalizedAbacPolicy> = {}): NormalizedAbacPolicy {
  return {
    source: { policyId: "policy-1", scopeType: "role" },
    moduleKey: "tenant.people",
    effect: "allow",
    priority: 10,
    payload: {
      actions: [],
      capabilities: ["export"],
      conditions: {
        version: 2,
        systemScope: { logic: "AND", conditions: [] },
        userFilters: { logic: "AND", conditions: [] },
      },
    },
    compiledConditions: Predicate.alwaysTrue(),
    ...overrides,
  }
}

function bundle(policies: NormalizedAbacPolicy[]): AbacPolicyBundle {
  return {
    mode: "tenant",
    moduleKey: "tenant.people",
    policies,
    context: { userId: "user-1", tenantId: "tenant-1" },
    defaultEffect: "deny",
    fieldCatalog: {},
  }
}

describe("ABAC capability helpers", () => {
  it("grants global capabilities only from unconditional policies", () => {
    const conditioned = policy({
      compiledConditions: Predicate.eq("status", "active"),
    })
    const policies = [conditioned, policy({ source: { policyId: "policy-2", scopeType: "tenant_default" } })]

    expect(hasGlobalAbacCapability({ bundle: bundle(policies), capabilityKey: "export" })).toBe(true)
    expect(hasGlobalAbacCapability({ bundle: bundle([conditioned]), capabilityKey: "export" })).toBe(false)
  })

  it("evaluates conditioned capabilities against a record", () => {
    const capabilityPolicy = policy({ compiledConditions: Predicate.eq("status", "active") })
    const capabilityBundle = bundle([capabilityPolicy])

    expect(hasRecordAbacCapability({ bundle: capabilityBundle, capabilityKey: "export", record: { status: "active" } })).toBe(true)
    expect(hasRecordAbacCapability({ bundle: capabilityBundle, capabilityKey: "export", record: { status: "inactive" } })).toBe(false)
  })

  it("resolves only capabilities declared for the bundle module", () => {
    const otherModule = policy({
      moduleKey: "tenant.appointments",
      payload: { ...policy().payload, capabilities: ["book"] },
    })
    const granted = resolveGrantedGlobalCapabilities({ bundle: bundle([policy(), otherModule]) })

    expect(granted).toEqual(new Set(["export"]))
  })
})
