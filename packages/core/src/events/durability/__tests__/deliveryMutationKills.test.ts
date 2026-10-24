import { describe, expect, it } from "vitest"
import {
  acknowledgeInboxRecord, appendOutboxDelivery, assertDeliveryClaimAlive, claimInboxRecord, claimOutboxDelivery, deadLetterInboxRecord, isDeliveryClaimable,
  markOutboxDeliveryPublished, MAX_DELIVERY_LEASE_MS, MAX_DELIVERY_RETRY_DELAY_MS, observeInboxRecord, recordOutboxDeliveryFailure, renewInboxClaim,
  replayInboxRecord, scheduleInboxRetry,
} from "../delivery"
import { createInboxRecord } from "../deliveryRunner"
import type { InboxRecord } from "../inbox"
import type { OutboxDeliveryRecord } from "../outboxStore"
import { defineConsumer } from "../../consumerDefinition"
import { ConfigurationError, ConflictError, StaleClaimError } from "../../../domain/errors"
import type { EventEnvelope } from "../../eventEnvelope"

const t0 = new Date("2026-10-01T00:00:00.000Z")
const at = (offsetMs: number): Date => new Date(t0.getTime() + offsetMs)
const scopeId = "fscope:v1:test" as never
const provenance = { format: "framework.authority-provenance", formatVersion: 1, correlationId: "corr-1" } as never
const envelope = { format: "framework.event", formatVersion: 1, messageId: "m1", eventType: "order.placed", payloadVersion: 1, occurredAt: t0.toISOString(), scope: { kind: "tenant", tenantId: "t1" }, scopeId, correlationId: "corr-1", producer: { service: "orders" }, provenance, payload: { id: "o1" } } as unknown as EventEnvelope
const consumer = defineConsumer({ key: "ledger", definitionVersion: 1, eventType: "order.placed", acceptedPayloadVersions: [1], authority: "event-provenance", retry: { maxAttempts: 3, delayMs: () => 100 }, transaction: { mode: "required" } })
const claim = (expiresInMs: number, token = "tok") => ({ token, owner: "w", claimedAt: t0.toISOString(), leaseExpiresAt: at(expiresInMs).toISOString() })

const outbox = (extra: Partial<OutboxDeliveryRecord> = {}, payload: unknown = envelope.payload): OutboxDeliveryRecord => ({ envelope: { ...envelope, payload } as EventEnvelope, scopeId, idempotencyKey: "k1", state: "pending", attempt: 0, claim: null, ...extra })
const claimedOutbox = (attempt = 1, expiresInMs = 1000): OutboxDeliveryRecord => outbox({ state: "claimed", attempt, claim: claim(expiresInMs) })
const inbox = (extra: Partial<InboxRecord> = {}): InboxRecord => ({ ...createInboxRecord(envelope, consumer, t0), ...extra })
const claimedInbox = (attempt = 1, expiresInMs = 1000): InboxRecord => inbox({ state: "claimed", attempt, claim: claim(expiresInMs) })
const args = (leaseMs = 1000) => ({ owner: "o", token: "t", leaseMs, now: t0 })
const messageOf = (run: () => unknown): string => { try { run() } catch (error) { return (error as Error).message } return "did not throw" }

