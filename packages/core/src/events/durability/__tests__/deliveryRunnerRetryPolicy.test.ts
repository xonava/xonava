import { describe, expect, it, vi } from "vitest"
import { acknowledgeInboxRecord, claimInboxRecord, claimOutboxDelivery, deadLetterInboxRecord, markOutboxDeliveryPublished, MAX_DELIVERY_RETRY_DELAY_MS, observeInboxRecord, recordOutboxDeliveryFailure, scheduleInboxRetry } from "../delivery"
import { consumeInboxMessage, deliverOutboxMessage } from "../deliveryRunner"
import type { InboxKey, InboxPort, InboxRecord } from "../inbox"
import type { OutboxDeliveryKey, OutboxDeliveryRecord, OutboxStore } from "../outboxStore"
import { defineConsumer, type ConsumerDefinition } from "../../consumerDefinition"
import { ConflictError, OptimisticConcurrencyError, TransactionRolledBackError, ValidationError } from "../../../domain/errors"
import { computeBackoffDelayMs, DEFAULT_BACKOFF_POLICY } from "../../../resilience/backoff"
import type { EventEnvelope } from "../../eventEnvelope"

const t0 = new Date("2026-10-01T00:00:00.000Z")
const scopeId = "fscope:v1:test" as never
const provenance = { format: "framework.authority-provenance", formatVersion: 1, correlationId: "corr-1" } as never
const envelope = { format: "framework.event", formatVersion: 1, messageId: "m1", eventType: "order.placed", payloadVersion: 1, occurredAt: t0.toISOString(), scope: { kind: "tenant", tenantId: "t1" }, scopeId, correlationId: "corr-1", producer: { service: "orders" }, provenance, payload: { id: "o1" } } as unknown as EventEnvelope

function consumerWith(delayMs: (attempt: number) => number): ConsumerDefinition {
  return defineConsumer({ key: "ledger", definitionVersion: 1, eventType: "order.placed", acceptedPayloadVersions: [1], authority: "event-provenance", retry: { maxAttempts: 3, delayMs }, transaction: { mode: "required" } })
}

function inboxPort(): InboxPort & { scheduleRetry: ReturnType<typeof vi.fn>; deadLetter: ReturnType<typeof vi.fn> } {
  const rows = new Map<string, InboxRecord>()
  const id = (key: InboxKey): string => `${key.consumerKey}:${key.messageId}`
  return {
    observe: async (record) => { const next = observeInboxRecord(rows.get(id(record)) ?? null, record, t0); rows.set(id(record), next); return next },
    get: async (key) => rows.get(id(key)) ?? null,
    claim: async (key, owner, leaseMs) => { const next = claimInboxRecord(rows.get(id(key))!, { owner, token: "c1", leaseMs, now: t0 })!; rows.set(id(key), next); return next },
    renew: async () => { throw new Error("unused") },
    acknowledge: async <T>(key: InboxKey, token: string, mutation: (transaction?: unknown) => Promise<T>) => { const next = acknowledgeInboxRecord(rows.get(id(key))!, token, t0); const result = await mutation("tx"); rows.set(id(key), next); return { record: next, result } },
    scheduleRetry: vi.fn(async (key: InboxKey, token: string, code: string, delayMs: number, maxAttempts: number) => scheduleInboxRetry(rows.get(id(key))!, { token, code, delayMs, maxAttempts, now: t0 })),
    deadLetter: vi.fn(async (key: InboxKey, token: string, code: string) => deadLetterInboxRecord(rows.get(id(key))!, { token, code, now: t0 })),
    replay: async () => { throw new Error("unused") },
  }
}

async function consumeFailing(error: unknown, delayMs: (attempt: number) => number = () => 100, random?: () => number) {
  const inbox = inboxPort()
  const result = await consumeInboxMessage({ inbox, envelope, consumer: consumerWith(delayMs), owner: "w", leaseMs: 1000, handle: async () => { throw error }, now: () => t0, ...(random ? { random } : {}) })
  return { result, inbox }
}

