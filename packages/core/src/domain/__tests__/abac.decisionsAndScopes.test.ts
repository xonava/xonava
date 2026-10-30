import { describe, expect, it } from "vitest"
import { createAbacAuthorizer } from "../abacAuthorizer"
import { enforceAbacWrite, evaluateWriteAccessForRecordDetailed } from "../abacWrite"
import { Predicate } from "../predicate"
import type { AbacPolicyBundle, NormalizedAbacPolicy, VerifiedAbacPolicyBundle } from "../abacTypes"
import { buildActionScope } from "../abacReadScope"
import { bindAbacSecurityDigest } from "../abacBundleIntegrity"

function makePolicy(overrides: Partial<NormalizedAbacPolicy> = {}): NormalizedAbacPolicy {
  return {
    source: { policyId: "p1", scopeType: "tenant_default" },
    moduleKey: "tenant.records",
    effect: "allow",
    priority: 100,
    payload: {
      actions: ["read", "update", "delete"],
      capabilities: ["export"],
      conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } },
    },
    compiledConditions: Predicate.alwaysTrue(),
    ...overrides,
  }
}

async function makeBundle(policies: NormalizedAbacPolicy[]): Promise<AbacPolicyBundle> {
  return bindAbacSecurityDigest({ mode: "tenant", moduleKey: "tenant.records", policies, context: { tenantId: "t1" }, defaultEffect: "deny", fieldCatalog: {} })
}

describe("ABAC authorization and write edge paths", () => {
  it("covers collection, capability, scope, field-plan, and write assertions", async () => {
    const authorizer = createAbacAuthorizer(await makeBundle([makePolicy()]) as VerifiedAbacPolicyBundle)
    expect(authorizer.authorizeCollection("read").allowed).toBe(true)
    expect(authorizer.assertCollectionAction("read").allowed).toBe(true)
    expect(authorizer.canGlobalCapability("export")).toBe(true)
    expect(authorizer.canRecordCapability("export", {})).toBe(true)
    expect(authorizer.buildActionScope("read")).toBeDefined()
    expect(authorizer.fieldReadPlan({})).toEqual({})
    expect(() => authorizer.assertWrite({ action: "update", record: {} })).not.toThrow()

    expect(() => authorizer.assertCollectionAction("missing")).toThrow("Access denied")
    expect(() => authorizer.assertGlobalCapability("missing")).toThrow("Global capability denied")
    expect(() => authorizer.assertRecordCapability("missing", {})).toThrow("Record capability denied")
  })

  it("returns deny, no-match, and unmatched-record write decisions", async () => {
    const deny = makePolicy({ effect: "deny", source: { policyId: "deny", scopeType: "tenant_default" } })
    const unmatched = makePolicy({ compiledConditions: Predicate.eq("id", "other") })
    expect(evaluateWriteAccessForRecordDetailed({ policies: [deny], moduleKey: "tenant.records", action: "update", record: {} })).toMatchObject({ allowed: false, reasonCode: "DENY_POLICY_MATCHED" })
    expect(evaluateWriteAccessForRecordDetailed({ policies: [unmatched], moduleKey: "tenant.records", action: "update", record: { id: "row" } })).toMatchObject({ allowed: false, reasonCode: "NO_POLICY_MATCHED_RECORD" })
    expect(evaluateWriteAccessForRecordDetailed({ policies: [makePolicy()], moduleKey: "other", action: "update", record: {} })).toMatchObject({ allowed: false, reasonCode: "NO_RELEVANT_POLICY" })
    const denyBundle = await makeBundle([deny])
    expect(() => enforceAbacWrite({ bundle: denyBundle, action: "update", record: {} })).toThrow("current values")
    expect(() => enforceAbacWrite({ bundle: denyBundle, action: "delete", record: {} })).toThrow("current values")
  })

  it("builds default and policy-backed action scopes with cache keys", async () => {
    const policy = makePolicy({ compiledConditions: Predicate.eq("id", "row") })
    const emptyBundle = await makeBundle([])
    expect(() => buildActionScope({ bundle: { ...emptyBundle, defaultEffect: "allow", cacheScopeKey: "allow-cache" } as never, action: "read" })).toThrow("verified")
    expect(buildActionScope({ bundle: await makeBundle([]), action: "read" }).filter).toEqual(Predicate.alwaysFalse())
    const scopedBundle = await bindAbacSecurityDigest({ ...(await makeBundle([policy])), cacheScopeKey: "policy-cache" })
    const scoped = buildActionScope({ bundle: scopedBundle, action: "read" })
    expect(scoped.filter).toBeDefined()
    expect(scoped.cacheScopeKey).toBe("policy-cache")
    const combined = buildActionScope({ bundle: await makeBundle([policy, makePolicy({ source: { policyId: "p2", scopeType: "tenant_default" }, priority: 50, effect: "deny" })]), action: "read" })
    expect(combined.filter).toBeDefined()
    expect(buildActionScope({ bundle: await makeBundle([policy]), action: "missing" }).filter).toEqual(Predicate.alwaysFalse())
  })
})
