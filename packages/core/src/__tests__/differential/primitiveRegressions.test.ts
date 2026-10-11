import { describe, expect, it } from "vitest"
import { ConfigurationError, ValidationError } from "../../domain/errors"
import { encodeExecutionScopeId } from "../../domain"
import { validateSequenceDefinition } from "../../sequence/sequence"
import { validateTemporalRevision } from "../../temporal/temporal"
import { encodeQuotaSubject, validateQuotaDecision, validateQuotaRequest } from "../../quota/quota"

/**
 * Minimal counterexamples found by the resilience / primitives differentials,
 * kept as named examples so the fixes cannot silently regress.
 */
describe("regressions found by the primitives differentials", () => {
  it("a sequence definition name or prefix must be a string (RegExp#test coerced arrays, numbers and null)", () => {
    // Found by "sequence definition validity": {name: "inv", prefix: ["a"]} was accepted and kept the array as the prefix.
    expect(() => validateSequenceDefinition({ name: "inv", prefix: ["a"] } as never)).toThrow(ConfigurationError)
    expect(() => validateSequenceDefinition({ name: "inv", prefix: 5 } as never)).toThrow(ConfigurationError)
    expect(() => validateSequenceDefinition({ name: "inv", prefix: null } as never)).toThrow(ConfigurationError)
    expect(() => validateSequenceDefinition({ name: undefined } as never)).toThrow(ConfigurationError)
    expect(() => validateSequenceDefinition({ name: null } as never)).toThrow(ConfigurationError)
    expect(() => validateSequenceDefinition({ name: ["inv"] } as never)).toThrow(ConfigurationError)
    expect(() => validateSequenceDefinition({ name: 5 } as never)).toThrow(ConfigurationError)
    expect(validateSequenceDefinition({ name: "inv", prefix: "INV-" }).prefix).toBe("INV-")
  })

  it("a temporal revision's entity type, entity id, event id and audit id must be strings", () => {
    // Found by "temporal revision validity": {entityId: 5} and {entityId: ["p1"]} matched the key pattern after coercion.
    const scopeId = encodeExecutionScopeId({ kind: "system", systemKey: "test" })
    const base = { scopeId, entityType: "person", entityId: "p1", revision: 1, occurredAt: new Date(0), kind: "created" as const, state: { n: 1 } }
    expect(validateTemporalRevision(base).entityId).toBe("p1")
    for (const patch of [{ entityId: 5 }, { entityId: ["p1"] }, { entityType: ["person"] }, { entityType: 5 }, { eventId: ["evt"] }, { auditId: 7 }]) {
      expect(() => validateTemporalRevision({ ...base, ...patch } as never), JSON.stringify(patch)).toThrow(ConfigurationError)
    }
  })

  it("an invalid quota scope is a ValidationError, not a raw CanonicalJsonError", () => {
    // Found by "quota request validity": spec says an invalid scope is a validation failure.
    const bad = { scope: { kind: "tenant", tenantId: "" } }
    expect(() => encodeQuotaSubject(bad as never)).toThrow(ValidationError)
    expect(() => validateQuotaRequest({ quotaKey: "k", subject: { scope: { kind: "tenant", tenantId: null } }, amount: 1, limit: 1, windowMs: 1 } as never)).toThrow(ValidationError)
    expect(() => encodeQuotaSubject({ scope: { kind: "galaxy" } } as never)).toThrow(ValidationError)
    expect(() => encodeQuotaSubject({ scope: { kind: "tenant", tenantId: "t", extra: 1 } } as never)).toThrow(ValidationError)
  })

  it("an allowed quota decision cannot report less usage than the amount it just consumed", () => {
    // Found by "quota decision consistency": amount 2 of limit 2 "allowed" with used 0 / remaining 2 was accepted.
    const request = validateQuotaRequest({ quotaKey: "k", subject: { scope: { kind: "tenant", tenantId: "t" } }, amount: 2, limit: 2, windowMs: 1000 })
    expect(() => validateQuotaDecision(request, { allowed: true, used: 0, remaining: 2, resetAt: 1 })).toThrow(ValidationError)
    expect(() => validateQuotaDecision(request, { allowed: true, used: 1, remaining: 1, resetAt: 1 })).toThrow(ValidationError)
    expect(validateQuotaDecision(request, { allowed: true, used: 2, remaining: 0, resetAt: 1 }).used).toBe(2)
  })
})
