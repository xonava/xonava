import { describe, expect, it } from "vitest"
import { ConfigurationError } from "@xonava/core/domain"
import { assertFrameworkAdapterDeps } from "../frameworkAdapterDeps"

const fn = () => undefined
const valid = () => ({ assertValidCsrf: fn, resolveAbacBundle: fn }) as Record<string, unknown>

function message(value: unknown): string {
  try {
    assertFrameworkAdapterDeps(value)
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError)
    return (error as Error).message
  }
  return "NO_THROW"
}

describe("assertFrameworkAdapterDeps", () => {
  it("rejects null and non-object values with the exact message", () => {
    const expected = "Framework adapter dependencies must be an object"
    expect(message(null)).toBe(expected)
    expect(message("deps")).toBe(expected)
    expect(message(42)).toBe(expected)
    expect(message(undefined)).toBe(expected)
  })

  it("accepts a minimal valid object and every optional member as a function or undefined", () => {
    expect(message(valid())).toBe("NO_THROW")
    expect(message({ ...valid(), getRateLimitStore: fn, resolveClientIp: fn, resolveHttpMetadata: fn, resolveModuleAuthorizationFacts: fn, createIdempotencyPort: fn })).toBe("NO_THROW")
    expect(message({ ...valid(), getRateLimitStore: undefined, createIdempotencyPort: undefined })).toBe("NO_THROW")
  })

  it("lists every obsolete decision key in declaration order", () => {
    const keys = ["isOwnerBypass", "ownerBypass", "ownerAuthority", "impersonated", "resolveSession", "hasCapability", "assertModuleEnabled", "assertModuleActionEnabled", "assertModuleCapabilityEnabled"]
    for (const key of keys) {
      expect(message({ ...valid(), [key]: fn })).toBe(`Framework adapter dependencies contain obsolete authorization decision key(s): ${key}. Provide entitlements only; authorization decisions remain in packages/core.`)
    }
    const all = Object.fromEntries(keys.map((key) => [key, true]))
    expect(message({ ...valid(), ...all })).toBe(`Framework adapter dependencies contain obsolete authorization decision key(s): ${keys.join(", ")}. Provide entitlements only; authorization decisions remain in packages/core.`)
    expect(message({ ...valid(), ownerBypass: undefined })).toContain("ownerBypass")
  })

  it("lists invalid required members with the exact message", () => {
    const prefix = "Framework adapter dependencies contain invalid required member(s): "
    const suffix = ". Each member must be a function."
    expect(message({})).toBe(`${prefix}assertValidCsrf, resolveAbacBundle${suffix}`)
    expect(message({ assertValidCsrf: fn })).toBe(`${prefix}resolveAbacBundle${suffix}`)
    expect(message({ resolveAbacBundle: fn })).toBe(`${prefix}assertValidCsrf${suffix}`)
    expect(message({ assertValidCsrf: "yes", resolveAbacBundle: fn })).toBe(`${prefix}assertValidCsrf${suffix}`)
  })

  it("lists invalid optional members only when present, defined and not functions", () => {
    const prefix = "Framework adapter dependencies contain invalid optional member(s): "
    const suffix = ". Each present member must be a function."
    expect(message({ ...valid(), getRateLimitStore: "x" })).toBe(`${prefix}getRateLimitStore${suffix}`)
    expect(message({ ...valid(), getRateLimitStore: null, resolveClientIp: 1, resolveHttpMetadata: {}, resolveModuleAuthorizationFacts: true, createIdempotencyPort: "no" }))
      .toBe(`${prefix}getRateLimitStore, resolveClientIp, resolveHttpMetadata, resolveModuleAuthorizationFacts, createIdempotencyPort${suffix}`)
  })

  it("reports obsolete keys before required and required before optional", () => {
    expect(message({ ownerBypass: true, getRateLimitStore: "x" })).toContain("obsolete")
    expect(message({ getRateLimitStore: "x" })).toContain("required")
  })
})
