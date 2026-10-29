import { describe, expect, it } from "vitest"
import { encodeExecutionScopeId } from "../../domain"
import { ValidationError } from "../../domain/errors"
import { encodeQuotaSubject, validateQuotaDecision, validateQuotaRequest, type QuotaDecision, type QuotaRequest } from "../quota"

const scope = { kind: "tenant", tenantId: "t1" } as const
const scopeId = encodeExecutionScopeId(scope)
const request = (o: Record<string, unknown> = {}): QuotaRequest => ({ quotaKey: "q", subject: { scope }, amount: 1, limit: 10, windowMs: 1000, ...o }) as QuotaRequest
const decision = (o: Record<string, unknown> = {}): QuotaDecision => ({ allowed: true, used: 1, remaining: 9, resetAt: 5, ...o }) as QuotaDecision
const invalid = (fn: () => unknown, message: string) => {
  try { fn() } catch (e) {
    expect(e).toBeInstanceOf(ValidationError)
    expect((e as Error).message).toBe(message)
    return e as ValidationError
  }
  throw new Error(`expected ValidationError: ${message}`)
}

describe("encodeQuotaSubject", () => {
  it("encodes scope, principal and plan exactly", () => {
    expect(encodeQuotaSubject({ scope })).toBe(`${scopeId}:all-principals:all-plans`)
    expect(encodeQuotaSubject({ scope, principal: { id: "u:1/é", kind: "human" }, planKey: "pro plan" })).toBe(`${scopeId}:human:u%3A1%2F%C3%A9:plan:pro%20plan`)
    expect(encodeQuotaSubject({ scope, planKey: "p" })).toBe(`${scopeId}:all-principals:plan:p`)
    expect(encodeQuotaSubject({ scope, principal: { id: "s", kind: "service" } })).toBe(`${scopeId}:service:s:all-plans`)
  })
  it("rejects invalid subjects with specific messages", () => {
    const s = "Quota subject must be valid."
    for (const v of [null, undefined, "x", 5]) invalid(() => encodeQuotaSubject(v as never), s)
    const e = invalid(() => encodeQuotaSubject({ scope: { kind: "tenant" } } as never), "Quota scope must be valid.")
    expect(e.cause).toBeInstanceOf(Error)
    invalid(() => encodeQuotaSubject({} as never), "Quota scope must be valid.")
    const p = "Quota principal must be valid."
    for (const principal of [null, "x", 5, { id: 5, kind: "human" }, { id: "", kind: "human" }, { id: "  ", kind: "human" }, { id: "a\ud800", kind: "human" }, { id: "a", kind: 5 }, { id: "a", kind: "robot" }, { id: "a" }]) {
      invalid(() => encodeQuotaSubject({ scope, principal } as never), p)
    }
    for (const kind of ["human", "service", "system", "anonymous"]) expect(encodeQuotaSubject({ scope, principal: { id: "a", kind } } as never)).toContain(`:${kind}:a:`)
    const plan = "Quota plan key must be non-empty well-formed text."
    for (const planKey of [5, "", "  ", "a\udc00", null]) invalid(() => encodeQuotaSubject({ scope, planKey } as never), plan)
  })
})

