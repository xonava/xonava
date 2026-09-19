import { describe, expect, it } from "vitest"
import {
  assertAbacSecurityDigest,
  assertVerifiedAbacBundle,
  bindAbacSecurityDigest,
  deriveAbacSecurityDigest,
} from "../abacBundleIntegrity"
import type { AbacPolicyBundle } from "../abacTypes"

function rawBundle(overrides: Partial<AbacPolicyBundle> = {}): Omit<AbacPolicyBundle, "securityDigest"> {
  return {
    mode: "tenant",
    moduleKey: "test.bundle",
    policies: [],
    context: {},
    defaultEffect: "deny",
    fieldCatalog: {},
    ...overrides,
  }
}

async function selfDigest(bundle: AbacPolicyBundle): Promise<AbacPolicyBundle> {
  const { securityDigest: _ignored, ...withoutDigest } = bundle
  return { ...withoutDigest, securityDigest: await deriveAbacSecurityDigest(withoutDigest) }
}

describe("assertVerifiedAbacBundle", () => {
  it("rejects a raw bundle that never passed the production factory", async () => {
    const forged = await selfDigest({ ...rawBundle(), securityDigest: "" })
    expect(() => assertVerifiedAbacBundle(forged)).toThrow("not a verified production bundle")
  })

  it("rejects the exact forgery vector: a self-consistent digest with the brand stripped", async () => {
    const verified = await bindAbacSecurityDigest(rawBundle())
    expect(Object.isFrozen(verified)).toBe(true)

    // Attacker strips the un-forgeable symbol brand by cloning through JSON,
    // then recomputes a digest that is self-consistent with the cloned content.
    const stripped = JSON.parse(JSON.stringify(verified)) as AbacPolicyBundle
    const forged = await selfDigest(stripped)
    expect(forged.securityDigest).toBeTypeOf("string")
    expect(forged.securityDigest).toMatch(/^[a-f0-9]{64}$/)

    expect(() => assertVerifiedAbacBundle(forged)).toThrow("not a verified production bundle")
  })

  it("accepts only the factory-produced frozen brand", async () => {
    const verified = await bindAbacSecurityDigest(rawBundle())
    expect(() => assertVerifiedAbacBundle(verified)).not.toThrow()
    expect(Object.isFrozen(verified)).toBe(true)
    expect(Object.isFrozen(verified.context)).toBe(true)

    await expect(assertAbacSecurityDigest(verified)).resolves.toBeUndefined()
  })

  it("assertAbacSecurityDigest agrees with the brand check on forged bundles", async () => {
    const verified = await bindAbacSecurityDigest(rawBundle())
    const stripped = JSON.parse(JSON.stringify(verified)) as AbacPolicyBundle
    const forged = await selfDigest(stripped)

    await expect(assertAbacSecurityDigest(forged)).rejects.toThrow("not a verified production bundle")
  })

  it("assertAbacSecurityDigest rejects a copied bundle before trusting its digest", async () => {
    const verified = await bindAbacSecurityDigest(rawBundle())
    const tampered = { ...verified, context: { ...verified.context, userId: "other-user" } } as AbacPolicyBundle

    await expect(assertAbacSecurityDigest(tampered)).rejects.toThrow("not a verified production bundle")
  })
})

it("rejects descriptor-preserving copies of a verified bundle", async () => {
  const verified = await bindAbacSecurityDigest(rawBundle())
  const copy = Object.freeze(Object.defineProperties({}, Object.getOwnPropertyDescriptors(verified))) as AbacPolicyBundle
  expect(() => assertVerifiedAbacBundle(copy)).toThrow("not a verified")
})
it("snapshots digest material before asynchronous hashing", async () => {
  const input = rawBundle({ context: { value: "before" } })
  const pending = bindAbacSecurityDigest(input)
  ;(input.context as Record<string, unknown>).value = "after"
  const verified = await pending
  expect(verified.context.value).toBe("before")
  await expect(assertAbacSecurityDigest(verified)).resolves.toBeUndefined()
})
