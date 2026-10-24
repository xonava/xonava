import { afterEach, describe, expect, it, vi } from "vitest"
import { deliverOutboxMessage, consumeInboxMessage, createInboxRecord } from "../deliveryRunner"
import type { InboxKey, InboxPort, InboxRecord } from "../inbox"
import type { OutboxDeliveryKey, OutboxDeliveryRecord, OutboxStore } from "../outboxStore"
import { defineConsumer } from "../../consumerDefinition"
import { ConfigurationError, StaleClaimError, TimeoutError } from "../../../domain/errors"
import type { BackoffPolicy } from "../../../resilience/backoff"
import type { EventEnvelope } from "../../eventEnvelope"

const t0 = new Date("2026-10-01T00:00:00.000Z")
const scopeId = "fscope:v1:test" as never
const provenance = { format: "framework.authority-provenance", formatVersion: 1, correlationId: "corr-1" } as never
const envelope = { format: "framework.event", formatVersion: 1, messageId: "m1", eventType: "order.placed", payloadVersion: 1, occurredAt: t0.toISOString(), scope: { kind: "tenant", tenantId: "t1" }, scopeId, correlationId: "corr-1", producer: { service: "orders" }, provenance, payload: { id: "o1" } } as unknown as EventEnvelope
const claim = { token: "tok", owner: "w", claimedAt: t0.toISOString(), leaseExpiresAt: new Date(t0.getTime() + 1000).toISOString() }
const key: OutboxDeliveryKey = { messageId: "m1", scopeId }
const policy: BackoffPolicy = { maxAttempts: 5, initialDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 60_000, jitter: "none" }

const claimedOutbox = (attempt = 1, state: OutboxDeliveryRecord["state"] = "claimed"): OutboxDeliveryRecord => ({ envelope, scopeId, idempotencyKey: "k1", state, attempt, claim })

