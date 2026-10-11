import { describe, expect, it } from "vitest"
import { forAll, type Rng } from "./harness"
import { ValidationError } from "../../domain/errors"
import { encodeQuotaSubject, validateQuotaDecision, validateQuotaRequest, type QuotaRequest } from "../../quota/quota"

/**
 * Quota arithmetic is checked against a reference in-memory quota (the
 * documented semantics: consumption at exactly the allowance is allowed,
 * beyond it is denied and changes nothing), and the request / subject
 * validators against hand-written validity rules.
 */

const SCOPE_KINDS = [["application", "applicationKey"], ["tenant", "tenantId"], ["platform", "platformKey"], ["system", "systemKey"]] as const
const PRINCIPAL_KINDS = ["human", "service", "system", "anonymous"]

// ------------------------------------------------------------ decisions

interface DecisionCase { limit: number; amount: number; history: number[]; mutate: "none" | "used+" | "used-" | "remaining+" | "remaining-" | "flip" | "nan-reset" | "fraction" | "used-zero" | "remaining-limit" }

function generateDecisionCase(rng: Rng): DecisionCase {
  return {
    limit: rng.pick([1, 2, 3, 10, 100, Number.MAX_SAFE_INTEGER]),
    amount: rng.pick([1, 1, 2, 3, 5, 10, 100]),
    history: Array.from({ length: rng.int(8) }, () => rng.pick([1, 1, 2, 3, 5, 10])),
    mutate: rng.pick(["none", "none", "none", "used+", "used-", "remaining+", "remaining-", "flip", "nan-reset", "fraction", "used-zero", "remaining-limit"] as const),
  }
}

describe("quota decisions", () => {
  it("validateQuotaDecision accepts exactly the decisions some reference-quota history can produce", () => {
    forAll("quota decision consistency", generateDecisionCase, (c) => {
      // Reference quota: replay the history, then take the decision for the final request.
      let used = 0
      for (const amount of c.history) if (used + amount <= c.limit) used += amount
      const allowed = used + c.amount <= c.limit
      const produced = allowed ? { allowed, used: used + c.amount, remaining: c.limit - used - c.amount, resetAt: 1_000 } : { allowed, used, remaining: Math.max(c.limit - used, 0), resetAt: 1_000 }
      let decision: Record<string, unknown> = { ...produced }
      switch (c.mutate) {
        case "used+": decision.used = produced.used + 1; break
        case "used-": decision.used = produced.used - 1; break
        case "remaining+": decision.remaining = produced.remaining + 1; break
        case "remaining-": decision.remaining = produced.remaining - 1; break
        case "flip": decision.allowed = !produced.allowed; break
        case "nan-reset": decision.resetAt = NaN; break
        case "fraction": decision = { ...decision, used: produced.used + 0.5, remaining: produced.remaining - 0.5 }; break
        // An allowed consumption of `amount` cannot report less usage than `amount` (usage includes it).
        case "used-zero": decision = { ...decision, used: 0, remaining: c.limit }; break
        case "remaining-limit": decision = { ...decision, used: 0, remaining: c.limit, allowed: true }; break
        case "none": break
      }
      // Oracle by existence: is there a reference history (prior usage p >= 0) producing this very decision?
      const d = decision as { allowed: boolean; used: number; remaining: number; resetAt: number }
      const wellFormed = typeof d.allowed === "boolean" && Number.isSafeInteger(d.used) && d.used >= 0 && Number.isSafeInteger(d.remaining) && d.remaining >= 0 && Number.isFinite(d.resetAt)
      let reachable = false
      if (wellFormed) {
        if (d.allowed) {
          const prior = d.used - c.amount // usage before this consumption
          reachable = prior >= 0 && prior + c.amount <= c.limit && d.remaining === c.limit - d.used
        } else {
          // Denied: usage is the unchanged prior usage p; p + amount must exceed the limit; remaining is what is left (never negative).
          reachable = d.used + c.amount > c.limit && d.remaining === Math.max(c.limit - d.used, 0)
        }
      }
      const request = validateQuotaRequest({ quotaKey: "k", subject: { scope: { kind: "tenant", tenantId: "t" } }, amount: c.amount, limit: c.limit, windowMs: 1000 })
      if (reachable) expect(validateQuotaDecision(request, d)).toEqual(d)
      else expect(() => validateQuotaDecision(request, d), "an unreachable decision was accepted").toThrow(ValidationError)
      if (c.mutate === "none") expect(reachable, "the reference decision itself must be reachable").toBe(true)
    }, { runs: 500, describe: (c) => JSON.stringify(c) })
  })
})

// ------------------------------------------------------------ requests

