import { describe, expect, it, vi } from "vitest"
import { createAbacBundle } from "../abacBundleFactory"
import { assertAbacSecurityDigest, bindAbacSecurityDigest } from "../abacBundleIntegrity"
import type { AbacModuleCatalog } from "../abacCatalog"
import type { AbacPolicy } from "../abacTypes"
import type { AbacPolicyProvider } from "../../security/abacPolicyProvider"

const catalog: AbacModuleCatalog = {
  moduleKey: "tenant.patients",
  actions: ["read", "update"],
  capabilities: ["manage"],
  fields: { status: { key: "status", type: "string", operators: ["equals"] } },
}

function policy(policyId: string, scopeType: AbacPolicy["source"]["scopeType"], priority: number, value = "active"): AbacPolicy {
  return {
    source: { policyId, scopeType, ...(scopeType === "role" ? { scopeRefId: "role-1" } : scopeType === "user" ? { scopeRefId: "user-1" } : scopeType === "branch" ? { scopeRefId: "branch-1" } : {}) },
    moduleKey: "tenant.patients",
    effect: "allow",
    priority,
    payload: {
      actions: ["read"],
      capabilities: [],
      conditions: {
        version: 2,
        systemScope: { logic: "AND", conditions: [{ field: "status", operator: "equals", value }] },
        userFilters: { logic: "AND", conditions: [] },
      },
    },
  }
}

function input(provider: AbacPolicyProvider, overrides: Partial<Parameters<typeof createAbacBundle>[0]> = {}): Parameters<typeof createAbacBundle>[0] {
  return {
    provider,
    mode: "tenant",
    moduleKey: "tenant.patients",
    context: { userId: "user-1", roleId: "role-1", branchId: "branch-1", tenantId: "tenant-1" },
    catalog,
    ...overrides,
  }
}

