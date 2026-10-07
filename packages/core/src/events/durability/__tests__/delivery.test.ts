import { describe, expect, it, vi } from "vitest"
import {
  acknowledgeInboxRecord, appendOutboxDelivery, assertDeliveryClaimAlive, claimInboxRecord, claimOutboxDelivery, deadLetterInboxRecord,
  isDeliveryClaimable, markOutboxDeliveryPublished, normalizeDeliveryFailureCode, observeInboxRecord, recordOutboxDeliveryFailure,
  renewInboxClaim, replayInboxRecord, scheduleInboxRetry,
} from "../delivery"
import { consumeInboxMessage, createInboxRecord, deliverOutboxMessage } from "../deliveryRunner"
import type { InboxKey, InboxPort, InboxRecord } from "../inbox"
import type { EventPublisher, OutboxDeliveryKey, OutboxDeliveryRecord, OutboxStore } from "../outboxStore"
import { defineConsumer } from "../../consumerDefinition"
import { createEnvelopeFromOutboxRecord, createOutboxRecordFromEnvelope } from "../outbox"
import { ConfigurationError, ConflictError, StaleClaimError, ValidationError, RetryablePersistenceError } from "../../../domain/errors"
import type { EventEnvelope } from "../../eventEnvelope"

const t0 = new Date("2026-10-01T00:00:00.000Z")
const at = (ms: number) => new Date(t0.getTime() + ms)
const scopeId = "fscope:v1:test" as never
const provenance = { format: "framework.authority-provenance", formatVersion: 1, correlationId: "corr-1" } as never
const envelope = { format: "framework.event", formatVersion: 1, messageId: "m1", eventType: "order.placed", payloadVersion: 1, occurredAt: t0.toISOString(), scope: { kind: "tenant", tenantId: "t1" }, scopeId, correlationId: "corr-1", producer: { service: "orders" }, provenance, payload: { id: "o1" } } as unknown as EventEnvelope

const outbox = (): OutboxDeliveryRecord => ({ envelope, scopeId, idempotencyKey: "k1", state: "pending", attempt: 0, claim: null })

