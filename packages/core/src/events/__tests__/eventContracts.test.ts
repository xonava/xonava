import { describe, expect, it } from "vitest"
import { defineConsumer, defineEvent, EventRegistry, createEventEnvelope } from ".."
import { encodeExecutionScopeId } from "../../domain/executionScope"

const eventScope = { kind: "tenant", tenantId: "t1" } as const
const eventScopeId = encodeExecutionScopeId(eventScope)
const provenanceRecord = { format: "framework.authority-provenance", formatVersion: 1, actor: { id: "u1", kind: "human", authentication: { kind: "authenticated", method: "test", authenticatedAt: "2026-01-01T00:00:00.000Z" } }, subject: { id: "u1", kind: "human", authentication: { kind: "authenticated", method: "test", authenticatedAt: "2026-01-01T00:00:00.000Z" } }, source: { kind: "route", routeKey: "invoice.create" }, target: { scope: eventScope, scopeId: eventScopeId }, grantId: "g1", purpose: "create", reason: "request", delegationChain: [], policy: { policyKey: "p1", policyVersion: 1, policyDigest: "d", evaluatedAt: "2026-01-01T00:00:00.000Z", authorizationModel: "snapshot" }, issuedAt: "2026-01-01T00:00:00.000Z", correlationId: "c1" }
const provenance = provenanceRecord as never
const base = { messageId: "m1", eventType: "invoice.created", payloadVersion: 1, occurredAt: "2026-09-11T00:00:00.000Z", scope: eventScope, correlationId: "c1", producer: { service: "billing" }, provenance }

describe("EV1 event contracts", () => {
  it("creates canonical scoped envelopes and validates registered payloads", () => {
    const envelope = createEventEnvelope({ ...base, payload: { id: "i1" } })
    const registry = new EventRegistry().register(defineEvent({ type: "invoice.created", versions: [{ version: 1, validate: payload => { if (typeof (payload as { id?: unknown }).id !== "string") throw new Error("invalid"); return payload } }] }))
    expect(envelope.scopeId).toMatch(/^fscope:v1:/)
    expect(registry.validate(envelope)).toEqual({ id: "i1" })
  })
  it("requires complete sequential upcasting before consumer acceptance", () => {
    const envelope = createEventEnvelope({ ...base, payload: { id: "i1" } })
    const registry = new EventRegistry().register(defineEvent({ type: "invoice.created", versions: [{ version: 1, validate: x => x }, { version: 2, validate: x => x }] }), [{ from: 1, to: 2, upcast: value => ({ ...(value as object), currency: "USD" }) }])
    expect(registry.upcast(envelope, 2)).toEqual({ id: "i1", currency: "USD" })
  })
  it("compiles explicit delivery semantics", () => {
    expect(defineConsumer({ key: "ledger", definitionVersion: 1, eventType: "invoice.created", acceptedPayloadVersions: [1, 2], authority: "event-provenance", retry: { maxAttempts: 5, delayMs: n => n * 100 }, transaction: { mode: "required" } }).transaction.mode).toBe("required")
  })
  it("rejects provenance scope mismatches", () => {
    const scope = { kind: "tenant" as const, tenantId: "t1" }
    const other = { kind: "tenant" as const, tenantId: "t2" }
    expect(() => createEventEnvelope({ ...base, scope, payload: { id: "i1" }, provenance: { ...provenanceRecord, target: { scope: other, scopeId: encodeExecutionScopeId(other) } } as never })).toThrow(/provenance target scope/)
  })
  it("defensively freezes plain payloads", () => {
    const scope = { kind: "tenant" as const, tenantId: "t1" }
    const envelope = createEventEnvelope({ ...base, scope, payload: { id: "i1" }, provenance: { ...provenanceRecord, target: { scope, scopeId: encodeExecutionScopeId(scope) } } as never })
    expect(() => { (envelope.payload as { id: string }).id = "changed" }).toThrow()
  })
  it("rejects mutable non-data payloads and impossible calendar timestamps", () => {
    expect(() => createEventEnvelope({ ...base, payload: { when: new Date() } })).toThrow(/plain data/)
    expect(() => createEventEnvelope({ ...base, occurredAt: "2026-02-31T00:00:00.000Z", payload: { id: "i1" } })).toThrow(/valid RFC 3339/)
  })
  it("binds envelope correlation and causation to durable provenance", () => {
    expect(() => createEventEnvelope({ ...base, correlationId: "other", payload: { id: "i1" } })).toThrow(/correlationId/)
    expect(() => createEventEnvelope({ ...base, causationId: "cause", payload: { id: "i1" } })).toThrow(/causationId/)
  })
  it("rejects incomplete durable provenance rather than accepting scope-only records", () => {
    expect(() => createEventEnvelope({ ...base, payload: { id: "i1" }, provenance: { ...provenanceRecord, grantId: " " } as never })).toThrow(/grantId/)
  })
  it("rejects malformed event definitions", () => {
    expect(() => defineEvent({ type: " ", versions: [{ version: 1, validate: value => value }] })).toThrow(/non-empty/)
    expect(() => defineEvent({ type: "invoice.created", versions: [] })).toThrow(/declare a version/)
    expect(() => defineEvent({ type: "invoice.created", versions: [{ version: 0, validate: value => value }] })).toThrow(/invalid/)
    expect(() => defineEvent({ type: "invoice.created", versions: [{ version: 1, validate: value => value }, { version: 1, validate: value => value }] })).toThrow(/duplicate/)
  })
  it("rejects malformed consumer definitions and deduplicates accepted versions", () => {
    const valid = { key: "ledger", definitionVersion: 1, eventType: "invoice.created", acceptedPayloadVersions: [1, 1, 2], authority: "event-provenance" as const, retry: { maxAttempts: 2, delayMs: () => 0 }, transaction: { mode: "at-least-once-idempotent" as const } }
    expect(defineConsumer(valid).acceptedPayloadVersions).toEqual([1, 2])
    expect(() => defineConsumer({ ...valid, key: "" })).toThrow(/non-empty/)
    expect(() => defineConsumer({ ...valid, definitionVersion: 0 })).toThrow(/definitionVersion/)
    expect(() => defineConsumer({ ...valid, retry: { ...valid.retry, maxAttempts: 0 } })).toThrow(/maxAttempts/)
    expect(() => defineConsumer({ ...valid, acceptedPayloadVersions: [0] })).toThrow(/accepted versions/)
    expect(() => defineConsumer({ ...valid, retry: { ...valid.retry, maxAttempts: 1 } })).toThrow(/redelivery/)
  })
  it("fails closed for duplicate, unknown, unsupported, missing-upcast, and downcast paths", () => {
    const definition = defineEvent({ type: "invoice.created", versions: [{ version: 1, validate: value => value }, { version: 2, validate: value => value }] })
    const registry = new EventRegistry().register(definition)
    expect(() => registry.register(definition)).toThrow(/Duplicate/)
    expect(() => registry.validate({ ...base, eventType: "unknown", payload: {} } as never)).toThrow(/Unknown/)
    expect(() => registry.validate({ ...base, payloadVersion: 3, payload: {} } as never)).toThrow(/Unsupported/)
    expect(() => registry.upcast({ ...base, payload: {} } as never, 3)).toThrow(/target version/)
    expect(() => registry.upcast({ ...base, payload: {} } as never, 2)).toThrow(/Missing event upcaster/)
    expect(() => registry.upcast({ ...base, payloadVersion: 2, payload: {} } as never, 1)).toThrow(/downcast/)
  })
})