describe("delivery argument validation", () => {
  it("requires a valid transition time", () => {
    for (const now of [new Date(Number.NaN), "2026-10-01" as never, undefined as never]) {
      expect(messageOf(() => claimOutboxDelivery(outbox(), { ...args(), now }))).toBe("Delivery transition requires a valid time")
    }
  })

  it("bounds the lease inclusively at both ends", () => {
    const message = `Delivery lease must be an integer from 1 to ${MAX_DELIVERY_LEASE_MS} ms`
    for (const leaseMs of [0, -1, 1.5, Number.NaN, MAX_DELIVERY_LEASE_MS + 1]) expect(messageOf(() => claimOutboxDelivery(outbox(), args(leaseMs)))).toBe(message)
    expect(claimOutboxDelivery(outbox(), args(1))?.claim?.leaseExpiresAt).toBe(at(1).toISOString())
    expect(claimOutboxDelivery(outbox(), args(MAX_DELIVERY_LEASE_MS))?.claim?.leaseExpiresAt).toBe(at(MAX_DELIVERY_LEASE_MS).toISOString())
    expect(messageOf(() => renewInboxClaim(claimedInbox(), { token: "tok", leaseMs: 0, now: t0 }))).toBe(message)
  })

  it("bounds the retry delay inclusively at both ends", () => {
    const message = `Delivery retry delay must be an integer from 0 to ${MAX_DELIVERY_RETRY_DELAY_MS} ms`
    const failure = (delayMs: number) => recordOutboxDeliveryFailure(claimedOutbox(), { token: "tok", code: "X", delayMs, maxAttempts: 5, now: t0 })
    for (const delayMs of [-1, 1.5, Number.NaN, MAX_DELIVERY_RETRY_DELAY_MS + 1]) expect(messageOf(() => failure(delayMs))).toBe(message)
    expect(failure(0).nextAttemptAt).toBe(t0.toISOString())
    expect(failure(MAX_DELIVERY_RETRY_DELAY_MS).nextAttemptAt).toBe(at(MAX_DELIVERY_RETRY_DELAY_MS).toISOString())
  })

  it("requires a positive integer attempt limit", () => {
    for (const maxAttempts of [0, -1, 1.5, Number.NaN]) {
      expect(messageOf(() => recordOutboxDeliveryFailure(claimedOutbox(), { token: "tok", code: "X", delayMs: 0, maxAttempts, now: t0 }))).toBe("Delivery maxAttempts must be a positive integer")
    }
    expect(recordOutboxDeliveryFailure(claimedOutbox(1), { token: "tok", code: "X", delayMs: 0, maxAttempts: 1, now: t0 }).state).toBe("dead_lettered")
  })

  it("bounds the claim token to 1 to 256 characters", () => {
    const message = "Delivery claim token must be 1 to 256 characters"
    for (const token of ["", "t".repeat(257), 5 as never]) expect(messageOf(() => claimOutboxDelivery(outbox(), { ...args(), token }))).toBe(message)
    expect(claimOutboxDelivery(outbox(), { ...args(), token: "t" })?.claim?.token).toBe("t")
    expect(claimOutboxDelivery(outbox(), { ...args(), token: "t".repeat(256) })?.claim?.token).toHaveLength(256)
  })

  it("bounds the claim owner to 1 to 256 characters and rejects blank owners", () => {
    const message = "Delivery claim owner must be 1 to 256 characters"
    for (const owner of ["", "   ", "o".repeat(257), 5 as never]) expect(messageOf(() => claimOutboxDelivery(outbox(), { ...args(), owner }))).toBe(message)
    expect(claimOutboxDelivery(outbox(), { ...args(), owner: "o".repeat(256) })?.claim?.owner).toHaveLength(256)
    expect(claimOutboxDelivery(outbox(), { ...args(), owner: " a " })?.claim?.owner).toBe(" a ")
  })
})

describe("claimability and claim liveness", () => {
  it("claims pending records and due retries only", () => {
    expect(isDeliveryClaimable({ state: "pending", claim: null }, t0)).toBe(true)
    expect(isDeliveryClaimable({ state: "retry_scheduled", claim: null }, t0)).toBe(true)
    expect(isDeliveryClaimable({ state: "retry_scheduled", claim: null, nextAttemptAt: at(10).toISOString() }, at(10))).toBe(true)
    expect(isDeliveryClaimable({ state: "retry_scheduled", claim: null, nextAttemptAt: at(10).toISOString() }, at(9))).toBe(false)
    for (const state of ["published", "dead_lettered", "processed"]) expect(isDeliveryClaimable({ state, claim: null }, at(1_000_000))).toBe(false)
  })

  it("reclaims an expired claim at exactly its expiry and not before", () => {
    const record = { state: "claimed", claim: { leaseExpiresAt: at(10).toISOString() } }
    expect(isDeliveryClaimable(record, at(9))).toBe(false)
    expect(isDeliveryClaimable(record, at(10))).toBe(true)
    expect(isDeliveryClaimable({ state: "claimed", claim: null }, at(1_000_000))).toBe(false)
    expect(isDeliveryClaimable({ state: "published", claim: { leaseExpiresAt: at(0).toISOString() } }, at(1_000_000))).toBe(false)
  })

  it("accepts only the live claim token of a claimed record", () => {
    const live = { state: "claimed", claim: { token: "tok", leaseExpiresAt: at(10).toISOString() } }
    expect(() => assertDeliveryClaimAlive(live, "tok", at(9))).not.toThrow()
    expect(() => assertDeliveryClaimAlive(live, "tok", at(10))).toThrow(StaleClaimError)
    expect(() => assertDeliveryClaimAlive(live, "other", at(1))).toThrow(StaleClaimError)
    expect(() => assertDeliveryClaimAlive({ state: "claimed", claim: null }, "tok", at(1))).toThrow(StaleClaimError)
    expect(() => assertDeliveryClaimAlive({ state: "retry_scheduled", claim: live.claim }, "tok", at(1))).toThrow(StaleClaimError)
    expect(() => assertDeliveryClaimAlive({ state: "published", claim: live.claim }, "tok", at(1))).toThrow(StaleClaimError)
  })

  it("fences every transition behind a live claim", () => {
    const stale = { ...claimedOutbox(1, 10) }
    expect(() => markOutboxDeliveryPublished(stale, "tok", at(10))).toThrow(StaleClaimError)
    expect(() => markOutboxDeliveryPublished(stale, "bad", at(1))).toThrow(StaleClaimError)
    expect(() => recordOutboxDeliveryFailure(stale, { token: "bad", code: "X", delayMs: 0, maxAttempts: 5, now: at(1) })).toThrow(StaleClaimError)
    expect(() => recordOutboxDeliveryFailure(stale, { token: "tok", code: "X", delayMs: 0, maxAttempts: 5, now: at(10) })).toThrow(StaleClaimError)
    const inboxStale = claimedInbox(1, 10)
    expect(() => renewInboxClaim(inboxStale, { token: "bad", leaseMs: 5, now: at(1) })).toThrow(StaleClaimError)
    expect(() => acknowledgeInboxRecord(inboxStale, "bad", at(1))).toThrow(StaleClaimError)
    expect(() => scheduleInboxRetry(inboxStale, { token: "bad", code: "X", delayMs: 0, maxAttempts: 5, now: at(1) })).toThrow(StaleClaimError)
    expect(() => deadLetterInboxRecord(inboxStale, { token: "bad", code: "X", now: at(1) })).toThrow(StaleClaimError)
    expect(() => deadLetterInboxRecord(inboxStale, { token: "tok", code: "X", now: at(10) })).toThrow(StaleClaimError)
  })
})

