import { describe, expect, it } from "vitest"
import { ValidationError } from "../../domain/errors"
import { validateFeatureFlagFact, type FeatureFlagFact } from "../featureFlags"

const M = "Feature flag provider returned an invalid fact."
const fact = (o: Record<string, unknown> = {}): FeatureFlagFact => ({ key: "k", value: true, reason: "because", evaluatedAt: new Date(1000), ...o }) as FeatureFlagFact
const bad = (f: unknown, expectedKey?: string) => {
  try { validateFeatureFlagFact(f as never, expectedKey) } catch (e) {
    expect(e).toBeInstanceOf(ValidationError)
    expect((e as Error).message).toBe(M)
    return
  }
  throw new Error("expected ValidationError")
}

describe("validateFeatureFlagFact", () => {
  it("rejects non-objects", () => {
    bad(null)
    bad(undefined)
    bad("fact")
    bad(5)
  })
  it("accepts boolean, string and finite number values only", () => {
    for (const value of [true, false, "", "x", 0, -1.5, 42]) expect(validateFeatureFlagFact(fact({ value })).value).toBe(value)
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, null, {}, [], 1n]) bad(fact({ value }))
  })
  it("validates key and expected key", () => {
    bad(fact({ key: "" }))
    bad(fact({ key: "  " }))
    bad(fact({ key: 5 }))
    bad(fact({ key: undefined }))
    bad(fact({ key: "a" }), "b")
    expect(validateFeatureFlagFact(fact({ key: "a" }), "a").key).toBe("a")
    expect(validateFeatureFlagFact(fact({ key: "a" })).key).toBe("a")
  })
  it("validates the optional variant", () => {
    bad(fact({ variant: "" }))
    bad(fact({ variant: "  " }))
    bad(fact({ variant: 5 }))
    bad(fact({ variant: null }))
    expect(validateFeatureFlagFact(fact({ variant: "blue" })).variant).toBe("blue")
    expect(validateFeatureFlagFact(fact()).variant).toBeUndefined()
  })
  it("validates the reason and timestamps", () => {
    bad(fact({ reason: "" }))
    bad(fact({ reason: "  " }))
    bad(fact({ reason: 5 }))
    bad(fact({ evaluatedAt: "2026-01-01" }))
    bad(fact({ evaluatedAt: new Date(Number.NaN) }))
    bad(fact({ evaluatedAt: undefined }))
    bad(fact({ expiresAt: "2026-01-01" }))
    bad(fact({ expiresAt: new Date(Number.NaN) }))
    bad(fact({ expiresAt: new Date(1000) }))
    bad(fact({ expiresAt: new Date(999) }))
    expect(validateFeatureFlagFact(fact({ expiresAt: new Date(1001) })).expiresAt?.getTime()).toBe(1001)
  })
  it("returns a frozen snapshot labelled as a feature flag fact", () => {
    const input = fact({ expiresAt: new Date(2000) })
    const out = validateFeatureFlagFact(input)
    expect(out).not.toBe(input)
    expect(Object.isFrozen(out)).toBe(true)
    expect(out.evaluatedAt.getTime()).toBe(1000)
    expect(out.evaluatedAt).not.toBe(input.evaluatedAt)
    expect(() => validateFeatureFlagFact(fact({ extra: () => 1 }))).toThrow("Feature flag fact must contain data only")
  })
})
