import { describe, expect, it, vi } from "vitest"
import { acknowledgeInboxRecord, appendOutboxDelivery, claimInboxRecord, claimOutboxDelivery, deadLetterInboxRecord, markOutboxDeliveryPublished, observeInboxRecord, recordOutboxDeliveryFailure, scheduleInboxRetry } from "../delivery"
import { consumeInboxMessage, deliverOutboxMessage } from "../deliveryRunner"
import type { InboxKey, InboxPort, InboxRecord } from "../inbox"
import type { OutboxDeliveryKey, OutboxDeliveryRecord, OutboxStore } from "../outboxStore"
import { defineConsumer } from "../../consumerDefinition"
import { ConflictError } from "../../../domain/errors"
import type { EventEnvelope } from "../../eventEnvelope"

const t0 = new Date("2026-10-01T00:00:00.000Z")
const scopeId = "fscope:v1:test" as never
const provenance = { format: "framework.authority-provenance", formatVersion: 1, correlationId: "corr-1" } as never
const envelope = { format: "framework.event", formatVersion: 1, messageId: "m1", eventType: "order.placed", payloadVersion: 1, occurredAt: t0.toISOString(), scope: { kind: "tenant", tenantId: "t1" }, scopeId, correlationId: "corr-1", producer: { service: "orders" }, provenance, payload: { id: "o1" } } as unknown as EventEnvelope
const outbox = (payload: unknown = envelope.payload): OutboxDeliveryRecord => ({ envelope: { ...envelope, payload } as EventEnvelope, scopeId, idempotencyKey: "k1", state: "pending", attempt: 0, claim: null })
const consumer = defineConsumer({ key: "ledger", definitionVersion: 1, eventType: "order.placed", acceptedPayloadVersions: [1], authority: "event-provenance", retry: { maxAttempts: 2, delayMs: () => 100 }, transaction: { mode: "required" } })

describe("delivery runners honour a shutdown that lands during claim", () => {
  it("does not publish or mark published when aborted while claiming an outbox message", async () => {
    const controller = new AbortController()
    const rows = new Map<string, OutboxDeliveryRecord>([["m1", outbox()]])
    const markPublished = vi.fn(async (key: OutboxDeliveryKey, token: string) => markOutboxDeliveryPublished(rows.get(key.messageId)!, token, t0))
    const recordFailure = vi.fn(async (key: OutboxDeliveryKey, token: string, code: string, delayMs: number, maxAttempts: number) => recordOutboxDeliveryFailure(rows.get(key.messageId)!, { token, code, delayMs, maxAttempts, now: t0 }))
    const store: OutboxStore = {
      append: async (record) => record,
      get: async (key) => rows.get(key.messageId) ?? null,
      claim: async (key, owner, leaseMs) => { const next = claimOutboxDelivery(rows.get(key.messageId)!, { owner, token: "t1", leaseMs, now: t0 })!; rows.set(key.messageId, next); controller.abort(new Error("shutdown")); return next },
      markPublished,
      recordFailure,
    }
    const publish = vi.fn(async () => undefined)
    const result = await deliverOutboxMessage({ store, publisher: { publish }, key: { messageId: "m1", scopeId }, owner: "r", leaseMs: 1000, signal: controller.signal })
    expect(result.outcome).toBe("cancelled")
    expect(publish).not.toHaveBeenCalled()
    expect(markPublished).not.toHaveBeenCalled()
    expect(recordFailure).not.toHaveBeenCalled()
    expect(rows.get("m1")).toMatchObject({ state: "claimed" })
  })

  it("does not run or commit the handler when aborted while claiming an inbox message", async () => {
    const controller = new AbortController()
    const rows = new Map<string, InboxRecord>()
    const id = (key: InboxKey): string => `${key.consumerKey}:${key.messageId}`
    let acknowledged = 0
    const inbox: InboxPort = {
      observe: async (record) => { const next = observeInboxRecord(rows.get(id(record)) ?? null, record, t0); rows.set(id(record), next); return next },
      get: async (key) => rows.get(id(key)) ?? null,
      claim: async (key, owner, leaseMs) => { const next = claimInboxRecord(rows.get(id(key))!, { owner, token: "c1", leaseMs, now: t0 })!; rows.set(id(key), next); controller.abort(new Error("shutdown")); return next },
      renew: async () => { throw new Error("unused") },
      acknowledge: async <T>(key: InboxKey, token: string, mutation: (transaction?: unknown) => Promise<T>) => { acknowledged++; const next = acknowledgeInboxRecord(rows.get(id(key))!, token, t0); const result = await mutation("tx"); rows.set(id(key), next); return { record: next, result } },
      scheduleRetry: vi.fn(async (key: InboxKey, token: string, code: string, delayMs: number, maxAttempts: number) => scheduleInboxRetry(rows.get(id(key))!, { token, code, delayMs, maxAttempts, now: t0 })),
      deadLetter: vi.fn(async (key: InboxKey, token: string, code: string) => deadLetterInboxRecord(rows.get(id(key))!, { token, code, now: t0 })),
      replay: async () => { throw new Error("unused") },
    }
    const handle = vi.fn(async () => "done")
    const result = await consumeInboxMessage({ inbox, envelope, consumer, owner: "w", leaseMs: 1000, handle, now: () => t0, signal: controller.signal })
    expect(result.outcome).toBe("cancelled")
    expect(handle).not.toHaveBeenCalled()
    expect(acknowledged).toBe(0)
    expect(inbox.scheduleRetry).not.toHaveBeenCalled()
    expect(inbox.deadLetter).not.toHaveBeenCalled()
  })
})

describe("outbox append payload comparison without canonical JSON", () => {
  it("treats the same payload with reordered keys and an unsafe integer as equal", () => {
    const first = outbox({ a: 1, big: 2 ** 60 })
    expect(appendOutboxDelivery(first, outbox({ big: 2 ** 60, a: 1 }))).toBe(first)
    expect(appendOutboxDelivery(first, outbox({ nested: undefined, big: 2 ** 60, a: 1 }))).toBe(first)
  })

  it("still detects a different payload with an unsafe integer", () => {
    const first = outbox({ a: 1, big: 2 ** 60 })
    expect(() => appendOutboxDelivery(first, outbox({ a: 2, big: 2 ** 60 }))).toThrow(ConflictError)
    expect(() => appendOutboxDelivery(first, outbox({ a: 1, big: 2 ** 61 }))).toThrow(ConflictError)
    expect(() => appendOutboxDelivery(outbox({ list: [1, 2 ** 60] }), outbox({ list: [2 ** 60, 1] }))).toThrow(ConflictError)
    expect(() => appendOutboxDelivery(outbox({ v: "1", big: 2 ** 60 }), outbox({ v: 1, big: 2 ** 60 }))).toThrow(ConflictError)
  })
})