interface Overrides { claim?: OutboxStore["claim"]; markPublished?: OutboxStore["markPublished"]; recordFailure?: OutboxStore["recordFailure"] }
function outboxStore(attempt = 1, overrides: Overrides = {}) {
  const row = claimedOutbox(attempt)
  const recordFailure = vi.fn(overrides.recordFailure ?? (async () => ({ ...row, state: "retry_scheduled" as const, claim: null })))
  const markPublished = vi.fn(overrides.markPublished ?? (async () => ({ ...row, state: "published" as const, claim: null })))
  const store: OutboxStore = { append: async (record) => record, get: async () => row, claim: overrides.claim ?? (async () => row), markPublished, recordFailure }
  return { store, row, recordFailure, markPublished }
}
const never = (): Promise<void> => new Promise<void>(() => undefined)

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe("outbox failure classification", () => {
  const failWith = async (thrown: unknown, attempt = 1) => {
    const { store, recordFailure } = outboxStore(attempt)
    const result = await deliverOutboxMessage({ store, publisher: { publish: async () => { throw thrown } }, key, owner: "r", leaseMs: 1000, retry: policy })
    return { result, call: recordFailure.mock.calls[0] }
  }

  it("records DELIVERY_FAILED for a thrown null", async () => {
    const { result, call } = await failWith(null)
    expect(result.outcome).toBe("retry_scheduled")
    expect(call).toEqual([key, "tok", "DELIVERY_FAILED", 1000, 5])
  })

  it("ignores a code carried by a thrown function", async () => {
    const thrown = Object.assign(() => undefined, { code: "FN_CODE" })
    expect((await failWith(thrown)).call?.[2]).toBe("DELIVERY_FAILED")
  })

  it("uses a string code of an object, the name of an Error, and falls back otherwise", async () => {
    expect((await failWith({ code: "ABC_1" })).call?.[2]).toBe("ABC_1")
    expect((await failWith(Object.assign(new Error("x"), { code: 42, name: "CustomName" }))).call?.[2]).toBe("CustomName")
    expect((await failWith(new Error("x"))).call?.[2]).toBe("Error")
    expect((await failWith({ name: "NotAnError" })).call?.[2]).toBe("DELIVERY_FAILED")
    expect((await failWith("boom")).call?.[2]).toBe("DELIVERY_FAILED")
  })

  it("schedules backoff for a transient failure and none for exhausted or permanent ones", async () => {
    expect((await failWith(new Error("x"), 1)).call).toEqual([key, "tok", "Error", 1000, 5])
    expect((await failWith(new Error("x"), 2)).call).toEqual([key, "tok", "Error", 2000, 5])
    expect((await failWith(new Error("x"), 5)).call).toEqual([key, "tok", "Error", 0, 5])
    expect((await failWith(new ConfigurationError("bad"), 1)).call).toEqual([key, "tok", "CONFIGURATION_ERROR", 0, 1])
    expect((await failWith(new ConfigurationError("bad"), 3)).call).toEqual([key, "tok", "CONFIGURATION_ERROR", 0, 3])
  })

  it("reports lease_lost when recording the failure meets a stale claim and rethrows other errors", async () => {
    const stale = outboxStore(1, { recordFailure: async () => { throw new StaleClaimError() } })
    const lost = await deliverOutboxMessage({ store: stale.store, publisher: { publish: async () => { throw new Error("x") } }, key, owner: "r", leaseMs: 1000, retry: policy })
    expect(lost).toEqual({ outcome: "lease_lost", record: stale.row })
    const boom = new Error("store down")
    const broken = outboxStore(1, { recordFailure: async () => { throw boom } })
    await expect(deliverOutboxMessage({ store: broken.store, publisher: { publish: async () => { throw new Error("x") } }, key, owner: "r", leaseMs: 1000, retry: policy })).rejects.toBe(boom)
  })

  it("reports lease_lost when marking published meets a stale claim and rethrows other errors", async () => {
    const stale = outboxStore(1, { markPublished: async () => { throw new StaleClaimError() } })
    expect(await deliverOutboxMessage({ store: stale.store, publisher: { publish: async () => undefined }, key, owner: "r", leaseMs: 1000 })).toEqual({ outcome: "lease_lost", record: stale.row })
    const boom = new Error("store down")
    const broken = outboxStore(1, { markPublished: async () => { throw boom } })
    await expect(deliverOutboxMessage({ store: broken.store, publisher: { publish: async () => undefined }, key, owner: "r", leaseMs: 1000 })).rejects.toBe(boom)
  })
})

