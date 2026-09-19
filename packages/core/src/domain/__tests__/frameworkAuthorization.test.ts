import { describe, expect, it } from "vitest"
import { assertFrameworkAuthorization, evaluateModuleAuthorization } from "../frameworkAuthorization"
import { bindAbacSecurityDigest } from "../abacBundleIntegrity"
import { Predicate } from "../predicate"

const tenantFacts = {
  scope: "tenant" as const,
  enabledModuleKeys: ["records"],
  enabledModuleActions: { records: ["read", "update"] },
  enabledModuleCapabilities: { records: ["export"] },
  ownerAuthority: false,
  impersonated: false,
}

describe("framework authorization", () => {
  it("owns module, action, capability, and owner decisions", () => {
    expect(evaluateModuleAuthorization({ facts: tenantFacts, moduleKey: "records", action: "read" }).allowed).toBe(true)
    expect(evaluateModuleAuthorization({ facts: tenantFacts, moduleKey: "records", action: "delete" }).allowed).toBe(false)
    expect(evaluateModuleAuthorization({ facts: tenantFacts, moduleKey: "records", action: "read", capabilityKey: "admin" }).allowed).toBe(false)
    expect(evaluateModuleAuthorization({ facts: { ...tenantFacts, ownerAuthority: true }, moduleKey: "missing", action: "delete" })).toEqual({ allowed: true, ownerBypass: true })
  })

  it("requires verified ABAC and evaluates action and capability in core", async () => {
    const bundle = await bindAbacSecurityDigest({
      mode: "tenant",
      moduleKey: "records",
      policies: [{
        source: { policyId: "allow", scopeType: "tenant_default" },
        moduleKey: "records",
        effect: "allow",
        priority: 1,
        payload: {
          actions: ["read"],
          capabilities: ["export"],
          conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } },
        },
        compiledConditions: Predicate.alwaysTrue(),
      }],
      context: { tenantId: "tenant-1" },
      defaultEffect: "deny",
      fieldCatalog: {},
    })
    expect(() => assertFrameworkAuthorization({ facts: tenantFacts, moduleKey: "records", action: "read", capabilityKey: "export", bundle })).not.toThrow()
    expect(() => assertFrameworkAuthorization({ facts: tenantFacts, moduleKey: "records", action: "update", bundle })).toThrow("Access denied")
  })

  it("fails closed when a required ABAC bundle is absent while preserving explicit module-only authorization", () => {
    expect(() => assertFrameworkAuthorization({ facts: tenantFacts, moduleKey: "records", action: "read" }))
      .toThrow("ABAC policy bundle is required")
    expect(assertFrameworkAuthorization({ facts: tenantFacts, moduleKey: "records", action: "read", abacRequirement: "optional" }))
      .toEqual({ allowed: true, ownerBypass: false })
  })
})
