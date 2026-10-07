import { describe, expect, it } from "vitest"
import { ValidationError } from "../../domain/errors"
import { validateQuotaDecision, validateQuotaRequest } from "../quota"

const request = validateQuotaRequest({ quotaKey: "exports", subject: { scope: { kind: "tenant", tenantId: "tenant-a" } }, amount: 3, limit: 10, windowMs: 60_000 })

describe("quota decision consistency (C1)", () => {
  it("accepts allowed decisions whose usage fits within the limit", () => {
    expect(validateQuotaDecision(request, { allowed: true, used: 3, remaining: 7, resetAt: 1 })).toEqual({ allowed: true, used: 3, remaining: 7, resetAt: 1 })
    expect(validateQuotaDecision(request, { allowed: true, used: 10, remaining: 0, resetAt: 1 }).allowed).toBe(true)
  })

  it("accepts a denial at exhaustion", () => {
    expect(validateQuotaDecision(request, { allowed: false, used: 10, remaining: 0, resetAt: 1 })).toEqual({ allowed: false, used: 10, remaining: 0, resetAt: 1 })
    expect(validateQuotaDecision(request, { allowed: false, used: 8, remaining: 2, resetAt: 1 }).allowed).toBe(false)
  })

  it("accepts a denial when usage is already over the limit", () => {
    expect(validateQuotaDecision(request, { allowed: false, used: 12, remaining: 0, resetAt: 1 }).used).toBe(12)
  })

  it("still rejects inconsistent decisions", () => {
    const invalid = [
      { allowed: false, used: 7, remaining: 3, resetAt: 1 },
      { allowed: false, used: 2, remaining: 8, resetAt: 1 },
      { allowed: false, used: 10, remaining: 1, resetAt: 1 },
      { allowed: false, used: 12, remaining: 2, resetAt: 1 },
      { allowed: true, used: 11, remaining: 0, resetAt: 1 },
      { allowed: true, used: 3, remaining: 6, resetAt: 1 },
    ]
    for (const value of invalid) expect(() => validateQuotaDecision(request, value)).toThrow(ValidationError)
  })
})