describe("validateQuotaRequest", () => {
  it("validates the quota key", () => {
    const m = "Quota key must be non-empty."
    for (const v of [null, undefined, "x"]) invalid(() => validateQuotaRequest(v as never), m)
    for (const quotaKey of ["", "  ", 5, undefined]) invalid(() => validateQuotaRequest(request({ quotaKey })), m)
  })
  it("validates amount, limit and window as positive safe integers", () => {
    for (const [field, message] of [["amount", "Quota amount must be a positive safe integer."], ["limit", "Quota limit must be a positive safe integer."], ["windowMs", "Quota window must be a positive safe integer."]] as const) {
      for (const value of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "1"]) invalid(() => validateQuotaRequest(request({ [field]: value })), message)
      expect(validateQuotaRequest(request({ [field]: 1 }))[field]).toBe(1)
      expect(validateQuotaRequest(request({ [field]: Number.MAX_SAFE_INTEGER }))[field]).toBe(Number.MAX_SAFE_INTEGER)
    }
  })
  it("validates the idempotency key", () => {
    const m = "Quota idempotency key must be non-empty."
    for (const idempotencyKey of ["", "  ", 5, null]) invalid(() => validateQuotaRequest(request({ idempotencyKey })), m)
    expect(validateQuotaRequest(request({ idempotencyKey: "k" })).idempotencyKey).toBe("k")
    expect("idempotencyKey" in validateQuotaRequest(request())).toBe(false)
  })
  it("validates the subject and returns a deep-frozen copy", () => {
    invalid(() => validateQuotaRequest(request({ subject: null })), "Quota subject must be valid.")
    const input = request({ subject: { scope, principal: { id: "a", kind: "human" }, planKey: "p" } })
    const out = validateQuotaRequest(input)
    expect(out).toEqual(input)
    expect(out).not.toBe(input)
    expect(Object.isFrozen(out)).toBe(true)
    expect(Object.isFrozen(out.subject)).toBe(true)
    expect(Object.isFrozen(out.subject.scope)).toBe(true)
    expect(Object.isFrozen(out.subject.principal)).toBe(true)
    expect(out.subject.scope).not.toBe(scope)
    expect("principal" in validateQuotaRequest(request()).subject).toBe(false)
  })
})

describe("validateQuotaDecision", () => {
  const M = "Quota provider returned an invalid decision."
  const C = "Quota provider returned an inconsistent decision."
  it("rejects malformed decisions", () => {
    for (const d of [null, undefined, "x"]) invalid(() => validateQuotaDecision(request(), d as never), M)
    for (const o of [{ allowed: "yes" }, { used: -1 }, { used: 1.5 }, { used: "1" }, { remaining: -1 }, { remaining: 1.5 }, { resetAt: Number.NaN }, { resetAt: Number.POSITIVE_INFINITY }, { resetAt: "5" }]) {
      invalid(() => validateQuotaDecision(request(), decision(o)), M)
    }
  })
  it("checks the allowed arithmetic exactly", () => {
    const r = request({ amount: 2, limit: 10 })
    expect(validateQuotaDecision(r, decision({ used: 2, remaining: 8 })).used).toBe(2)
    expect(validateQuotaDecision(r, decision({ used: 10, remaining: 0 })).remaining).toBe(0)
    invalid(() => validateQuotaDecision(r, decision({ used: 1, remaining: 9 })), C)
    invalid(() => validateQuotaDecision(r, decision({ used: 11, remaining: 0 })), C)
    invalid(() => validateQuotaDecision(r, decision({ used: 5, remaining: 4 })), C)
    invalid(() => validateQuotaDecision(r, decision({ used: 5, remaining: 6 })), C)
  })
  it("checks the denied arithmetic exactly", () => {
    const r = request({ amount: 3, limit: 10 })
    expect(validateQuotaDecision(r, decision({ allowed: false, used: 8, remaining: 2 })).allowed).toBe(false)
    expect(validateQuotaDecision(r, decision({ allowed: false, used: 12, remaining: 0 })).remaining).toBe(0)
    expect(validateQuotaDecision(r, decision({ allowed: false, used: 10, remaining: 0 })).used).toBe(10)
    invalid(() => validateQuotaDecision(r, decision({ allowed: false, used: 7, remaining: 3 })), C)
    invalid(() => validateQuotaDecision(r, decision({ allowed: false, used: 8, remaining: 1 })), C)
    invalid(() => validateQuotaDecision(r, decision({ allowed: false, used: 12, remaining: 2 })), C)
  })
  it("returns a frozen copy", () => {
    const d = decision()
    const out = validateQuotaDecision(request(), d)
    expect(out).toEqual(d)
    expect(out).not.toBe(d)
    expect(Object.isFrozen(out)).toBe(true)
  })
})
