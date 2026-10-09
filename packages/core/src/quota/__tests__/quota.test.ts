import { describe, expect, it } from "vitest"
import { ValidationError } from "../../domain/errors"
import { encodeQuotaSubject, validateQuotaDecision, validateQuotaRequest } from "../quota"

const subject = { scope: { kind: "tenant", tenantId: "tenant-a" } as const, principal: { id: "user:a", kind: "human" as const }, planKey: "pro plan" }
const request = { quotaKey: "exports", subject, amount: 2, limit: 10, windowMs: 60_000, idempotencyKey: "request-1" }

describe("quota validation", () => {
  it("encodes scoped subjects with and without optional dimensions", () => {
    expect(encodeQuotaSubject(subject)).toContain("human:user%3Aa:plan:pro%20plan")
    expect(encodeQuotaSubject({ scope: subject.scope })).toContain("all-principals:all-plans")
  })

  it("rejects malformed subjects, principals, and plan keys", () => {
    const invalid: unknown[] = [null, { scope: null }, { scope: { kind: "tenant", tenantId: "" } }, { scope: subject.scope, principal: null }, { scope: subject.scope, principal: { id: "", kind: "human" } }, { scope: subject.scope, principal: { id: "user", kind: "" } }, { scope: subject.scope, planKey: "" }]
    for (const value of invalid) expect(() => encodeQuotaSubject(value as never)).toThrow()
  })

  it("rejects every malformed request field and freezes a defensive snapshot", () => {
    const invalid: unknown[] = [
      null, { ...request, quotaKey: "" }, { ...request, amount: 0 }, { ...request, amount: 1.5 },
      { ...request, limit: 0 }, { ...request, limit: Number.MAX_SAFE_INTEGER + 1 },
      { ...request, windowMs: 0 }, { ...request, windowMs: Number.NaN }, { ...request, idempotencyKey: "" },
    ]
    for (const value of invalid) expect(() => validateQuotaRequest(value as never)).toThrow(ValidationError)
    const validated = validateQuotaRequest(request)
    expect(Object.isFrozen(validated)).toBe(true)
    expect(Object.isFrozen(validated.subject)).toBe(true)
    expect(Object.isFrozen(validated.subject.scope)).toBe(true)
    expect(Object.isFrozen(validated.subject.principal)).toBe(true)
  })

  it("rejects malformed and arithmetically inconsistent provider decisions", () => {
    const validated = validateQuotaRequest(request)
    const invalid: unknown[] = [
      null, { allowed: 1, used: 2, remaining: 8, resetAt: 1 }, { allowed: true, used: -1, remaining: 11, resetAt: 1 },
      { allowed: true, used: 1.5, remaining: 8.5, resetAt: 1 }, { allowed: true, used: 2, remaining: -1, resetAt: 1 },
      { allowed: true, used: 2, remaining: 8, resetAt: Number.NaN }, { allowed: true, used: 2, remaining: 7, resetAt: 1 },
      { allowed: false, used: 2, remaining: 8, resetAt: 1 },
    ]
    for (const value of invalid) expect(() => validateQuotaDecision(validated, value as never)).toThrow(ValidationError)
    const decision = validateQuotaDecision(validated, { allowed: true, used: 2, remaining: 8, resetAt: 100 })
    expect(decision).toEqual({ allowed: true, used: 2, remaining: 8, resetAt: 100 })
    expect(Object.isFrozen(decision)).toBe(true)
  })
})

describe("quota subject principal kinds", () => {
  it("rejects principal kinds outside the declared principal kinds so keys cannot collide", () => {
    const forged = { scope: subject.scope, principal: { id: "b", kind: "human:a" } }
    const genuine = { scope: subject.scope, principal: { id: "a:b", kind: "human" as const } }
    expect(() => encodeQuotaSubject(forged as never)).toThrow(ValidationError)
    expect(encodeQuotaSubject(genuine)).toContain("human:a%3Ab")
    for (const kind of ["human", "service", "system", "anonymous"] as const) {
      expect(encodeQuotaSubject({ scope: subject.scope, principal: { id: "p", kind } })).toContain(`${kind}:p:`)
    }
  })
})
