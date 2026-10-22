import { describe, expect, it } from "vitest"
import { ForbiddenError } from "../errors"
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

// TM13b: module entitlements (enabledModuleKeys, enabledModuleActions,
// enabledModuleCapabilities) are consulted for the tenant scope only. Platform,
// application, system and public scopes are authorized by ABAC alone. These
// tests pin that, so a later change cannot start reading entitlements there.
describe("framework authorization on scopes without module entitlements", () => {
  const entitlementShapes = {
    "no entitlement fields at all": {},
    "empty lists": { enabledModuleKeys: [], enabledModuleActions: {}, enabledModuleCapabilities: {} },
    "only another module enabled": { enabledModuleKeys: ["other"], enabledModuleActions: { other: ["read"] }, enabledModuleCapabilities: { other: ["export"] } },
    "the module enabled with no actions or capabilities": { enabledModuleKeys: ["records"], enabledModuleActions: { records: [] }, enabledModuleCapabilities: { records: [] } },
  } as const
  const scopes = ["platform", "application", "system", "public"] as const

  for (const scope of scopes) {
    for (const [label, entitlements] of Object.entries(entitlementShapes)) {
      it(`allows ${scope} scope whatever the entitlements hold: ${label}`, () => {
        const facts = { scope, ...entitlements, ownerAuthority: false, impersonated: false }
        for (const action of ["read", "create", "update", "delete", "manage", "approve"]) {
          expect(evaluateModuleAuthorization({ facts, moduleKey: "records", action })).toEqual({ allowed: true, ownerBypass: false })
          expect(evaluateModuleAuthorization({ facts, moduleKey: "records", action, capabilityKey: "admin" })).toEqual({ allowed: true, ownerBypass: false })
        }
      })
    }
  }

  it("applies the same entitlements to the tenant scope, so the difference is the scope and not the data", () => {
    for (const entitlements of Object.values(entitlementShapes)) {
      const facts = { scope: "tenant" as const, ...entitlements, ownerAuthority: false, impersonated: false }
      expect(evaluateModuleAuthorization({ facts, moduleKey: "records", action: "delete", capabilityKey: "admin" }).allowed).toBe(false)
    }
  })

  it("does not read the entitlement fields for a non-tenant scope", () => {
    const reads: string[] = []
    const tracked = new Proxy({ scope: "platform" as const, ownerAuthority: false, impersonated: false }, {
      get(target, property, receiver) {
        if (typeof property === "string" && property.startsWith("enabledModule")) reads.push(property)
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    expect(evaluateModuleAuthorization({ facts: tracked, moduleKey: "records", action: "delete", capabilityKey: "admin" }).allowed).toBe(true)
    expect(reads).toEqual([])
  })

  it("still fails closed on a platform scope without a verified ABAC bundle", async () => {
    const facts = { scope: "platform" as const, ownerAuthority: false, impersonated: false }
    expect(() => assertFrameworkAuthorization({ facts, moduleKey: "records", action: "read" })).toThrow("ABAC policy bundle is required")
    expect(() => assertFrameworkAuthorization({ facts, moduleKey: "records", action: "read", bundle: null })).toThrow(ForbiddenError)
    // A bundle that was never verified (forged shape) is refused, not trusted.
    const forged = { mode: "platform", moduleKey: "records", policies: [], context: {}, defaultEffect: "allow", fieldCatalog: {}, securityDigest: "forged" } as never
    expect(() => assertFrameworkAuthorization({ facts, moduleKey: "records", action: "read", bundle: forged })).toThrow()
    // With a verified bundle that grants nothing, the platform scope is denied by ABAC alone.
    const bundle = await bindAbacSecurityDigest({ mode: "platform", moduleKey: "records", policies: [], context: {}, defaultEffect: "deny", fieldCatalog: {} })
    expect(() => assertFrameworkAuthorization({ facts, moduleKey: "records", action: "read", bundle })).toThrow("Access denied")
  })

  it("lets a verified allow bundle authorize a platform scope with no entitlements at all", async () => {
    const bundle = await bindAbacSecurityDigest({
      mode: "platform",
      moduleKey: "records",
      policies: [{
        source: { policyId: "allow", scopeType: "platform_default" },
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
      context: {},
      defaultEffect: "deny",
      fieldCatalog: {},
    })
    for (const scope of ["platform", "application", "system"] as const) {
      const facts = { scope, enabledModuleKeys: [], enabledModuleActions: {}, enabledModuleCapabilities: {}, ownerAuthority: false, impersonated: false }
      expect(assertFrameworkAuthorization({ facts, moduleKey: "records", action: "read", capabilityKey: "export", bundle })).toEqual({ allowed: true, ownerBypass: false })
      // ABAC still decides: an action the bundle does not grant is denied.
      expect(() => assertFrameworkAuthorization({ facts, moduleKey: "records", action: "delete", bundle })).toThrow("Access denied")
    }
  })
})