function generateSubject(rng: Rng, hostile: boolean): unknown {
  const [kind, key] = rng.pick(SCOPE_KINDS)
  const keyValue = rng.pick(hostile ? ["t", "t", "a:b", "", "  ", 5, null, "é", "😀"] : ["t", "a:b", "é", "😀", "x y"]) as unknown
  const scope: Record<string, unknown> = hostile && rng.bool(0.1) ? rng.pick([{ kind: "tenant" }, { kind: "galaxy", x: "y" }, { kind, [key]: "t", extra: 1 }, null, "tenant", []]) as Record<string, unknown> : { kind, [key]: keyValue }
  const subject: Record<string, unknown> = { scope }
  if (rng.bool(0.5)) subject.principal = hostile && rng.bool(0.3)
    ? rng.pick([null, {}, { id: "", kind: "human" }, { id: " ", kind: "human" }, { id: "u", kind: "robot" }, { id: "u", kind: "human:a" }, { id: 5, kind: "human" }, { id: "\ud800", kind: "human" }, { id: "u" }])
    : { id: rng.pick(["u", "a:b", "a%3Ab", "%", "é", "x y", ":"]), kind: rng.pick(PRINCIPAL_KINDS) }
  if (rng.bool(0.5)) subject.planKey = hostile && rng.bool(0.3) ? rng.pick(["", "  ", 5, null, "\udc00x"]) : rng.pick(["pro", "plan:x", "a b", "%", "é"])
  return subject
}

function oracleSubjectValid(subject: unknown): boolean | undefined {
  if (!subject || typeof subject !== "object") return false
  const s = subject as { scope?: unknown; principal?: unknown; planKey?: unknown }
  const scope = s.scope as Record<string, unknown> | null
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return false
  const entry = SCOPE_KINDS.find(([kind]) => kind === scope.kind)
  if (!entry) return false
  const value = scope[entry[1]]
  if (typeof value !== "string" || value.trim().length === 0) return false
  if (Object.keys(scope).length !== 2) return false
  if (s.principal !== undefined) {
    const p = s.principal as { id?: unknown; kind?: unknown } | null
    if (p === null || typeof p !== "object") return false
    if (typeof p.id !== "string" || p.id.trim().length === 0 || /\p{Cs}/u.test(p.id)) return false
    if (typeof p.kind !== "string" || !PRINCIPAL_KINDS.includes(p.kind)) return false
  }
  if (s.planKey !== undefined && (typeof s.planKey !== "string" || s.planKey.trim().length === 0 || /\p{Cs}/u.test(s.planKey))) return false
  return true
}

describe("quota requests", () => {
  it("validateQuotaRequest rejects every invalid request with a ValidationError and freezes a snapshot of valid ones", () => {
    forAll("quota request validity", (rng) => {
      const hostile = rng.bool(0.6)
      const num = (): unknown => rng.pick(hostile ? [1, 2, 60_000, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, "3", null] : [1, 2, 60_000, Number.MAX_SAFE_INTEGER])
      const request: Record<string, unknown> = {
        quotaKey: hostile && rng.bool(0.3) ? rng.pick(["", "   ", 5, null, undefined]) : rng.pick(["exports", "a:b", " lead"]),
        subject: generateSubject(rng, hostile),
        amount: num(), limit: num(), windowMs: num(),
      }
      if (rng.bool(0.4)) request.idempotencyKey = hostile && rng.bool(0.4) ? rng.pick(["", "  ", 5, null]) : "idem-1"
      return request
    }, (request) => {
      const posInt = (v: unknown): boolean => typeof v === "number" && Number.isSafeInteger(v) && v > 0
      const subjectVerdict = oracleSubjectValid(request.subject)
      const valid = typeof request.quotaKey === "string" && request.quotaKey.trim().length > 0 && posInt(request.amount) && posInt(request.limit) && posInt(request.windowMs)
        && (request.idempotencyKey === undefined || (typeof request.idempotencyKey === "string" && request.idempotencyKey.trim().length > 0)) && subjectVerdict === true
      let thrown: unknown
      let result: QuotaRequest | undefined
      try { result = validateQuotaRequest(request as unknown as QuotaRequest) } catch (error) { thrown = error }
      if (valid) {
        expect(thrown, "valid request rejected").toBeUndefined()
        expect(Object.isFrozen(result)).toBe(true)
        expect(Object.isFrozen(result!.subject.scope)).toBe(true)
        expect(result).toEqual(request)
      } else expect(thrown, "invalid request must fail as a ValidationError (spec: invalid scope/unit/amount/period is validation failure)").toBeInstanceOf(ValidationError)
    }, { runs: 700, describe: (r) => JSON.stringify(r, (_k, v: unknown) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v === undefined ? "<undefined>" : v)) })
  })

  it("encodeQuotaSubject is injective over normalised subjects and independent of key order", () => {
    const seen = new Map<string, string>()
    forAll("quota subject encoding injective", (rng) => {
      const subject = generateSubject(rng, false) as { scope: Record<string, string>; principal?: { id: string; kind: string }; planKey?: string }
      return subject
    }, (subject) => {
      const canonical = JSON.stringify([subject.scope.kind, Object.values(subject.scope).filter((_, i) => i > 0), subject.principal ? [subject.principal.kind, subject.principal.id] : null, subject.planKey ?? null])
      const encoded = encodeQuotaSubject(subject as never)
      const prior = seen.get(encoded)
      if (prior !== undefined) expect(prior, `two different subjects encode to ${encoded}`).toBe(canonical)
      seen.set(encoded, canonical)
      // Reordering the keys of every object must not change the encoding.
      const reordered = {
        ...(subject.planKey !== undefined ? { planKey: subject.planKey } : {}),
        ...(subject.principal ? { principal: { kind: subject.principal.kind, id: subject.principal.id } } : {}),
        scope: Object.fromEntries(Object.entries(subject.scope).reverse()),
      }
      expect(encodeQuotaSubject(reordered as never)).toBe(encoded)
    }, { runs: 600, describe: (s) => JSON.stringify(s) })
  })
})