describe("outbox delivery state machine", () => {
  it("claims, fences, publishes, and refuses stale tokens", () => {
    const claimed = claimOutboxDelivery(outbox(), { owner: "relay", token: "tok-1", leaseMs: 1000, now: t0 })!
    expect(claimed).toMatchObject({ state: "claimed", attempt: 1, claim: { token: "tok-1", leaseExpiresAt: at(1000).toISOString() } })
    expect(claimOutboxDelivery(claimed, { owner: "other", token: "tok-2", leaseMs: 1000, now: at(999) })).toBeNull()
    expect(() => markOutboxDeliveryPublished(claimed, "wrong", at(10))).toThrow(StaleClaimError)
    expect(() => markOutboxDeliveryPublished(claimed, "tok-1", at(1000))).toThrow(StaleClaimError)
    expect(markOutboxDeliveryPublished(claimed, "tok-1", at(10))).toMatchObject({ state: "published", claim: null, publishedAt: at(10).toISOString() })
    const takeover = claimOutboxDelivery(claimed, { owner: "other", token: "tok-2", leaseMs: 1000, now: at(1000) })!
    expect(takeover.attempt).toBe(2)
  })

  it("schedules retries then dead-letters at maxAttempts, with bounded failure codes", () => {
    let record = claimOutboxDelivery(outbox(), { owner: "r", token: "a", leaseMs: 1000, now: t0 })!
    record = recordOutboxDeliveryFailure(record, { token: "a", code: "BROKER_DOWN", delayMs: 500, maxAttempts: 2, now: at(1) })
    expect(record).toMatchObject({ state: "retry_scheduled", nextAttemptAt: at(501).toISOString(), lastFailure: { code: "BROKER_DOWN" } })
    expect(isDeliveryClaimable(record, at(500))).toBe(false)
    record = claimOutboxDelivery(record, { owner: "r", token: "b", leaseMs: 1000, now: at(501) })!
    expect(record).not.toHaveProperty("nextAttemptAt")
    record = recordOutboxDeliveryFailure(record, { token: "b", code: "free text with alice@example.com", delayMs: 500, maxAttempts: 2, now: at(600) })
    expect(record).toMatchObject({ state: "dead_lettered", lastFailure: { code: "DELIVERY_FAILED" } })
    expect(isDeliveryClaimable(record, at(10_000_000))).toBe(false)
  })

  it("appends idempotently and rejects a reused id with a different idempotency key", () => {
    const first = outbox()
    expect(appendOutboxDelivery(null, first)).toBe(first)
    expect(appendOutboxDelivery(first, { ...outbox() })).toBe(first)
    expect(() => appendOutboxDelivery(first, { ...outbox(), idempotencyKey: "other" })).toThrow(ConflictError)
    expect(() => appendOutboxDelivery(null, { ...outbox(), attempt: 3 })).toThrow(ConfigurationError)
  })

  it("validates leases, delays, attempts, owners, tokens, and clocks", () => {
    expect(() => claimOutboxDelivery(outbox(), { owner: "r", token: "a", leaseMs: 0, now: t0 })).toThrow(ConfigurationError)
    expect(() => claimOutboxDelivery(outbox(), { owner: " ", token: "a", leaseMs: 10, now: t0 })).toThrow(ConfigurationError)
    expect(() => claimOutboxDelivery(outbox(), { owner: "r", token: "", leaseMs: 10, now: t0 })).toThrow(ConfigurationError)
    expect(() => claimOutboxDelivery(outbox(), { owner: "r", token: "a", leaseMs: 10, now: new Date("x") })).toThrow(ConfigurationError)
    const claimed = claimOutboxDelivery(outbox(), { owner: "r", token: "a", leaseMs: 10, now: t0 })!
    expect(() => recordOutboxDeliveryFailure(claimed, { token: "a", code: "X", delayMs: -1, maxAttempts: 3, now: t0 })).toThrow(ConfigurationError)
    expect(() => recordOutboxDeliveryFailure(claimed, { token: "a", code: "X", delayMs: 1, maxAttempts: 0, now: t0 })).toThrow(ConfigurationError)
    expect(() => assertDeliveryClaimAlive({ state: "pending", claim: null }, "a", t0)).toThrow(StaleClaimError)
    expect(normalizeDeliveryFailureCode("OK_CODE-1:x")).toBe("OK_CODE-1:x")
    expect(normalizeDeliveryFailureCode(42)).toBe("DELIVERY_FAILED")
  })
})

const consumer = defineConsumer({ key: "ledger", definitionVersion: 1, eventType: "order.placed", acceptedPayloadVersions: [1], authority: "event-provenance", retry: { maxAttempts: 3, delayMs: () => 100 }, transaction: { mode: "required" } })

describe("inbox delivery state machine", () => {
  const base = (): InboxRecord => createInboxRecord(envelope, consumer, t0)

  it("observes once, claims, renews, acknowledges, and records history", () => {
    const observed = observeInboxRecord(null, base(), t0)
    expect(observeInboxRecord(observed, { ...base(), consumerDefinitionVersion: 9 }, at(5))).toBe(observed)
    const claimed = claimInboxRecord(observed, { owner: "w", token: "c1", leaseMs: 100, now: t0 })!
    const renewed = renewInboxClaim(claimed, { token: "c1", leaseMs: 1000, now: at(50) })
    expect(renewed.claim!.leaseExpiresAt).toBe(at(1050).toISOString())
    const processed = acknowledgeInboxRecord(renewed, "c1", at(60))
    expect(processed).toMatchObject({ state: "processed", claim: null, history: [{ terminalState: "processed", generation: 0 }] })
    expect(claimInboxRecord(processed, { owner: "w", token: "c2", leaseMs: 100, now: at(10_000) })).toBeNull()
  })

  it("retries, dead-letters at the limit, and replays under a new generation", () => {
    let record = claimInboxRecord(base(), { owner: "w", token: "c1", leaseMs: 100, now: t0 })!
    record = scheduleInboxRetry(record, { token: "c1", code: "TEMP", delayMs: 10, maxAttempts: 2, now: at(1) })
    expect(record).toMatchObject({ state: "retry_scheduled", lastFailure: { retryable: true } })
    record = claimInboxRecord(record, { owner: "w", token: "c2", leaseMs: 100, now: at(11) })!
    record = scheduleInboxRetry(record, { token: "c2", code: "TEMP", delayMs: 10, maxAttempts: 2, now: at(12) })
    expect(record).toMatchObject({ state: "dead_lettered", lastFailure: { retryable: false }, history: [{ terminalState: "dead_lettered" }] })
    expect(() => replayInboxRecord(record, { requestedBy: provenance, reason: " ", now: at(20) })).toThrow(ConfigurationError)
    const replayed = replayInboxRecord(record, { requestedBy: provenance, reason: "operator fix", now: at(20) })
    expect(replayed).toMatchObject({ state: "pending", attempt: 0, replayGeneration: 1, history: [{ terminalState: "dead_lettered" }] })
    expect(() => replayInboxRecord(replayed, { requestedBy: provenance, reason: "again", now: at(21) })).toThrow(ConflictError)
    const direct = deadLetterInboxRecord(claimInboxRecord(base(), { owner: "w", token: "c3", leaseMs: 100, now: t0 })!, { token: "c3", code: "POISON", now: at(1) })
    expect(direct.lastFailure).toMatchObject({ code: "POISON", retryable: false })
  })
})

