import { describe, expect, it } from "vitest"
import { validateFeatureFlagFact } from "../featureFlags"

describe("feature flag timestamp snapshots", () => {
  it("isolates evaluated and expiry timestamps", () => {
    const evaluatedAt = new Date("2026-01-01T00:00:00.000Z")
    const expiresAt = new Date("2026-01-02T00:00:00.000Z")
    const fact = validateFeatureFlagFact({ key: "flag", value: true, reason: "test", evaluatedAt, expiresAt })
    evaluatedAt.setTime(0); expiresAt.setTime(0)
    Date.prototype.setTime.call(fact.evaluatedAt, 1); fact.expiresAt!.setTime(1)
    expect(fact.evaluatedAt.toISOString()).toBe("2026-01-01T00:00:00.000Z")
    expect(fact.expiresAt!.toISOString()).toBe("2026-01-02T00:00:00.000Z")
    expect(JSON.parse(JSON.stringify(fact))).toMatchObject({ evaluatedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z" })
  })

  it("rejects invalid timestamps", () => {
    expect(() => validateFeatureFlagFact({ key: "flag", value: true, reason: "test", evaluatedAt: new Date(NaN) })).toThrow()
  })
})