describe("attempt budget at claim time", () => {
  it("dead-letters an exhausted pending outbox record with ATTEMPTS_EXHAUSTED", () => {
    const result = claimOutboxDelivery(outbox({ attempt: 3 }), { ...args(), maxAttempts: 3 })
    expect(result).toMatchObject({ state: "dead_lettered", claim: null, attempt: 3, lastFailure: { code: "ATTEMPTS_EXHAUSTED", occurredAt: t0.toISOString() } })
  })

  it("dead-letters an exhausted record whose last claim lapsed with LEASE_EXPIRED", () => {
    const result = claimOutboxDelivery(claimedOutbox(3, 0), { ...args(), maxAttempts: 3 })
    expect(result).toMatchObject({ state: "dead_lettered", claim: null, lastFailure: { code: "LEASE_EXPIRED" } })
    const inboxResult = claimInboxRecord(claimedInbox(3, 0), { ...args(), maxAttempts: 3 })
    expect(inboxResult).toMatchObject({ state: "dead_lettered", claim: null, lastFailure: { code: "LEASE_EXPIRED", retryable: false } })
  })

  it("claims with the next attempt while budget remains or no budget is given", () => {
    expect(claimOutboxDelivery(outbox({ attempt: 2 }), { ...args(), maxAttempts: 3 })).toMatchObject({ state: "claimed", attempt: 3 })
    expect(claimOutboxDelivery(outbox({ attempt: 50 }), args())).toMatchObject({ state: "claimed", attempt: 51 })
    expect(claimInboxRecord(inbox({ attempt: 3 }), { ...args(), maxAttempts: 3 })).toMatchObject({ state: "dead_lettered", lastFailure: { code: "ATTEMPTS_EXHAUSTED" } })
  })

  it("validates the attempt budget when it is given", () => {
    expect(messageOf(() => claimOutboxDelivery(outbox(), { ...args(), maxAttempts: 0 }))).toBe("Delivery maxAttempts must be a positive integer")
  })
})

