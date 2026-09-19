import { describe, expect, it, vi } from "vitest"
import { encodeExecutionScopeId } from "../../../domain/executionScope"
import { createAuditSinkFactory, classifyAuditValue, defaultAuditSanitizer } from "../audit"
import { createIdempotencyNamespace, isAtomicBatchIdempotencyPort, isDurableIdempotencyPort, isIdempotencyFinalizationPort, isTransactionalIdempotencyPort } from "../idempotency"
import { assertOutboxScope, createOutboxRecordFromEnvelope, normalizeOutboxRecord } from "../outbox"

const scope = { kind: "tenant", tenantId: "t1" } as const
const scopeId = encodeExecutionScopeId(scope)

describe("durability boundary coverage", () => {
  it("applies audit classification, preserves scalars, and avoids array accessors", () => {
    expect(classifyAuditValue("plain", { plain: "mask" })).toBe("plain")
    expect(classifyAuditValue({ email: "a@b.com", name: "Alice", status: "ok" }, { email: "mask", name: "omit" })).toEqual({ email: "[masked]", status: "ok" })
    let reads = 0
    const array: unknown[] = []
    Object.defineProperty(array, "0", { enumerable: true, configurable: true, get: () => { reads += 1; return "secret" } })
    array.length = 1
    expect(defaultAuditSanitizer(array)).toEqual(["[unavailable]"])
    expect(reads).toBe(0)
  })

  it("adapts audit sinks without invoking their constructor early", async () => {
    const write = vi.fn(async () => {})
    const create = vi.fn(() => ({ write }))
    const factory = createAuditSinkFactory(create)
    expect(create).not.toHaveBeenCalled()
    const persistence = { dialect: "test" } as never
    expect(factory.create(persistence)).toEqual({ write })
    expect(create).toHaveBeenCalledWith(persistence)
  })

  it("validates and freezes idempotency namespaces", () => {
    expect(() => createIdempotencyNamespace(scope, "", { completedTtlMs: 1, abandonedTtlMs: 1 })).toThrow(/operationKey/)
    expect(() => createIdempotencyNamespace(scope, "write", { completedTtlMs: 0, abandonedTtlMs: 1 })).toThrow(/completedTtlMs/)
    expect(() => createIdempotencyNamespace(scope, "write", { completedTtlMs: 1, abandonedTtlMs: 1.5 })).toThrow(/abandonedTtlMs/)
    const namespace = createIdempotencyNamespace(scope, "write", { completedTtlMs: 10, abandonedTtlMs: 5 })
    expect(namespace.value).toBe(`${scopeId}:write`)
    expect(Object.isFrozen(namespace)).toBe(true)
    expect(Object.isFrozen(namespace.retention)).toBe(true)
  })

  it("detects durable and finalization port capabilities only when complete", () => {
    const base = { acquire: vi.fn(), renew: vi.fn(), complete: vi.fn() }
    expect(isTransactionalIdempotencyPort(base as never)).toBe(false)
    expect(isAtomicBatchIdempotencyPort(base as never)).toBe(false)
    expect(isDurableIdempotencyPort(base as never)).toBe(false)
    expect(isIdempotencyFinalizationPort(base as never)).toBe(false)
    expect(isTransactionalIdempotencyPort({ ...base, markCommittedInTransaction() {} } as never)).toBe(true)
    expect(isAtomicBatchIdempotencyPort({ ...base, createCommitBatchItem() {} } as never)).toBe(true)
    expect(isIdempotencyFinalizationPort({ ...base, claimPendingInvalidations() {}, ackClaimedInvalidation() {}, completeClaimedInvalidation() {} } as never)).toBe(true)
    expect(isIdempotencyFinalizationPort({ ...base, claimPendingInvalidations() {}, ackClaimedInvalidation() {} } as never)).toBe(false)
  })

  it("binds outbox records to scope and preserves envelope causation semantics", () => {
    expect(() => assertOutboxScope({ scope, scopeId: encodeExecutionScopeId({ kind: "tenant", tenantId: "other" }) })).toThrow(/mismatch/)
    const envelope = { messageId: "m1", eventType: "created", payloadVersion: 1, scope, scopeId, correlationId: "c1", causationId: "cause", producer: { service: "svc" }, payload: { id: "1" }, occurredAt: "2026-09-18T00:00:00.000Z" }
    expect(createOutboxRecordFromEnvelope(envelope as never, "idem", { type: "order", id: "1" })).toMatchObject({ id: "m1", causationId: "cause", aggregateType: "order", idempotencyKey: "idem" })
    const { causationId: _causationId, ...envelopeWithoutCause } = envelope
    const withoutCause = createOutboxRecordFromEnvelope(envelopeWithoutCause as never, "idem", { type: "order", id: "1" })
    expect(withoutCause).not.toHaveProperty("causationId")
    const defaults = { id: "generated", occurredAt: new Date("2026-09-18T00:00:00Z") }
    const { id: _id, occurredAt: _occurredAt, ...newRecord } = withoutCause
    expect(normalizeOutboxRecord(newRecord, defaults)).toMatchObject(defaults)
    expect(normalizeOutboxRecord(withoutCause, defaults).id).toBe("m1")
  })
})
