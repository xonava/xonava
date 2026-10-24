import { describe, expect, it } from "vitest"
import { createEventEnvelope } from "../eventEnvelope"
import { createEnvelopeFromOutboxRecord, createOutboxRecordFromEnvelope, normalizeOutboxRecord, type OutboxRecord } from "../durability/outbox"
import { ConfigurationError } from "../../domain/errors"
import { encodeExecutionScopeId } from "../../domain/executionScope"


const eventScope = { kind: "tenant", tenantId: "t1" } as const
const eventScopeId = encodeExecutionScopeId(eventScope)
const provenanceRecord = { format: "framework.authority-provenance", formatVersion: 1, actor: { id: "u1", kind: "human", authentication: { kind: "authenticated", method: "test", authenticatedAt: "2026-01-01T00:00:00.000Z" } }, subject: { id: "u1", kind: "human", authentication: { kind: "authenticated", method: "test", authenticatedAt: "2026-01-01T00:00:00.000Z" } }, source: { kind: "route", routeKey: "invoice.create" }, target: { scope: eventScope, scopeId: eventScopeId }, grantId: "g1", purpose: "create", reason: "request", delegationChain: [], policy: { policyKey: "p1", policyVersion: 1, policyDigest: "d", evaluatedAt: "2026-01-01T00:00:00.000Z", authorizationModel: "snapshot" }, issuedAt: "2026-01-01T00:00:00.000Z", correlationId: "c1" }
const provenance = provenanceRecord as never
const base = { messageId: "m1", eventType: "invoice.created", payloadVersion: 1, occurredAt: "2026-09-11T00:00:00.000Z", scope: eventScope, correlationId: "c1", producer: { service: "billing" }, provenance }

const input = (extra: Record<string, unknown> = {}) => ({ ...base, payload: { id: "i1" }, ...extra }) as Parameters<typeof createEventEnvelope<Record<string, unknown>>>[0]
const messageOf = (run: () => unknown): string => { try { run() } catch (error) { return (error as Error).message } return "did not throw" }

describe("createEventEnvelope validation messages", () => {
  it("names the empty field, including whitespace-only values", () => {
    expect(messageOf(() => createEventEnvelope(input({ messageId: "" })))).toBe("messageId must be non-empty")
    expect(messageOf(() => createEventEnvelope(input({ messageId: "   " })))).toBe("messageId must be non-empty")
    expect(messageOf(() => createEventEnvelope(input({ eventType: " " })))).toBe("eventType must be non-empty")
    expect(messageOf(() => createEventEnvelope(input({ correlationId: " " })))).toBe("correlationId must be non-empty")
    expect(messageOf(() => createEventEnvelope(input({ producer: { service: " " } })))).toBe("producer.service must be non-empty")
  })

  it("accepts a one-character field after trimming", () => {
    expect(createEventEnvelope(input({ messageId: " m " })).messageId).toBe(" m ")
  })

  it("rejects a payloadVersion that is not a positive safe integer", () => {
    for (const payloadVersion of [0, -1, 1.5, Number.NaN, 2 ** 60]) {
      expect(messageOf(() => createEventEnvelope(input({ payloadVersion })))).toBe("payloadVersion must be a positive integer")
    }
    expect(createEventEnvelope(input({ payloadVersion: 1 })).payloadVersion).toBe(1)
  })

  it("rejects timestamps that are not canonical millisecond UTC with the exact message", () => {
    for (const occurredAt of ["2026-09-11T00:00:00Z", "2026-09-11T00:00:00.000+00:00", "x2026-09-11T00:00:00.000Z", "2026-09-11T00:00:00.000Zx", "2026-09-11", ""]) {
      expect(messageOf(() => createEventEnvelope(input({ occurredAt })))).toBe("occurredAt must be an RFC 3339 UTC millisecond timestamp")
    }
    expect(messageOf(() => createEventEnvelope(input({ occurredAt: "2026-02-31T00:00:00.000Z" })))).toBe("occurredAt must be a valid RFC 3339 UTC millisecond timestamp")
  })
})

describe("createEventEnvelope provenance target binding", () => {
  const mismatch = "event provenance target scope does not match envelope scope"
  const other = { kind: "tenant", tenantId: "t2" } as const
  const otherId = encodeExecutionScopeId(other)

  it("rejects a consistent target that belongs to another scope", () => {
    expect(messageOf(() => createEventEnvelope(input({ provenance: { ...provenanceRecord, target: { scope: other, scopeId: otherId } } })))).toBe(mismatch)
  })
})