describe("lease-bounded work timeout", () => {
  const deadlineAt = async (leaseMs: number, publishTimeoutMs: number | undefined, expectedMs: number) => {
    vi.useFakeTimers()
    const { store, recordFailure } = outboxStore(1)
    const pending = deliverOutboxMessage({ store, publisher: { publish: never }, key, owner: "r", leaseMs, ...(publishTimeoutMs !== undefined ? { publishTimeoutMs } : {}), retry: policy })
    await vi.advanceTimersByTimeAsync(expectedMs - 1)
    expect(recordFailure).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(recordFailure).toHaveBeenCalledTimes(1)
    expect(recordFailure.mock.calls[0]?.[2]).toBe(new TimeoutError().code)
    expect((await pending).outcome).toBe("retry_scheduled")
    vi.useRealTimers()
  }

  it("defaults to 80 % of the lease", async () => { await deadlineAt(1000, undefined, 800) })
  it("honours a smaller requested timeout", async () => { await deadlineAt(1000, 100, 100) })
  it("accepts a requested timeout of exactly 1", async () => { await deadlineAt(1000, 1, 1) })
  it("caps a larger requested timeout at 80 % of the lease", async () => { await deadlineAt(1000, 5000, 800) })
  it("accepts the smallest lease of 2 ms with a 1 ms budget", async () => { await deadlineAt(2, undefined, 1) })

  it("rejects an invalid lease", async () => {
    const { store } = outboxStore()
    for (const leaseMs of [1, 0, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(deliverOutboxMessage({ store, publisher: { publish: async () => undefined }, key, owner: "r", leaseMs })).rejects.toThrow("Delivery leaseMs must be an integer of at least 2")
    }
  })

  it("rejects an invalid requested timeout", async () => {
    const { store } = outboxStore()
    for (const publishTimeoutMs of [0, -1, 1.5, Number.NaN]) {
      await expect(deliverOutboxMessage({ store, publisher: { publish: async () => undefined }, key, owner: "r", leaseMs: 1000, publishTimeoutMs })).rejects.toThrow("Delivery work timeout must be a positive integer")
    }
  })
})

describe("withDeadline signal plumbing", () => {
  it("aborts the publisher signal with the parent reason and returns without waiting for the work", async () => {
    vi.useFakeTimers()
    const { store, recordFailure } = outboxStore(1)
    const parent = new AbortController()
    const reason = new Error("shutdown")
    let seen: AbortSignal | undefined
    let settled = false
    const pending = deliverOutboxMessage({ store, publisher: { publish: (_e, signal) => { seen = signal; return never() } }, key, owner: "r", leaseMs: 1000, signal: parent.signal }).then((r) => { settled = true; return r })
    await vi.advanceTimersByTimeAsync(0)
    expect(seen?.aborted).toBe(false)
    parent.abort(reason)
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
    expect(seen?.aborted).toBe(true)
    expect(seen?.reason).toBe(reason)
    expect((await pending).outcome).toBe("cancelled")
    expect(recordFailure).not.toHaveBeenCalled()
  })

  it("aborts the publisher signal with a TimeoutError carrying the deadline message", async () => {
    vi.useFakeTimers()
    const { store } = outboxStore(1)
    let seen: AbortSignal | undefined
    const pending = deliverOutboxMessage({ store, publisher: { publish: (_e, signal) => { seen = signal; return never() } }, key, owner: "r", leaseMs: 1000, retry: policy })
    await vi.advanceTimersByTimeAsync(800)
    await pending
    expect(seen?.aborted).toBe(true)
    expect(seen?.reason).toBeInstanceOf(TimeoutError)
    expect((seen?.reason as TimeoutError).message).toBe("Delivery work deadline exceeded")
  })

  it("registers once-only abort listeners and removes the parent listener and the timer afterwards", async () => {
    vi.useFakeTimers()
    const { store } = outboxStore(1)
    const parent = new AbortController()
    const add = vi.spyOn(EventTarget.prototype, "addEventListener")
    const remove = vi.spyOn(parent.signal, "removeEventListener")
    await deliverOutboxMessage({ store, publisher: { publish: async () => undefined }, key, owner: "r", leaseMs: 1000, signal: parent.signal })
    const aborts = add.mock.calls.filter((call) => call[0] === "abort")
    expect(aborts).toHaveLength(2)
    for (const call of aborts) expect(call[2]).toEqual({ once: true })
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove.mock.calls[0]?.[0]).toBe("abort")
    expect(remove.mock.calls[0]?.[1]).toBe(aborts.find((call) => call[1] !== undefined)?.[1])
    expect(vi.getTimerCount()).toBe(0)
  })

  it("clears the timer after a failed publish too", async () => {
    vi.useFakeTimers()
    const { store } = outboxStore(1)
    await deliverOutboxMessage({ store, publisher: { publish: async () => { throw new Error("x") } }, key, owner: "r", leaseMs: 1000, retry: policy })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("consumeInboxMessage", () => {
  const consumer = defineConsumer({ key: "ledger", definitionVersion: 1, eventType: "order.placed", acceptedPayloadVersions: [1], authority: "event-provenance", retry: { maxAttempts: 3, delayMs: () => 100 }, transaction: { mode: "required" } })
  const inboxKey: InboxKey = { consumerKey: "ledger", messageId: "m1", scopeId }
  const base = createInboxRecord(envelope, consumer, t0)
  const claimedInbox: InboxRecord = { ...base, state: "claimed", attempt: 2, claim }

  interface InboxOverrides { observe?: InboxPort["observe"]; claim?: InboxPort["claim"]; acknowledge?: InboxPort["acknowledge"]; scheduleRetry?: InboxPort["scheduleRetry"]; deadLetter?: InboxPort["deadLetter"] }
  function inboxPort(o: InboxOverrides = {}) {
    const unused = async (): Promise<never> => { throw new Error("unused") }
    const observe = vi.fn(o.observe ?? (async (record: InboxRecord) => record))
    const claimFn = vi.fn(o.claim ?? (async () => claimedInbox))
    const scheduleRetry = vi.fn(o.scheduleRetry ?? (async () => ({ ...claimedInbox, state: "retry_scheduled" as const, claim: null })))
    const deadLetter = vi.fn(o.deadLetter ?? (async () => ({ ...claimedInbox, state: "dead_lettered" as const, claim: null })))
    const acknowledge = vi.fn(o.acknowledge ?? (async <T>(_k: InboxKey, _t: string, mutation: (transaction?: unknown) => Promise<T>) => ({ record: { ...claimedInbox, state: "processed" as const, claim: null }, result: await mutation() })))
    const inbox: InboxPort = { observe, get: unused, claim: claimFn, renew: unused, acknowledge: acknowledge as InboxPort["acknowledge"], scheduleRetry, deadLetter, replay: unused }
    return { inbox, observe, claim: claimFn, scheduleRetry, deadLetter, acknowledge }
  }
  const run = (inbox: InboxPort, extra: Partial<Parameters<typeof consumeInboxMessage>[0]> = {}) =>
    consumeInboxMessage({ inbox, envelope, consumer, owner: "w", leaseMs: 1000, handle: async () => "done", now: () => t0, ...extra })

  it("creates the initial pending record", () => {
    expect(createInboxRecord(envelope, consumer, t0)).toEqual({
      messageId: "m1", consumerKey: "ledger", consumerDefinitionVersion: 1, scopeId, state: "pending", attempt: 0, replayGeneration: 0, claim: null,
      firstObservedAt: t0.toISOString(), lastObservedAt: t0.toISOString(), eventFormatVersion: 1, eventPayloadVersion: 1, originalProvenance: provenance,
      replay: { kind: "original-delivery" }, history: [],
    })
  })

  it("rejects an envelope of another event type with the exact message", async () => {
    const { inbox } = inboxPort()
    await expect(run(inbox, { envelope: { ...envelope, eventType: "order.shipped" } as EventEnvelope })).rejects.toThrow("Consumer ledger does not handle order.shipped")
  })

  it("returns cancelled without touching the inbox when already aborted", async () => {
    const { inbox, observe } = inboxPort()
    const controller = new AbortController()
    controller.abort()
    expect(await run(inbox, { signal: controller.signal })).toEqual({ outcome: "cancelled", record: null })
    expect(observe).not.toHaveBeenCalled()
  })

  it("returns already_processed with the observed record", async () => {
    const processed: InboxRecord = { ...base, state: "processed" }
    const { inbox, claim: claimFn } = inboxPort({ observe: async () => processed })
    expect(await run(inbox)).toEqual({ outcome: "already_processed", record: processed })
    expect(claimFn).not.toHaveBeenCalled()
  })

  it("forwards the consumer attempt budget to the claim", async () => {
    const { inbox, claim: claimFn } = inboxPort()
    await run(inbox)
    expect(claimFn).toHaveBeenCalledWith(inboxKey, "w", 1000, 3)
  })

  it("returns dead_lettered when the claim dead-letters an exhausted record", async () => {
    const dead: InboxRecord = { ...base, state: "dead_lettered", attempt: 3 }
    const { inbox, acknowledge } = inboxPort({ claim: async () => dead })
    expect(await run(inbox)).toEqual({ outcome: "dead_lettered", record: dead })
    expect(acknowledge).not.toHaveBeenCalled()
  })

  it("returns not_claimable for a missing record or one without a claim", async () => {
    expect(await run(inboxPort({ claim: async () => null }).inbox)).toEqual({ outcome: "not_claimable", record: null })
    expect(await run(inboxPort({ claim: async () => base }).inbox)).toEqual({ outcome: "not_claimable", record: base })
  })

  it("passes the transaction to the handler only when the store provides one", async () => {
    const seen: Array<Record<string, unknown>> = []
    const handle = async (context: Record<string, unknown>): Promise<string> => { seen.push(context); return "ok" }
    const withTx = inboxPort({ acknowledge: async <T>(_k: InboxKey, _t: string, mutation: (transaction?: unknown) => Promise<T>) => ({ record: claimedInbox, result: await mutation("tx-1") }) })
    expect((await run(withTx.inbox, { handle })).result).toBe("ok")
    const withoutTx = inboxPort({ acknowledge: async <T>(_k: InboxKey, _t: string, mutation: (transaction?: unknown) => Promise<T>) => ({ record: claimedInbox, result: await mutation(undefined) }) })
    await run(withoutTx.inbox, { handle })
    expect(seen[0]).toMatchObject({ envelope, transaction: "tx-1", attempt: 2 })
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(seen[1] !== undefined && "transaction" in seen[1]).toBe(false)
    expect(seen[1]).toMatchObject({ envelope, attempt: 2 })
  })

  it("reports lease_lost when the acknowledgement meets a stale claim", async () => {
    const { inbox, scheduleRetry, deadLetter } = inboxPort({ acknowledge: async () => { throw new StaleClaimError() } })
    expect(await run(inbox)).toEqual({ outcome: "lease_lost", record: claimedInbox })
    expect(scheduleRetry).not.toHaveBeenCalled()
    expect(deadLetter).not.toHaveBeenCalled()
  })

  it("schedules a retry with the consumer delay for a transient handler failure", async () => {
    const { inbox, scheduleRetry } = inboxPort({ acknowledge: async () => { throw Object.assign(new Error("x"), { code: "DOWNSTREAM_DOWN" }) } })
    const result = await run(inbox)
    expect(result.outcome).toBe("retry_scheduled")
    expect(scheduleRetry).toHaveBeenCalledWith(inboxKey, "tok", "DOWNSTREAM_DOWN", 100, 3)
  })

  it("dead-letters a permanent handler failure", async () => {
    const { inbox, deadLetter, scheduleRetry } = inboxPort({ acknowledge: async () => { throw new ConfigurationError("bad") } })
    const result = await run(inbox)
    expect(result.outcome).toBe("dead_lettered")
    expect(deadLetter).toHaveBeenCalledWith(inboxKey, "tok", "CONFIGURATION_ERROR")
    expect(scheduleRetry).not.toHaveBeenCalled()
  })

  it("backs off an unsupported payload version without running the handler", async () => {
    const handle = vi.fn(async () => "x")
    const { inbox, scheduleRetry, acknowledge } = inboxPort()
    const result = await run(inbox, { envelope: { ...envelope, payloadVersion: 9 } as EventEnvelope, handle })
    expect(result.outcome).toBe("retry_scheduled")
    expect(scheduleRetry).toHaveBeenCalledWith(inboxKey, "tok", "UNSUPPORTED_PAYLOAD_VERSION", 100, 3)
    expect(handle).not.toHaveBeenCalled()
    expect(acknowledge).not.toHaveBeenCalled()
  })

  it("reports lease_lost when the failure transition meets a stale claim and rethrows other errors", async () => {
    const failing = async (): Promise<never> => { throw new Error("x") }
    const stale = inboxPort({ acknowledge: failing, scheduleRetry: async () => { throw new StaleClaimError() } })
    expect(await run(stale.inbox)).toEqual({ outcome: "lease_lost", record: claimedInbox })
    const staleDead = inboxPort({ acknowledge: async () => { throw new ConfigurationError("bad") }, deadLetter: async () => { throw new StaleClaimError() } })
    expect(await run(staleDead.inbox)).toEqual({ outcome: "lease_lost", record: claimedInbox })
    const boom = new Error("store down")
    const broken = inboxPort({ acknowledge: failing, scheduleRetry: async () => { throw boom } })
    await expect(run(broken.inbox)).rejects.toBe(boom)
  })
})