describe("createAbacBundle", () => {
  it("resolves, normalizes, and orders policies by priority, scope, then id", async () => {
    const provider = { resolve: vi.fn(async () => [
      policy("z-role", "role", 10),
      policy("a-user", "user", 10),
      policy("b-branch", "branch", 10),
      policy("low", "user", 1),
    ]) }
    const bundle = await createAbacBundle(input(provider))
    expect(provider.resolve).toHaveBeenCalledWith({
      mode: "tenant",
      moduleKey: "tenant.patients",
       context: { userId: "user-1", roleId: "role-1", branchId: "branch-1", tenantId: "tenant-1" },
    })
    expect(bundle.policies.map(({ source }) => source.policyId)).toEqual(["z-role", "b-branch", "a-user", "low"])
    expect(bundle.defaultEffect).toBe("deny")
    expect(bundle.fieldCatalog).toEqual(catalog.fields)
    expect(bundle.fieldCatalog).not.toBe(catalog.fields)
    expect(bundle.policies[0]?.compiledConditions).toBeDefined()
  })

  it("is always deny-by-default and cannot be configured allow-default", async () => {
    const provider = { resolve: vi.fn(async () => []) }
    const bundle = await createAbacBundle(input(provider, { mode: "platform" }))
    expect(bundle.mode).toBe("platform")
    expect(bundle.defaultEffect).toBe("deny")
  })

  it("rejects a catalog for another module before policy normalization", async () => {
    const provider = { resolve: vi.fn(async () => []) }
    const error = await createAbacBundle(input(provider, {
      catalog: { ...catalog, moduleKey: "tenant.other" },
    })).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ name: "InvalidPolicyConfigurationError", moduleKey: "tenant.patients", catalogModuleKey: "tenant.other" })
  })

  it("aggregates normalization failures and identifies the first policy", async () => {
    const badPolicy = policy("bad-1", "role", 1)
    badPolicy.payload.conditions.systemScope.conditions = [{ field: "missing", operator: "equals", value: "x" }]
    const provider = { resolve: vi.fn(async () => [badPolicy, {
      ...policy("bad-2", "user", 1),
      moduleKey: "tenant.other",
    }]) }
    const error = await createAbacBundle(input(provider)).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ name: "InvalidPolicyConfigurationError", policyId: "bad-1" })
    expect(error).toHaveProperty("issues", expect.arrayContaining([expect.objectContaining({ policyId: "bad-2" })]))
  })

  it("excludes inactive policies but rejects context-unbound policies", async () => {
    const provider = { resolve: vi.fn(async () => [{
      ...policy("expired", "user", 1),
      source: { ...policy("expired", "user", 1).source, endsAt: new Date("2020-01-01") },
    }, {
      ...policy("wrong-user", "user", 1),
      source: { policyId: "wrong-user", scopeType: "user" as const, scopeRefId: "other-user" },
    }]) }
    const error = await createAbacBundle(input(provider, { at: new Date("2026-01-01") })).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ name: "InvalidPolicyConfigurationError", policyId: "wrong-user" })
    expect(error).toHaveProperty("issues", expect.arrayContaining([
      expect.objectContaining({ code: "POLICY_SCOPE_MISMATCH" }),
    ]))
    expect((error as { issues?: unknown[] }).issues).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "POLICY_INACTIVE" })]))
  })

  it("skips inactive policies instead of failing the whole bundle", async () => {
    const expired = policy("expired", "user", 1)
    expired.source = { ...expired.source, endsAt: new Date("2020-01-01") }
    const future = policy("future", "user", 1)
    future.source = { ...future.source, startsAt: new Date("2027-01-01") }
    const provider = { resolve: vi.fn(async () => [expired, future, policy("active", "user", 1)]) }
    const bundle = await createAbacBundle(input(provider, { at: new Date("2026-01-01") }))
    expect(bundle.policies.map(({ source }) => source.policyId)).toEqual(["active"])
    expect(bundle.inactivePolicyIds).toEqual(["expired", "future"])
  })

  it("treats a missing required scope ref as an invalid policy", async () => {
    const provider = { resolve: vi.fn(async () => [{
      ...policy("no-ref", "user", 1),
      source: { policyId: "no-ref", scopeType: "user" as const },
    }]) }
    const error = await createAbacBundle(input(provider)).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ name: "InvalidPolicyConfigurationError", policyId: "no-ref" })
    expect(error).toHaveProperty("issues", expect.arrayContaining([
      expect.objectContaining({ code: "POLICY_SCOPE_INVALID" }),
    ]))
  })

  it("rejects invalid windows and bindings across bundle modes", async () => {
    const invalidWindow = policy("invalid-window", "user", 1)
    invalidWindow.source = { ...invalidWindow.source, startsAt: new Date("2027-01-01"), endsAt: new Date("2026-01-01") }
    const future = policy("future", "user", 1)
    future.source = { ...future.source, startsAt: new Date("2027-01-01") }
    const provider = { resolve: vi.fn(async () => [invalidWindow, future]) }
    const error = await createAbacBundle(input(provider, { at: new Date("2026-01-01") })).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ name: "InvalidPolicyConfigurationError", policyId: "invalid-window" })
    expect(error).toHaveProperty("issues", expect.arrayContaining([
      expect.objectContaining({ code: "POLICY_WINDOW_INVALID" }),
    ]))
    expect((error as { issues?: unknown[] }).issues).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "POLICY_INACTIVE" })]))

    const platformPolicy = policy("tenant-scope", "tenant_default", 1)
    const platformError = await createAbacBundle(input({ resolve: vi.fn(async () => [platformPolicy]) }, {
      mode: "platform",
      context: { userId: "user-1", tenantId: "tenant-1" },
    })).catch((caught: unknown) => caught)
    expect(platformError).toMatchObject({ name: "InvalidPolicyConfigurationError", policyId: "tenant-scope" })
    expect(platformError).toHaveProperty("issues", expect.arrayContaining([expect.objectContaining({ code: "POLICY_SCOPE_MISMATCH" })]))
  })

  it("orders equal-priority policies by policy id within the same scope", async () => {
    const provider = { resolve: vi.fn(async () => [policy("z-user", "user", 10), policy("a-user", "user", 10)]) }
    const bundle = await createAbacBundle(input(provider))
    expect(bundle.policies.map(({ source }) => source.policyId)).toEqual(["a-user", "z-user"])
  })

  it("binds department and unscoped default policies to the active context", async () => {
    const department = policy("department", "department", 2)
    department.source = { ...department.source, scopeRefId: "department-1" }
    const tenantDefault = policy("tenant-default", "tenant_default", 1)
    const bundle = await createAbacBundle(input({ resolve: vi.fn(async () => [department, tenantDefault]) }, {
      context: { userId: "user-1", roleId: "role-1", branchId: "branch-1", departmentId: "department-1", tenantId: "tenant-1" },
    }))
    expect(bundle.policies.map(({ source }) => source.policyId)).toEqual(["department", "tenant-default"])

    const platformUser = policy("platform-user", "user", 1)
    const platformBundle = await createAbacBundle(input({ resolve: vi.fn(async () => [platformUser]) }, {
      mode: "platform",
      context: { userId: "user-1" },
    }))
    expect(platformBundle.policies).toHaveLength(1)
  })

  it("deep-freezes the bundle and derives a complete security digest", async () => {
    const bundle = await createAbacBundle(input({ resolve: vi.fn(async () => [policy("one", "user", 1)]) }))
    expect(bundle.securityDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(bundle)).toBe(true)
    expect(Object.isFrozen(bundle.context)).toBe(true)
    expect(Object.isFrozen(bundle.policies[0])).toBe(true)
    expect(Object.isFrozen(bundle.policies[0]?.payload)).toBe(true)
    expect(() => {
      bundle.context.userId = "other-user"
    }).toThrow()
  })

  it("rejects a mutated bundle whose digest no longer matches", async () => {
    const original = await createAbacBundle(input({ resolve: vi.fn(async () => [policy("one", "user", 1)]) }))
    const mutableCopy = { ...original, context: { ...original.context, userId: "other-user" } }

    await expect(assertAbacSecurityDigest(mutableCopy)).rejects.toThrow("not a verified production bundle")
  })

  it("rejects a bundle with a missing security digest", async () => {
    const original = await createAbacBundle(input({ resolve: vi.fn(async () => [policy("one", "user", 1)]) }))
    const { securityDigest: _digest, ...withoutDigest } = original
    await expect(assertAbacSecurityDigest(withoutDigest)).rejects.toThrow("digest is missing")
  })

  it("binds the digest after composing additional bundle fields", async () => {
    const original = await createAbacBundle(input({ resolve: vi.fn(async () => [policy("one", "user", 1)]) }))
    const composed = await bindAbacSecurityDigest({ ...original, cacheScopeKey: "scope-1" })

    await expect(assertAbacSecurityDigest(composed)).resolves.toBeUndefined()
    expect(Object.isFrozen(composed)).toBe(true)
  })

  it("forwards the evaluation time and rejects bindings with missing context references", async () => {
    const at = new Date("2026-01-01")
    const provider = { resolve: vi.fn(async () => [
      policy("missing-role", "role", 1),
      { ...policy("platform-default", "platform_default", 1), source: { policyId: "platform-default", scopeType: "platform_default" as const } },
    ]) }

    const error = await createAbacBundle(input(provider, {
      mode: "platform",
      context: { userId: "user-1" },
      at,
    })).catch((caught: unknown) => caught)

    expect(provider.resolve).toHaveBeenCalledWith(expect.objectContaining({ at }))
    expect(error).toMatchObject({ name: "InvalidPolicyConfigurationError", policyId: "missing-role" })
    expect(error).toHaveProperty("issues", expect.arrayContaining([
      expect.objectContaining({ code: "POLICY_SCOPE_MISMATCH" }),
    ]))
  })
})