class Clock { now = t0.getTime(); date() { return new Date(this.now) } }

class MemoryOutbox implements OutboxStore {
  rows = new Map<string, OutboxDeliveryRecord>(); #token = 0
  constructor(private readonly clock: Clock) {}
  async append(record: OutboxDeliveryRecord) { const next = appendOutboxDelivery(this.rows.get(record.envelope.messageId) ?? null, record); this.rows.set(record.envelope.messageId, next); return next }
  async get(key: OutboxDeliveryKey) { return this.rows.get(key.messageId) ?? null }
  async claim(key: OutboxDeliveryKey, owner: string, leaseMs: number, maxAttempts?: number) { const next = claimOutboxDelivery(this.rows.get(key.messageId)!, { owner, token: `t${++this.#token}`, leaseMs, now: this.clock.date(), ...(maxAttempts !== undefined ? { maxAttempts } : {}) }); if (next) this.rows.set(key.messageId, next); return next }
  async markPublished(key: OutboxDeliveryKey, token: string) { const next = markOutboxDeliveryPublished(this.rows.get(key.messageId)!, token, this.clock.date()); this.rows.set(key.messageId, next); return next }
  async recordFailure(key: OutboxDeliveryKey, token: string, code: string, delayMs: number, maxAttempts: number) { const next = recordOutboxDeliveryFailure(this.rows.get(key.messageId)!, { token, code, delayMs, maxAttempts, now: this.clock.date() }); this.rows.set(key.messageId, next); return next }
}

