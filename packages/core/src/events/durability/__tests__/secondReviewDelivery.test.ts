import { describe, expect, it } from "vitest"
import { appendOutboxDelivery, claimInboxRecord, claimOutboxDelivery, markOutboxDeliveryPublished, observeInboxRecord, recordOutboxDeliveryFailure } from "../delivery"
import { createInboxRecord, deliverOutboxMessage } from "../deliveryRunner"
import type { InboxRecord } from "../inbox"
import type { OutboxDeliveryKey, OutboxDeliveryRecord, OutboxStore } from "../outboxStore"
import { defineConsumer } from "../../consumerDefinition"
import { ConflictError } from "../../../domain/errors"
import type { EventEnvelope } from "../../eventEnvelope"

const t0 = new Date("2026-10-01T00:00:00.000Z")
const at = (ms: number) => new Date(t0.getTime() + ms)
const scopeId = "fscope:v1:test" as never
const provenance = { format: "framework.authority-provenance", formatVersion: 1, correlationId: "corr-1" } as never
const envelope = { format: "framework.event", formatVersion: 1, messageId: "m1", eventType: "order.placed", payloadVersion: 1, occurredAt: t0.toISOString(), scope: { kind: "tenant", tenantId: "t1" }, scopeId, correlationId: "corr-1", producer: { service: "orders" }, provenance, payload: { id: "o1" } } as unknown as EventEnvelope
const outbox = (): OutboxDeliveryRecord => ({ envelope, scopeId, idempotencyKey: "k1", state: "pending", attempt: 0, claim: null })
const consumer = defineConsumer({ key: "ledger", definitionVersion: 1, eventType: "order.placed", acceptedPayloadVersions: [1], authority: "event-provenance", retry: { maxAttempts: 2, delayMs: () => 100 }, transaction: { mode: "required" } })

describe("delivery claims enforce maxAttempts (C5)", () => {
  it("dead-letters an expired outbox claim whose attempts are exhausted instead of re-claiming it", () => {
    let record = claimOutboxDelivery(outbox(), { owner: "r", token: "a", leaseMs: 100, now: t0, maxAttempts: 2 })!
    record = claimOutboxDelivery(record, { owner: "r", token: "b", leaseMs: 100, now: at(100), maxAttempts: 2 })!
    expect(record).toMatchObject({ state: "claimed", attempt: 2 })
    const next = claimOutboxDelivery(record, { owner: "r", token: "c", leaseMs: 100, now: at(200), maxAttempts: 2 })
    expect(next).toMatchObject({ state: "dead_lettered", attempt: 2, claim: null, lastFailure: { code: "LEASE_EXPIRED", occurredAt: at(200).toISOString() } })
    expect(claimOutboxDelivery(next!, { owner: "r", token: "d", leaseMs: 100, now: at(10_000), maxAttempts: 2 })).toBeNull()
  })

  it("dead-letters an expired inbox claim whose attempts are exhausted and records history", () => {
    const base = observeInboxRecord(null, createInboxRecord(envelope, consumer, t0), t0)
    const claimed = claimInboxRecord(base, { owner: "w", token: "c1", leaseMs: 100, now: t0, maxAttempts: 1 })!
    const next = claimInboxRecord(claimed, { owner: "w", token: "c2", leaseMs: 100, now: at(100), maxAttempts: 1 }) as InboxRecord
    expect(next).toMatchObject({ state: "dead_lettered", attempt: 1, claim: null, lastFailure: { code: "LEASE_EXPIRED", retryable: false } })
    expect(next.history.at(-1)).toMatchObject({ terminalState: "dead_lettered", failure: { code: "LEASE_EXPIRED" } })
  })

  it("the outbox runner reports dead_lettered when a crashed final attempt's lease lapses", async () => {
    let now = t0.getTime()
    const rows = new Map<string, OutboxDeliveryRecord>([["m1", outbox()]])
    let token = 0
    const store: OutboxStore = {
      append: async (record) => record,
      get: async (key: OutboxDeliveryKey) => rows.get(key.messageId) ?? null,
      claim: async (key, owner, leaseMs, maxAttempts) => { const next = claimOutboxDelivery(rows.get(key.messageId)!, { owner, token: `t${++token}`, leaseMs, now: new Date(now), ...(maxAttempts !== undefined ? { maxAttempts } : {}) }); if (next) rows.set(key.messageId, next); return next },
      markPublished: async (key, tok) => markOutboxDeliveryPublished(rows.get(key.messageId)!, tok, new Date(now)),
      recordFailure: async (key, tok, code, delayMs, maxAttempts) => recordOutboxDeliveryFailure(rows.get(key.messageId)!, { token: tok, code, delayMs, maxAttempts, now: new Date(now) }),
    }
    // Simulate a worker that claimed the final attempt and crashed.
    rows.set("m1", { ...outbox(), state: "claimed", attempt: 3, claim: { token: "dead", owner: "crashed", claimedAt: t0.toISOString(), leaseExpiresAt: at(100).toISOString() } })
    now += 100
    let published = 0
    const result = await deliverOutboxMessage({ store, publisher: { publish: async () => { published++ } }, key: { messageId: "m1", scopeId }, owner: "r", leaseMs: 1000, retry: { maxAttempts: 3, initialDelayMs: 1, backoffMultiplier: 1, maxDelayMs: 1, jitter: "none" } })
    expect(result).toMatchObject({ outcome: "dead_lettered", record: { state: "dead_lettered", attempt: 3 } })
    expect(published).toBe(0)
  })
})

describe("outbox append compares payloads", () => {
  it("rejects a reused message id with a different payload and accepts an equal copy", () => {
    const first = outbox()
    expect(appendOutboxDelivery(first, { ...outbox(), envelope: JSON.parse(JSON.stringify(envelope)) as EventEnvelope })).toBe(first)
    expect(() => appendOutboxDelivery(first, { ...outbox(), envelope: { ...envelope, payload: { id: "o2" } } as EventEnvelope })).toThrow(ConflictError)
    expect(() => appendOutboxDelivery(first, { ...outbox(), envelope: { ...envelope, eventType: "order.cancelled" } as EventEnvelope })).toThrow(ConflictError)
  })
})