describe("delivery runner failure classification", () => {
  it("retries a consumer optimistic-concurrency conflict instead of dead-lettering it", async () => {
    const { result, inbox } = await consumeFailing(new OptimisticConcurrencyError())
    expect(result.outcome).toBe("retry_scheduled")
    expect(inbox.deadLetter).not.toHaveBeenCalled()
    expect(inbox.scheduleRetry).toHaveBeenCalledWith(expect.anything(), "c1", "OPTIMISTIC_CONCURRENCY_FAILED", 100, 3)
  })

  it("retries a rolled-back transaction and still dead-letters permanent failures", async () => {
    expect((await consumeFailing(new TransactionRolledBackError())).result.outcome).toBe("retry_scheduled")
    expect((await consumeFailing(new ValidationError("bad"))).result.outcome).toBe("dead_lettered")
    // A generic conflict (e.g. a unique-key violation) is deterministic and stays permanent.
    expect((await consumeFailing(new ConflictError())).result.outcome).toBe("dead_lettered")
  })

  it("retries an optimistic-concurrency failure raised while publishing an outbox message", async () => {
    const rows = new Map<string, OutboxDeliveryRecord>([["m1", { envelope, scopeId, idempotencyKey: "k1", state: "pending", attempt: 0, claim: null }]])
    const store: OutboxStore = {
      append: async (record) => record,
      get: async (key) => rows.get(key.messageId) ?? null,
      claim: async (key, owner, leaseMs) => { const next = claimOutboxDelivery(rows.get(key.messageId)!, { owner, token: "t1", leaseMs, now: t0 })!; rows.set(key.messageId, next); return next },
      markPublished: async (key: OutboxDeliveryKey, token: string) => markOutboxDeliveryPublished(rows.get(key.messageId)!, token, t0),
      recordFailure: async (key, token, code, delayMs, maxAttempts) => recordOutboxDeliveryFailure(rows.get(key.messageId)!, { token, code, delayMs, maxAttempts, now: t0 }),
    }
    const result = await deliverOutboxMessage({ store, publisher: { publish: async () => { throw new OptimisticConcurrencyError() } }, key: { messageId: "m1", scopeId }, owner: "r", leaseMs: 1000, random: () => 0 })
    expect(result.outcome).toBe("retry_scheduled")
  })
})

describe("consumer retry delay normalization", () => {
  const scheduledDelay = async (delayMs: (attempt: number) => number, random?: () => number): Promise<unknown> => {
    const { inbox } = await consumeFailing(new Error("boom"), delayMs, random)
    return inbox.scheduleRetry.mock.calls[0]![3]
  }

  it("rounds a fractional delay up instead of retrying immediately", async () => {
    expect(await scheduledDelay(() => 1.5 ** 3)).toBe(4)
    expect(await scheduledDelay(() => 250.2)).toBe(251)
  })

  it("clamps an unbounded delay to the maximum delivery retry delay", async () => {
    expect(await scheduledDelay(() => Number.POSITIVE_INFINITY)).toBe(MAX_DELIVERY_RETRY_DELAY_MS)
    expect(await scheduledDelay(() => MAX_DELIVERY_RETRY_DELAY_MS * 10)).toBe(MAX_DELIVERY_RETRY_DELAY_MS)
  })

  it("falls back to the default backoff for NaN, negative, non-numeric or throwing delay functions", async () => {
    const expected = computeBackoffDelayMs(DEFAULT_BACKOFF_POLICY, 1, () => 0.5)
    expect(expected).toBeGreaterThan(0)
    expect(await scheduledDelay(() => Number.NaN, () => 0.5)).toBe(expected)
    expect(await scheduledDelay(() => -5, () => 0.5)).toBe(expected)
    expect(await scheduledDelay(() => "10" as unknown as number, () => 0.5)).toBe(expected)
    expect(await scheduledDelay(() => { throw new Error("bad policy") }, () => 0.5)).toBe(expected)
  })

  it("keeps a valid integer delay unchanged", async () => {
    expect(await scheduledDelay(() => 0)).toBe(0)
    expect(await scheduledDelay(() => 1234)).toBe(1234)
  })
})
