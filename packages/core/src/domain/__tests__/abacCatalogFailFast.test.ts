import { describe, expect, expectTypeOf, it } from "vitest"
import { assertAbacPoliciesMatchCatalog, createAbacBundle } from "../abacBundleFactory"
import { assertVerifiedAbacBundle } from "../abacBundleIntegrity"
import { defineAbacModule } from "../abacCatalog"
import { InvalidPolicyConfigurationError } from "../errors"
import type { AbacPolicy, VerifiedAbacPolicyBundle } from "../abacTypes"

const MODULE = "shop.orders"
const catalog = defineAbacModule({
  moduleKey: MODULE,
  actions: ["read", "update"],
  capabilities: [],
  fields: {
    id: { key: "id", type: "identifier", operators: ["equals"] },
    status: { key: "status", type: "string", operators: ["equals"] },
  },
})

function policy(overrides: { actions?: string[]; field?: string; fieldAccess?: NonNullable<AbacPolicy["payload"]["fieldAccess"]> } = {}): AbacPolicy {
  return {
    source: { policyId: "p1", scopeType: "tenant_default" },
    moduleKey: MODULE,
    effect: "allow",
    priority: 1,
    payload: {
      actions: overrides.actions ?? ["read"],
      capabilities: [],
      conditions: {
        version: 2,
        systemScope: { logic: "AND", conditions: [{ field: overrides.field ?? "status", operator: "equals", value: "open" }] },
        userFilters: { logic: "AND", conditions: [] },
      },
      ...(overrides.fieldAccess ? { fieldAccess: overrides.fieldAccess } : {}),
    },
  }
}

const mismatches: Array<[string, AbacPolicy, string[] | undefined]> = [
  ["unknown action", policy({ actions: ["read", "delete"] }), undefined],
  ["unknown condition field", policy({ field: "customerId" }), ["customerId"]],
  ["unknown fieldAccess read field", policy({ fieldAccess: { read: { status: "allow", secret: "allow" } } }), ["secret"]],
  ["unknown fieldAccess write field", policy({ fieldAccess: { write: ["status", "note"] } }), ["note"]],
  ["unknown fieldAccess query field", policy({ fieldAccess: { query: { filter: ["status"], search: ["title"], sort: ["created"] } } }), ["title", "created"]],
]

describe("policy/catalog mismatch is a configuration error found at construction", () => {
  for (const [name, bad, fields] of mismatches) {
    it(`createAbacBundle rejects ${name} with module, policy and field names`, async () => {
      const error = await createAbacBundle({
        provider: { resolve: async () => [bad] }, mode: "tenant", moduleKey: MODULE, catalog, context: { tenantId: "t1" },
      }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(InvalidPolicyConfigurationError)
      expect(error).toMatchObject({ code: "INVALID_POLICY_CONFIGURATION", moduleKey: MODULE, policyId: "p1" })
      expect((error as InvalidPolicyConfigurationError).missingFields).toEqual(fields)
      expect((error as InvalidPolicyConfigurationError).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "CATALOG_VALIDATION_FAILED" })]))
    })

    it(`assertAbacPoliciesMatchCatalog rejects ${name} before any bundle or request exists`, () => {
      try {
        assertAbacPoliciesMatchCatalog({ moduleKey: MODULE, catalog, policies: [bad] })
        expect.unreachable("expected a configuration error")
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidPolicyConfigurationError)
        expect(error).toMatchObject({ moduleKey: MODULE, policyId: "p1" })
        expect((error as InvalidPolicyConfigurationError).missingFields).toEqual(fields)
      }
    })
  }

  it("names the missing fields in the message and identifies the first failing policy among many", () => {
    const second = { ...policy({ field: "customerId" }), source: { policyId: "p2", scopeType: "tenant_default" as const } }
    expect(() => assertAbacPoliciesMatchCatalog({ moduleKey: MODULE, catalog, policies: [policy(), second] }))
      .toThrow(/customerId/)
    try {
      assertAbacPoliciesMatchCatalog({ moduleKey: MODULE, catalog, policies: [policy(), second] })
    } catch (error) {
      expect(error).toMatchObject({ policyId: "p2" })
    }
  })

  it("validates policies that would not apply to the request context or are inactive", async () => {
    const inactive = policy({ field: "customerId" })
    inactive.source = { ...inactive.source, endsAt: new Date("2020-01-01") }
    expect(() => assertAbacPoliciesMatchCatalog({ moduleKey: MODULE, catalog, policies: [inactive], at: new Date("2026-01-01") })).toThrow(InvalidPolicyConfigurationError)
  })

  it("rejects a catalog for another module", () => {
    expect(() => assertAbacPoliciesMatchCatalog({ moduleKey: "other", catalog, policies: [] }))
      .toThrow(expect.objectContaining({ moduleKey: "other", catalogModuleKey: MODULE }))
  })

  it("still builds a valid bundle, typed and registered as verified", async () => {
    const bundle = await createAbacBundle({
      provider: { resolve: async () => [policy({ actions: ["read", "update"], fieldAccess: { read: { id: "allow", status: "allow" }, write: ["status"], query: { filter: ["status"] } } })] },
      mode: "tenant", moduleKey: MODULE, catalog, context: { tenantId: "t1" },
    })
    expectTypeOf(bundle).toEqualTypeOf<VerifiedAbacPolicyBundle>()
    expect(() => assertVerifiedAbacBundle(bundle)).not.toThrow()
    expect(bundle.policies).toHaveLength(1)
    expect(() => assertAbacPoliciesMatchCatalog({ moduleKey: MODULE, catalog, policies: [policy()] })).not.toThrow()
  })
})