describe("outbox append", () => {
  const message = "New outbox deliveries must be pending, unclaimed, and unattempted"

  it("rejects a record that is not new, on each of the three conditions", () => {
    expect(messageOf(() => appendOutboxDelivery(null, outbox({ state: "claimed" })))).toBe(message)
    expect(messageOf(() => appendOutboxDelivery(null, outbox({ attempt: 1 })))).toBe(message)
    expect(messageOf(() => appendOutboxDelivery(null, outbox({ claim: claim(1000) })))).toBe(message)
    const fresh = outbox()
    expect(appendOutboxDelivery(null, fresh)).toBe(fresh)
  })

  it("rejects a non-new record even when a current one exists", () => {
    expect(() => appendOutboxDelivery(outbox(), outbox({ attempt: 1 }))).toThrow(ConfigurationError)
  })

  it("reports a different idempotency key and a different payload with exact messages", () => {
    expect(messageOf(() => appendOutboxDelivery(outbox(), outbox({ idempotencyKey: "k2" })))).toBe("Outbox message id reused with a different idempotency key")
    expect(messageOf(() => appendOutboxDelivery(outbox(), outbox({}, { id: "o2" })))).toBe("Outbox message id reused with a different payload")
    const current = outbox()
    expect(appendOutboxDelivery(current, outbox())).toBe(current)
  })

  it("distinguishes payloads that differ only in a string next to an unsafe integer", () => {
    expect(() => appendOutboxDelivery(outbox({}, { big: 2 ** 60, s: "a" }), outbox({}, { big: 2 ** 60, s: "b" }))).toThrow(ConflictError)
    expect(() => appendOutboxDelivery(outbox({}, { big: 2 ** 60, s: [true, null] }), outbox({}, { big: 2 ** 60, s: [false, null] }))).toThrow(ConflictError)
    const current = outbox({}, { big: 2 ** 60, s: "a", list: [1, { z: 1, y: 2 }] })
    expect(appendOutboxDelivery(current, outbox({}, { list: [1, { y: 2, z: 1 }], s: "a", big: 2 ** 60 }))).toBe(current)
  })

  it("compares records that carry no envelope", () => {
    const bare = (extra: Partial<OutboxDeliveryRecord> = {}): OutboxDeliveryRecord => ({ scopeId, idempotencyKey: "k1", state: "pending", attempt: 0, claim: null, ...extra }) as unknown as OutboxDeliveryRecord
    const current = bare()
    expect(appendOutboxDelivery(current, bare())).toBe(current)
    expect(() => appendOutboxDelivery(current, outbox())).toThrow(ConflictError)
  })
})

describe("inbox observation and replay", () => {
  it("creates a record only from a new pending one and stamps lastObservedAt", () => {
    const message = "New inbox records must be pending, unclaimed, and unattempted"
    expect(messageOf(() => observeInboxRecord(null, inbox({ state: "claimed" }), t0))).toBe(message)
    expect(messageOf(() => observeInboxRecord(null, inbox({ attempt: 1 }), t0))).toBe(message)
    expect(messageOf(() => observeInboxRecord(null, inbox({ claim: claim(1000) }), t0))).toBe(message)
    expect(observeInboxRecord(null, inbox(), at(5))).toEqual({ ...inbox(), lastObservedAt: at(5).toISOString() })
    const existing = inbox({ attempt: 2, state: "retry_scheduled" })
    expect(observeInboxRecord(existing, inbox(), at(5))).toBe(existing)
  })

  const deadLettered = (): InboxRecord => deadLetterInboxRecord(claimedInbox(2), { token: "tok", code: "BOOM", now: at(1) })
  const requestedBy = { format: "framework.authority-provenance", formatVersion: 1, correlationId: "op" } as never

  it("replays only dead-lettered deliveries under a new generation and keeps history", () => {
    const dead = deadLettered()
    const replayed = replayInboxRecord(dead, { requestedBy, reason: "fixed downstream", now: at(2) })
    expect(replayed.state).toBe("pending")
    expect(replayed.attempt).toBe(0)
    expect(replayed.claim).toBeNull()
    expect(replayed.replayGeneration).toBe(1)
    expect(replayed.replay).toEqual({ kind: "replayed", replayGeneration: 1, requestedAt: at(2).toISOString(), requestedBy, reason: "fixed downstream" })
    expect(replayed.lastObservedAt).toBe(at(2).toISOString())
    expect(replayed.history).toEqual(dead.history)
    expect("nextAttemptAt" in replayed).toBe(false)
    expect(replayInboxRecord({ ...dead, replayGeneration: 4 }, { requestedBy, reason: "again", now: at(3) }).replayGeneration).toBe(5)
    expect(messageOf(() => replayInboxRecord(inbox(), { requestedBy, reason: "x", now: at(2) }))).toBe("Only dead-lettered delivery may be replayed")
  })

  it("requires a reason of 1 to 1024 characters", () => {
    const message = "Replay requires a reason of 1 to 1024 characters"
    for (const reason of ["", "   ", "r".repeat(1025), 5 as never]) expect(messageOf(() => replayInboxRecord(deadLettered(), { requestedBy, reason, now: at(2) }))).toBe(message)
    expect(replayInboxRecord(deadLettered(), { requestedBy, reason: "r".repeat(1024), now: at(2) }).state).toBe("pending")
    expect(replayInboxRecord(deadLettered(), { requestedBy, reason: "r", now: at(2) }).state).toBe("pending")
  })
})