describe("createEventEnvelope result", () => {
  it("returns a frozen canonical envelope with copied scope and producer", () => {
    const producer = { service: "billing" }
    const scope = { ...eventScope }
    const envelope = createEventEnvelope(input({ producer, scope }))
    expect(envelope.format).toBe("framework.event")
    expect(envelope.formatVersion).toBe(1)
    expect(envelope.scopeId).toBe(eventScopeId)
    expect(envelope.scope).toEqual(eventScope)
    expect(envelope.scope).not.toBe(scope)
    expect(Object.isFrozen(envelope)).toBe(true)
    expect(Object.isFrozen(envelope.scope)).toBe(true)
    expect(envelope.producer).toEqual({ service: "billing" })
    expect(envelope.producer).not.toBe(producer)
    expect(Object.isFrozen(envelope.producer)).toBe(true)
  })
})

describe("outbox record to envelope", () => {
  const envelope = createEventEnvelope<Record<string, unknown>>(input())
  const record = (extra: Record<string, unknown> = {}): OutboxRecord => ({ ...createOutboxRecordFromEnvelope(envelope, "idem-1", { type: "invoice", id: "i1" }), ...extra }) as OutboxRecord

  it("round-trips an envelope through its outbox record", () => {
    const rebuilt = createEnvelopeFromOutboxRecord(record())
    expect(rebuilt).toEqual(envelope)
    expect("causationId" in rebuilt).toBe(false)
  })

  it("carries the causation id when present", () => {
    const withCause = createEventEnvelope<Record<string, unknown>>(input({ causationId: "cause-1", provenance: { ...provenanceRecord, causationId: "cause-1" } }))
    const stored = createOutboxRecordFromEnvelope(withCause, "idem-1", { type: "invoice", id: "i1" })
    expect(stored.causationId).toBe("cause-1")
    expect(createEnvelopeFromOutboxRecord(stored).causationId).toBe("cause-1")
    expect("causationId" in createOutboxRecordFromEnvelope(envelope, "idem-1", { type: "invoice", id: "i1" })).toBe(false)
  })

  it("falls back to the provenance correlation id and keeps an explicit one", () => {
    const { correlationId: _omitted, ...withoutCorrelation } = record()
    expect(createEnvelopeFromOutboxRecord(withoutCorrelation as OutboxRecord).correlationId).toBe("c1")
    expect(() => createEnvelopeFromOutboxRecord(record({ correlationId: "other" }))).toThrow(/correlationId/)
  })

  it("fails closed without provenance, producer or a usable correlation id", () => {
    expect(messageOf(() => createEnvelopeFromOutboxRecord(record({ provenance: undefined })))).toBe("Outbox record has no authority provenance; it cannot be published as an event envelope")
    expect(messageOf(() => createEnvelopeFromOutboxRecord(record({ producer: undefined })))).toBe("Outbox record has no producer identity")
    expect(messageOf(() => createEnvelopeFromOutboxRecord(record({ correlationId: "" })))).toBe("Outbox record has no correlation id")
    expect(messageOf(() => createEnvelopeFromOutboxRecord(record({ correlationId: 5 })))).toBe("Outbox record has no correlation id")
    const { correlationId: _c, ...noCorrelationProvenance } = provenanceRecord
    const bare = { ...record({ provenance: noCorrelationProvenance }) } as Record<string, unknown>
    delete bare.correlationId
    expect(messageOf(() => createEnvelopeFromOutboxRecord(bare as unknown as OutboxRecord))).toBe("Outbox record has no correlation id")
  })

  it("rejects a record whose scope and scopeId disagree when normalizing", () => {
    const stored = { type: "created", version: 1, scope: eventScope, scopeId: otherScopeId(), aggregateType: "row", aggregateId: "1", payload: {}, idempotencyKey: "1" }
    expect(() => normalizeOutboxRecord(stored, { id: "g", occurredAt: new Date(0) })).toThrow("outbox scope identity mismatch")
  })
})

function otherScopeId() { return encodeExecutionScopeId({ kind: "tenant", tenantId: "t2" }) }
