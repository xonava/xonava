import { describe, expect, it, vi } from "vitest"
import { createRng, forAllAsync, type Rng } from "./harness"
import { ABAC_PROPERTY_TIMEOUT_MS, ABAC_ACTIONS, ABAC_CAPABILITIES, FIELD_KEYS, READ_MODES, bindPolicies, describePolicyCase, generatePolicies, shrinkPolicies } from "./abacArbitraries"
import { assertAbacSecurityDigest, deriveAbacSecurityDigest } from "../../domain/abacBundleIntegrity"
import { canonicalJsonString } from "../../serialization/canonicalJson"
import { Predicate } from "../../domain/predicate"
import type { AbacPolicyBundle, NormalizedAbacPolicy } from "../../domain/abacTypes"

/**
 * Bundle integrity: binding is deterministic and key-order independent, the
 * bound bundle is deeply immutable, and any change to a security-relevant
 * field changes the digest and is rejected.
 */

vi.setConfig({ testTimeout: ABAC_PROPERTY_TIMEOUT_MS })

type Mutable = Omit<AbacPolicyBundle, "securityDigest"> & { securityDigest?: string }
type Mutation = { name: string; apply(bundle: Mutable, rng: Rng): boolean }

function policyMutation(name: string, mutate: (policy: NormalizedAbacPolicy, rng: Rng) => boolean): Mutation {
  return {
    name,
    apply: (bundle, rng) => bundle.policies.length > 0 && mutate(rng.pick(bundle.policies), rng),
  }
}

function toggle<T>(list: T[], value: T): void {
  const index = list.indexOf(value)
  if (index >= 0) list.splice(index, 1)
  else list.push(value)
}

const MUTATIONS: Mutation[] = [
  policyMutation("effect", (policy) => { policy.effect = policy.effect === "allow" ? "deny" : "allow"; return true }),
  policyMutation("priority", (policy, rng) => { policy.priority += rng.bool() ? 1 : -1; return true }),
  policyMutation("policy moduleKey", (policy) => { policy.moduleKey = `${policy.moduleKey}.x`; return true }),
  policyMutation("policyId", (policy) => { policy.source.policyId = `${policy.source.policyId}x`; return true }),
  policyMutation("scopeType", (policy) => { policy.source.scopeType = policy.source.scopeType === "user" ? "role" : "user"; return true }),
  policyMutation("scopeRefId", (policy) => { policy.source.scopeRefId = `${policy.source.scopeRefId ?? ""}x`; return true }),
  policyMutation("actions", (policy, rng) => { toggle(policy.payload.actions, rng.pick(ABAC_ACTIONS)); return true }),
  policyMutation("capabilities", (policy, rng) => { toggle(policy.payload.capabilities, rng.pick(ABAC_CAPABILITIES)); return true }),
  policyMutation("condition negated", (policy) => { policy.compiledConditions = Predicate.not(policy.compiledConditions); return true }),
  policyMutation("condition replaced", (policy) => { policy.compiledConditions = Predicate.and(policy.compiledConditions, Predicate.eq("ownerId", "u9")); return true }),
  policyMutation("read mode", (policy, rng) => {
    const read = policy.payload.fieldAccess?.read
    if (!read || Object.keys(read).length === 0) return false
    const field = rng.pick(Object.keys(read))
    read[field] = READ_MODES[(READ_MODES.indexOf(read[field]!) + 1) % READ_MODES.length]!
    return true
  }),
  policyMutation("read entry", (policy, rng) => {
    const fieldAccess = (policy.payload.fieldAccess ??= {})
    const read = (fieldAccess.read ??= {})
    const field = rng.pick(FIELD_KEYS)
    if (Object.hasOwn(read, field)) delete read[field]
    else read[field] = rng.pick(READ_MODES)
    return true
  }),
  policyMutation("write list", (policy, rng) => {
    const fieldAccess = (policy.payload.fieldAccess ??= {})
    toggle((fieldAccess.write ??= []), rng.pick(FIELD_KEYS))
    return true
  }),
  policyMutation("query grant", (policy, rng) => {
    const fieldAccess = (policy.payload.fieldAccess ??= {})
    const query = (fieldAccess.query ??= {})
    toggle((query[rng.pick(["filter", "search", "sort"] as const)] ??= []), rng.pick(FIELD_KEYS))
    return true
  }),
  { name: "policy dropped", apply: (bundle, rng) => bundle.policies.length > 0 && bundle.policies.splice(rng.int(bundle.policies.length), 1).length === 1 },
  { name: "policy duplicated", apply: (bundle, rng) => bundle.policies.length > 0 && bundle.policies.push(structuredClone(rng.pick(bundle.policies))) > 0 },
  { name: "bundle moduleKey", apply: (bundle) => { bundle.moduleKey = `${bundle.moduleKey}.x`; return true } },
  { name: "mode", apply: (bundle) => { bundle.mode = bundle.mode === "tenant" ? "platform" : "tenant"; return true } },
  { name: "context user", apply: (bundle) => { bundle.context.userId = `${bundle.context.userId ?? ""}x`; return true } },
  { name: "context tenant", apply: (bundle) => { bundle.context.tenantId = `${bundle.context.tenantId ?? ""}x`; return true } },
  { name: "context extra attribute", apply: (bundle) => { bundle.context.region = "eu"; return true } },
  // Catalog mutations skip a field an earlier mutation in the same case dropped.
  { name: "catalog type", apply: (bundle, rng) => { const field = bundle.fieldCatalog[rng.pick(FIELD_KEYS)]; if (!field) return false; field.type = field.type === "string" ? "number" : "string"; return true } },
  { name: "catalog field dropped", apply: (bundle, rng) => delete bundle.fieldCatalog[rng.pick(FIELD_KEYS)] },
  { name: "catalog operators", apply: (bundle, rng) => { const field = bundle.fieldCatalog[rng.pick(FIELD_KEYS)]; if (!field) return false; field.operators.push("equals"); return true } },
  { name: "cacheScopeKey", apply: (bundle) => { bundle.cacheScopeKey = `${bundle.cacheScopeKey ?? ""}x`; return true } },
  { name: "inactivePolicyIds", apply: (bundle) => { (bundle.inactivePolicyIds ??= []).push("p-inactive"); return true } },
]