describe("outbox delivery runner", () => {
  const key = { messageId: "m1", scopeId }
  const policy = { maxAttempts: 2, initialDelayMs: 100, backoffMultiplier: 2, maxDelayMs: 1000, jitter: "none" as const }

  it("publishes and marks the delivery published", async () => {
    const clock = new Clock(); const store = new MemoryOutbox(clock); await store.append(outbox())
    const publisher: EventPublisher = { publish: vi.fn(async () => {}) }
    await expect(deliverOutboxMessage({ store, publisher, key, owner: "relay", leaseMs: 1000, retry: policy })).resolves.toMatchObject({ outcome: "published" })
    expect(publisher.publish).toHaveBeenCalledWith(envelope, expect.any(AbortSignal))
    await expect(deliverOutboxMessage({ store, publisher, key, owner: "relay", leaseMs: 1000 })).resolves.toMatchObject({ outcome: "not_claimable" })
  })

  it("backs off transient failures, dead-letters at the limit, and dead-letters permanent errors at once", async () => {
    const clock = new Clock(); const store = new MemoryOutbox(clock); await store.append(outbox())
    const failing: EventPublisher = { publish: async () => { throw new RetryablePersistenceError("broker busy") } }
    await expect(deliverOutboxMessage({ store, publisher: failing, key, owner: "r", leaseMs: 1000, retry: policy })).resolves.toMatchObject({ outcome: "retry_scheduled", record: { nextAttemptAt: at(100).toISOString(), lastFailure: { code: "RETRYABLE_PERSISTENCE_ERROR" } } })
    clock.now += 100
    await expect(deliverOutboxMessage({ store, publisher: failing, key, owner: "r", leaseMs: 1000, retry: policy })).resolves.toMatchObject({ outcome: "dead_lettered" })

    const store2 = new MemoryOutbox(clock); await store2.append(outbox())
    await expect(deliverOutboxMessage({ store: store2, publisher: { publish: async () => { throw new ValidationError("schema rejected") } }, key, owner: "r", leaseMs: 1000, retry: { ...policy, maxAttempts: 5 } })).resolves.toMatchObject({ outcome: "dead_lettered", record: { attempt: 1 } })
  })

  it("bounds a hanging publish by the lease and never leaks its timer", async () => {
    vi.useFakeTimers()
    try {
      const clock = new Clock(); const store = new MemoryOutbox(clock); await store.append(outbox())
      const run = deliverOutboxMessage({ store, publisher: { publish: (_e, signal) => new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason))) }, key, owner: "r", leaseMs: 1000, retry: policy })
      await vi.advanceTimersByTimeAsync(800)
      await expect(run).resolves.toMatchObject({ outcome: "retry_scheduled", record: { lastFailure: { code: "TIMEOUT" } } })
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it("leaves the claim to lapse on shutdown", async () => {
    const clock = new Clock(); const store = new MemoryOutbox(clock); await store.append(outbox())
    const controller = new AbortController()
    const run = deliverOutboxMessage({ store, publisher: { publish: async () => { controller.abort(new Error("shutdown")); throw new Error("aborted") } }, key, owner: "r", leaseMs: 1000, signal: controller.signal })
    await expect(run).resolves.toMatchObject({ outcome: "cancelled" })
    expect(store.rows.get("m1")!.state).toBe("claimed")
    await expect(deliverOutboxMessage({ store, publisher: { publish: async () => {} }, key, owner: "r", leaseMs: 1000, signal: controller.signal })).resolves.toMatchObject({ outcome: "cancelled" })
  })
})

