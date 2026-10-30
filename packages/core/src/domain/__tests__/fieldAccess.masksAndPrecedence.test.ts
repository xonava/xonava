import { describe, expect, it } from "vitest"
import { assertPolicyWritableFields, projectResponseRecord, resolveFieldReadOverrides } from "../fieldAccess"
import { Predicate } from "../predicate"
import type { NormalizedAbacPolicy } from "../abacTypes"

function policy(overrides: Partial<NormalizedAbacPolicy> = {}): NormalizedAbacPolicy {
  return { source: { policyId: "p", scopeType: "tenant_default" }, moduleKey: "m", effect: "allow", priority: 1, payload: { actions: ["read", "update"], capabilities: [], conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } } }, compiledConditions: Predicate.alwaysTrue(), ...overrides }
}

describe("field access masks and precedence", () => {
  it("redacts every supported format and preserves nullish values", () => {
    const record = { email: "a.person@example.com", phone: "123456789", identifier: "ABC12345", date: "2026-03-04", text: "secret", empty: null }
    const result = projectResponseRecord({ entity: { fields: { email: { type: "string", format: "email" }, phone: { type: "string", format: "phone" }, identifier: { type: "string", format: "identifier" }, date: { type: "string", format: "date" }, text: { type: "string", format: "text" }, empty: { type: "string", nullable: true } } }, record, overrides: { email: "mask", phone: "mask", identifier: "mask", date: "mask", text: "mask", empty: "mask" } })
    expect(result).toMatchObject({ email: "a***@example.com", phone: "***6789", identifier: "***2345", date: "2026", text: "[REDACTED]", empty: null })
    expect(projectResponseRecord({ entity: { fields: { email: { type: "string", format: "email" } } }, record: { email: "a@x" }, overrides: { email: "omit" } })).toEqual({})
    expect(projectResponseRecord({ entity: { fields: { email: { type: "string" } } }, record: { email: "a@x", hookAdded: "must-not-leak" } })).toEqual({ email: "a@x" })
  })

  it("masks from the original value while projecting declared fields", () => {
    expect(projectResponseRecord({
      entity: { fields: { email: { type: "string", format: "email" } } },
      record: { email: "person@example.com", extra: "must-not-leak" },
      overrides: { email: "mask" },
    })).toEqual({ email: "p***@example.com" })
  })

  it("lets highest priority win and deny win ties", () => {
    const allow = policy({ payload: { ...policy().payload, fieldAccess: { read: { email: "mask" } } }, priority: 10 })
    const tieDeny = policy({ effect: "deny", payload: { ...policy().payload, fieldAccess: { read: { email: "allow" } } }, priority: 10 })
    expect(resolveFieldReadOverrides({ policies: [allow, tieDeny], moduleKey: "m", record: {} })).toEqual({ "*": "omit", email: "omit" })
    expect(resolveFieldReadOverrides({ policies: [policy({ moduleKey: "other" })], moduleKey: "m", record: {} })).toEqual({})
  })

  it("resolves equal-priority allow conflicts to the more restrictive mode independent of order", () => {
    const mask = policy({ payload: { ...policy().payload, fieldAccess: { read: { email: "mask" } } }, priority: 5 })
    const bareAllow = policy({ payload: { ...policy().payload, fieldAccess: { read: { email: "allow" } } }, priority: 5 })
    expect(resolveFieldReadOverrides({ policies: [mask, bareAllow], moduleKey: "m", record: {} })).toEqual({ "*": "omit", email: "mask" })
    expect(resolveFieldReadOverrides({ policies: [bareAllow, mask], moduleKey: "m", record: {} })).toEqual({ "*": "omit", email: "mask" })
  })

  it("allows an explicit changed-field list and denies implicit fields", () => {
    const allow = policy({ payload: { ...policy().payload, fieldAccess: { write: ["name"] } } })
    expect(() => assertPolicyWritableFields({ policies: [allow], moduleKey: "m", action: "update", record: { name: "x", email: "y" }, changedFields: ["name"] })).not.toThrow()
    expect(() => assertPolicyWritableFields({ policies: [allow], moduleKey: "m", action: "update", record: { name: "x", email: "y" } })).toThrow()
    expect(() => assertPolicyWritableFields({ policies: [policy({ moduleKey: "other" })], moduleKey: "m", action: "update", record: {} })).not.toThrow()
  })
})