function unfrozenCopy(bundle: AbacPolicyBundle): Mutable {
  return structuredClone({ ...bundle }) as Mutable
}

/** The same data with every object's keys in reverse insertion order. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)]))
  return value
}

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen)
}

interface DigestCase {
  policies: NormalizedAbacPolicy[]
  mutations: number[]
  seed: number
}

describe("ABAC differential: bundle security digest", () => {
  it("is deterministic, key-order independent, and binds a deeply frozen bundle", async () => {
    await forAllAsync("abac digest determinism", (rng) => ({ policies: generatePolicies(rng, { fieldAccessRate: 0.6 }), extra: rng.bool() ? { cacheScopeKey: "tenant:t1" } : {} }), async ({ policies, extra }) => {
      const bundle = await bindPolicies(policies, extra)
      const again = await bindPolicies(structuredClone(policies), structuredClone(extra))
      expect(again.securityDigest).toBe(bundle.securityDigest)
      const reordered = await bindPolicies(reverseKeys(policies) as NormalizedAbacPolicy[], reverseKeys(extra) as Partial<AbacPolicyBundle>)
      expect(reordered.securityDigest).toBe(bundle.securityDigest)
      expect(isDeepFrozen(bundle)).toBe(true)
      await expect(assertAbacSecurityDigest(bundle)).resolves.toBeUndefined()
      const { securityDigest: _digest, ...withoutDigest } = bundle
      expect(await deriveAbacSecurityDigest(withoutDigest)).toBe(bundle.securityDigest)
      // An unbranded copy with a self-consistent digest is still rejected.
      await expect(assertAbacSecurityDigest(unfrozenCopy(bundle) as AbacPolicyBundle)).rejects.toThrow()
    }, { runs: 150, describe: describePolicyCase })
  })

  it("detects any mutation of a security-relevant field", async () => {
    await forAllAsync("abac digest tamper", (rng): DigestCase => ({
      policies: generatePolicies(rng, { min: 1, fieldAccessRate: 0.6 }),
      mutations: Array.from({ length: 1 + rng.int(3) }, () => rng.int(MUTATIONS.length)),
      seed: rng.next(),
    }), async ({ policies, mutations, seed }) => {
      const bundle = await bindPolicies(policies)
      const rng = createRng(seed)
      const tampered = unfrozenCopy(bundle)
      const applied = mutations.map((index) => MUTATIONS[index]!).filter((mutation) => mutation.apply(tampered, rng)).map((mutation) => mutation.name)
      if (applied.length === 0) return
      const { securityDigest: originalDigest, ...rest } = tampered
      const before = canonicalJsonString(Object.fromEntries(Object.entries(bundle).filter(([key]) => key !== "securityDigest")))
      if (canonicalJsonString(rest) === before) return
      expect(await deriveAbacSecurityDigest(rest), `mutation(s) ${applied.join(", ")} kept the digest`).not.toBe(originalDigest)
      await expect(assertAbacSecurityDigest({ ...rest, securityDigest: originalDigest! } as AbacPolicyBundle)).rejects.toThrow()
      // The verified bundle itself cannot be mutated in place.
      expect(() => { (bundle.policies[0] as { priority: number }).priority += 1 }).toThrow(TypeError)
      expect(() => { (bundle as { moduleKey: string }).moduleKey = "x" }).toThrow(TypeError)
      await expect(assertAbacSecurityDigest(bundle)).resolves.toBeUndefined()
    }, {
      runs: 400,
      describe: describePolicyCase,
      shrink: function* (value) {
        for (const policies of shrinkPolicies(value.policies)) if (policies.length > 0) yield { ...value, policies }
        if (value.mutations.length > 1) for (const mutation of value.mutations) yield { ...value, mutations: [mutation] }
      },
    })
  })

  it("covers every mutation kind", () => {
    // Guard against the mutation table silently shrinking.
    expect(new Set(MUTATIONS.map((mutation) => mutation.name)).size).toBe(MUTATIONS.length)
    expect(MUTATIONS.length).toBeGreaterThanOrEqual(25)
  })
})