class MemoryInbox implements InboxPort {
  rows = new Map<string, InboxRecord>(); #token = 0; committed: unknown[] = []
  constructor(private readonly clock: Clock) {}
  #id(key: InboxKey) { return `${key.consumerKey}:${key.messageId}` }
  #set(key: InboxKey, record: InboxRecord) { this.rows.set(this.#id(key), record); return record }
  async observe(record: InboxRecord) { return this.#set(record, observeInboxRecord(this.rows.get(this.#id(record)) ?? null, record, this.clock.date())) }
  async get(key: InboxKey) { return this.rows.get(this.#id(key)) ?? null }
  async claim(key: InboxKey, owner: string, leaseMs: number, maxAttempts?: number) { const next = claimInboxRecord(this.rows.get(this.#id(key))!, { owner, token: `c${++this.#token}`, leaseMs, now: this.clock.date(), ...(maxAttempts !== undefined ? { maxAttempts } : {}) }); return next ? this.#set(key, next) : null }
  async renew(key: InboxKey, token: string, leaseMs: number) { return this.#set(key, renewInboxClaim(this.rows.get(this.#id(key))!, { token, leaseMs, now: this.clock.date() })) }
  async acknowledge<T>(key: InboxKey, token: string, mutation: (transaction?: unknown) => Promise<T>) { const next = acknowledgeInboxRecord(this.rows.get(this.#id(key))!, token, this.clock.date()); const result = await mutation("tx"); this.committed.push(result); return { record: this.#set(key, next), result } }
  async scheduleRetry(key: InboxKey, token: string, code: string, delayMs: number, maxAttempts: number) { return this.#set(key, scheduleInboxRetry(this.rows.get(this.#id(key))!, { token, code, delayMs, maxAttempts, now: this.clock.date() })) }
  async deadLetter(key: InboxKey, token: string, code: string) { return this.#set(key, deadLetterInboxRecord(this.rows.get(this.#id(key))!, { token, code, now: this.clock.date() })) }
  async replay(): Promise<InboxRecord> { throw new Error("unused") }
}

describe("inbox consumer runner", () => {
  it("processes exactly once inside the acknowledgement transaction", async () => {
    const clock = new Clock(); const inbox = new MemoryInbox(clock)
    const handle = vi.fn(async (context: { transaction?: unknown; attempt: number }) => ({ tx: context.transaction, attempt: context.attempt }))
    await expect(consumeInboxMessage({ inbox, envelope, consumer, owner: "w", leaseMs: 1000, handle, now: () => clock.date() })).resolves.toMatchObject({ outcome: "processed", result: { tx: "tx", attempt: 1 } })
    await expect(consumeInboxMessage({ inbox, envelope, consumer, owner: "w", leaseMs: 1000, handle, now: () => clock.date() })).resolves.toMatchObject({ outcome: "already_processed" })
    expect(handle).toHaveBeenCalledOnce()
  })

  it("retries transient handler errors, dead-letters permanent ones, and defers unknown payload versions", async () => {
    const clock = new Clock()
    const transient = new MemoryInbox(clock)
    await expect(consumeInboxMessage({ inbox: transient, envelope, consumer, owner: "w", leaseMs: 1000, handle: async () => { throw new RetryablePersistenceError("deadlock") } })).resolves.toMatchObject({ outcome: "retry_scheduled", record: { nextAttemptAt: at(100).toISOString() } })
    const permanent = new MemoryInbox(clock)
    await expect(consumeInboxMessage({ inbox: permanent, envelope, consumer, owner: "w", leaseMs: 1000, handle: async () => { throw new ValidationError("bad payload") } })).resolves.toMatchObject({ outcome: "dead_lettered", record: { lastFailure: { code: "VALIDATION_ERROR" } } })
    const future = new MemoryInbox(clock)
    const handle = vi.fn()
    await expect(consumeInboxMessage({ inbox: future, envelope: { ...envelope, payloadVersion: 2 }, consumer, owner: "w", leaseMs: 1000, handle })).resolves.toMatchObject({ outcome: "retry_scheduled", record: { lastFailure: { code: "UNSUPPORTED_PAYLOAD_VERSION" } } })
    expect(handle).not.toHaveBeenCalled()
  })

  it("uses the serializable consumer backoff when declared", async () => {
    const clock = new Clock(); const inbox = new MemoryInbox(clock)
    const withBackoff = defineConsumer({ ...consumer, backoff: { maxAttempts: 4, initialDelayMs: 250, backoffMultiplier: 2, maxDelayMs: 1000, jitter: "none" } })
    await expect(consumeInboxMessage({ inbox, envelope, consumer: withBackoff, owner: "w", leaseMs: 1000, handle: async () => { throw new Error("transient") } })).resolves.toMatchObject({ record: { nextAttemptAt: at(250).toISOString() } })
    expect(() => defineConsumer({ ...consumer, backoff: { maxAttempts: 0, initialDelayMs: 0, backoffMultiplier: 1, maxDelayMs: 0, jitter: "none" } })).toThrow()
  })

  it("rejects envelopes routed to the wrong consumer", async () => {
    await expect(consumeInboxMessage({ inbox: new MemoryInbox(new Clock()), envelope: { ...envelope, eventType: "other" }, consumer, owner: "w", leaseMs: 1000, handle: async () => 1 })).rejects.toThrow(ConfigurationError)
  })
})

describe("outbox provenance round trip", () => {
  it("carries provenance into the outbox record and fails closed without it", () => {
    const record = createOutboxRecordFromEnvelope(envelope, "k1", { type: "order", id: "o1" })
    expect(record.provenance).toBe(provenance)
    const { provenance: _removed, ...withoutProvenance } = record
    expect(() => createEnvelopeFromOutboxRecord(withoutProvenance)).toThrow(/provenance/)
    expect(() => createEnvelopeFromOutboxRecord({ ...record, producer: undefined as never })).toThrow(/producer/)
  })
})
