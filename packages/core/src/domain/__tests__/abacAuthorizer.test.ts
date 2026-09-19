import { describe, expect, it } from "vitest"
import { createAbacAuthorizer } from "../abacAuthorizer"
import { bindAbacSecurityDigest } from "../abacBundleIntegrity"
import { evaluateWriteAccessForRecordDetailed } from "../abacWrite"
import type { NormalizedAbacPolicy, VerifiedAbacPolicyBundle } from "../abacTypes"

function policy(overrides: Partial<NormalizedAbacPolicy> = {}): NormalizedAbacPolicy {
  return {
    source: { policyId: "policy-1", scopeType: "tenant_default" },
    moduleKey: "tenant.records",
    effect: "allow",
    priority: 100,
    payload: {
      actions: ["read", "update"],
      capabilities: ["export"],
      conditions: {
        version: 2,
        systemScope: { logic: "AND", conditions: [] },
        userFilters: { logic: "AND", conditions: [] },
      },
    },
    compiledConditions: { kind: "condition", field: "id", op: "eq", value: "row-1" },
    ...overrides,
  }
}

async function bundle(policies: NormalizedAbacPolicy[]): Promise<VerifiedAbacPolicyBundle> {
  return bindAbacSecurityDigest({
    mode: "tenant",
    moduleKey: "tenant.records",
    policies,
    context: { tenantId: "tenant-1" },
    defaultEffect: "deny",
    fieldCatalog: {},
  })
}

describe("ABAC authorizer", () => {
  it("authorizes matching actions and capabilities", async () => {
    const authorizer = createAbacAuthorizer(await bundle([policy()]))
    expect(authorizer.canRecordAction("read", { id: "row-1" })).toBe(true)
    expect(() => authorizer.assertRecordAction("read", { id: "row-1" })).not.toThrow()
    const globalAuthorizer = createAbacAuthorizer(await bundle([policy({ compiledConditions: { kind: "literal", value: true } })]))
    expect(globalAuthorizer.canGlobalCapability("export")).toBe(true)
    expect(() => globalAuthorizer.assertGlobalCapability("export")).not.toThrow()
  })

  it("throws structured forbidden errors for denied actions", async () => {
    const authorizer = createAbacAuthorizer(await bundle([policy()]))
    expect(authorizer.canRecordAction("delete", { id: "row-1" })).toBe(false)
    expect(() => authorizer.assertRecordAction("delete", { id: "row-1" })).toThrow("Access denied")
    expect(() => authorizer.assertRecordCapability("manage", { id: "row-1" })).toThrow("Record capability denied")
  })

  it("returns detailed write decisions", () => {
    expect(evaluateWriteAccessForRecordDetailed({
      policies: [policy()],
      moduleKey: "tenant.records",
      action: "update",
      record: { id: "row-1" },
    })).toMatchObject({ allowed: true, reasonCode: "ALLOW_POLICY_MATCHED" })

    expect(evaluateWriteAccessForRecordDetailed({
      policies: [],
      moduleKey: "tenant.records",
      action: "update",
      record: { id: "row-1" },
    })).toMatchObject({ allowed: false, reasonCode: "NO_RELEVANT_POLICY" })
  })
})
