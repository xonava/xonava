import { ConfigurationError, ConflictError, StaleClaimError } from "../../domain/errors"
import type { DurableAuthorityProvenanceV1 } from "../../domain"
import type { InboxClaim, InboxFailure, InboxRecord } from "./inbox"
import type { OutboxDeliveryRecord } from "./outboxStore"

/**
 * Pure, language-neutral delivery state machines for the transactional outbox
 * and the idempotent inbox (docs/spec/events/outbox-inbox.md).
 *
 * Stores persist records and run each transition atomically against the
 * current row (compare-and-set or a row lock); they MUST NOT implement their
 * own transition rules. Every transition takes `now` from the store's
 * authoritative clock so leases are judged against one time source.
 *
 *   outbox:  pending ──claim──▶ claimed ──published──▶ published
 *                 ▲                │
 *                 └─retry_scheduled◀┴─failure──▶ dead_lettered (attempt ≥ max)
 *
 *   inbox:   pending ──claim──▶ claimed ──acknowledge──▶ processed
 *                 ▲                │
 *                 └─retry_scheduled◀┴─retry/deadLetter──▶ dead_lettered ──replay──▶ pending
 */

type Claimable = { readonly state: string; readonly claim: null | { readonly leaseExpiresAt: string }; readonly nextAttemptAt?: string }
type Claimed = { readonly state: string; readonly claim: null | { readonly token: string; readonly leaseExpiresAt: string } }

export const MAX_DELIVERY_LEASE_MS = 15 * 60 * 1000
export const MAX_DELIVERY_RETRY_DELAY_MS = 7 * 24 * 60 * 60 * 1000
const FAILURE_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/

const iso = (date: Date): string => date.toISOString()

function validTime(now: Date): number {
  const time = now instanceof Date ? now.getTime() : Number.NaN
  if (!Number.isFinite(time)) throw new ConfigurationError("Delivery transition requires a valid time")
  return time
}

function leaseDuration(leaseMs: number): number {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > MAX_DELIVERY_LEASE_MS) throw new ConfigurationError(`Delivery lease must be an integer from 1 to ${MAX_DELIVERY_LEASE_MS} ms`)
  return leaseMs
}

function retryDelay(delayMs: number): number {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > MAX_DELIVERY_RETRY_DELAY_MS) throw new ConfigurationError(`Delivery retry delay must be an integer from 0 to ${MAX_DELIVERY_RETRY_DELAY_MS} ms`)
  return delayMs
}

function attemptLimit(maxAttempts: number): number {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new ConfigurationError("Delivery maxAttempts must be a positive integer")
  return maxAttempts
}

/** Failure codes are stable identifiers, never free text, so they cannot carry sensitive data. */
export function normalizeDeliveryFailureCode(code: unknown): string {
  return typeof code === "string" && FAILURE_CODE.test(code) ? code : "DELIVERY_FAILED"
}

function claimToken(token: string): string {
  if (typeof token !== "string" || token.length < 1 || token.length > 256) throw new ConfigurationError("Delivery claim token must be 1 to 256 characters")
  return token
}

function owner(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw new ConfigurationError("Delivery claim owner must be 1 to 256 characters")
  return value
}

/** Whether a record may be claimed at `now` (pending, due retry, or expired claim). */
export function isDeliveryClaimable(record: Claimable, now: Date): boolean {
  const time = validTime(now)
  if (record.state === "pending") return true
  if (record.state === "retry_scheduled") return record.nextAttemptAt === undefined || time >= Date.parse(record.nextAttemptAt)
  return record.state === "claimed" && record.claim !== null && time >= Date.parse(record.claim.leaseExpiresAt)
}

/** Throws StaleClaimError unless `token` is the live, unexpired claim. */
export function assertDeliveryClaimAlive(record: Claimed, token: string, now: Date): void {
  const time = validTime(now)
  if (record.state !== "claimed" || record.claim === null || record.claim.token !== token || time >= Date.parse(record.claim.leaseExpiresAt)) throw new StaleClaimError()
}

function newClaim(args: { owner: string; token: string; leaseMs: number; now: Date }): InboxClaim {
  const time = validTime(args.now)
  return Object.freeze({ token: claimToken(args.token), owner: owner(args.owner), claimedAt: iso(args.now), leaseExpiresAt: iso(new Date(time + leaseDuration(args.leaseMs))) })
}

function withoutRetryTime<T extends { readonly nextAttemptAt?: string }>(record: T): Omit<T, "nextAttemptAt"> {
  const { nextAttemptAt: _nextAttemptAt, ...rest } = record
  return rest
}

// ---------------------------------------------------------------- outbox

/** Idempotent append: an existing record with the same key wins; a different idempotency key is a conflict. */
export function appendOutboxDelivery(current: OutboxDeliveryRecord | null, record: OutboxDeliveryRecord): OutboxDeliveryRecord {
  if (record.state !== "pending" || record.attempt !== 0 || record.claim !== null) throw new ConfigurationError("New outbox deliveries must be pending, unclaimed, and unattempted")
  if (current === null) return record
  if (current.idempotencyKey !== record.idempotencyKey) throw new ConflictError("Outbox message id reused with a different idempotency key")
  return current
}

export function claimOutboxDelivery(record: OutboxDeliveryRecord, args: { owner: string; token: string; leaseMs: number; now: Date }): OutboxDeliveryRecord | null {
  if (!isDeliveryClaimable(record, args.now)) return null
  return { ...withoutRetryTime(record), state: "claimed", attempt: record.attempt + 1, claim: newClaim(args) }
}

export function markOutboxDeliveryPublished(record: OutboxDeliveryRecord, token: string, now: Date): OutboxDeliveryRecord {
  assertDeliveryClaimAlive(record, token, now)
  return { ...withoutRetryTime(record), state: "published", claim: null, publishedAt: iso(now) }
}

/** Schedules a retry after `delayMs`, or dead-letters once `attempt` has reached `maxAttempts`. */
export function recordOutboxDeliveryFailure(record: OutboxDeliveryRecord, args: { token: string; code: string; delayMs: number; maxAttempts: number; now: Date }): OutboxDeliveryRecord {
  assertDeliveryClaimAlive(record, args.token, args.now)
  const lastFailure = { code: normalizeDeliveryFailureCode(args.code), occurredAt: iso(args.now) }
  if (record.attempt >= attemptLimit(args.maxAttempts)) return { ...withoutRetryTime(record), state: "dead_lettered", claim: null, lastFailure }
  return { ...record, state: "retry_scheduled", claim: null, nextAttemptAt: iso(new Date(validTime(args.now) + retryDelay(args.delayMs))), lastFailure }
}

// ----------------------------------------------------------------- inbox

/** First observation creates the record; later observations only refresh lastObservedAt. */
export function observeInboxRecord(current: InboxRecord | null, record: InboxRecord, now: Date): InboxRecord {
  if (current === null) {
    if (record.state !== "pending" || record.attempt !== 0 || record.claim !== null) throw new ConfigurationError("New inbox records must be pending, unclaimed, and unattempted")
    return { ...record, lastObservedAt: iso(now) }
  }
  return current
}

export function claimInboxRecord(record: InboxRecord, args: { owner: string; token: string; leaseMs: number; now: Date }): InboxRecord | null {
  if (!isDeliveryClaimable(record, args.now)) return null
  return { ...withoutRetryTime(record), state: "claimed", attempt: record.attempt + 1, claim: newClaim(args), lastObservedAt: iso(args.now) }
}

export function renewInboxClaim(record: InboxRecord, args: { token: string; leaseMs: number; now: Date }): InboxRecord {
  assertDeliveryClaimAlive(record, args.token, args.now)
  return { ...record, claim: { ...record.claim!, leaseExpiresAt: iso(new Date(validTime(args.now) + leaseDuration(args.leaseMs))) }, lastObservedAt: iso(args.now) }
}

/** The local mutation committed in the same transaction: mark processed and record history. */
export function acknowledgeInboxRecord(record: InboxRecord, token: string, now: Date): InboxRecord {
  assertDeliveryClaimAlive(record, token, now)
  return { ...withoutRetryTime(record), state: "processed", claim: null, processedAt: iso(now), lastObservedAt: iso(now), history: [...record.history, { generation: record.replayGeneration, terminalState: "processed", at: iso(now) }] }
}

function deadLettered(record: InboxRecord, code: string, now: Date): InboxRecord {
  const failure: InboxFailure = { code: normalizeDeliveryFailureCode(code), retryable: false, occurredAt: iso(now) }
  return { ...withoutRetryTime(record), state: "dead_lettered", claim: null, deadLetteredAt: iso(now), lastFailure: failure, lastObservedAt: iso(now), history: [...record.history, { generation: record.replayGeneration, terminalState: "dead_lettered", at: iso(now), failure }] }
}

export function scheduleInboxRetry(record: InboxRecord, args: { token: string; code: string; delayMs: number; maxAttempts: number; now: Date }): InboxRecord {
  assertDeliveryClaimAlive(record, args.token, args.now)
  if (record.attempt >= attemptLimit(args.maxAttempts)) return deadLettered(record, args.code, args.now)
  const failure: InboxFailure = { code: normalizeDeliveryFailureCode(args.code), retryable: true, occurredAt: iso(args.now) }
  return { ...record, state: "retry_scheduled", claim: null, nextAttemptAt: iso(new Date(validTime(args.now) + retryDelay(args.delayMs))), lastFailure: failure, lastObservedAt: iso(args.now) }
}

export function deadLetterInboxRecord(record: InboxRecord, args: { token: string; code: string; now: Date }): InboxRecord {
  assertDeliveryClaimAlive(record, args.token, args.now)
  return deadLettered(record, args.code, args.now)
}

/** Operator replay of a dead-lettered delivery under a new generation; history is preserved. */
export function replayInboxRecord(record: InboxRecord, request: { requestedBy: DurableAuthorityProvenanceV1; reason: string; now: Date }): InboxRecord {
  if (record.state !== "dead_lettered") throw new ConflictError("Only dead-lettered delivery may be replayed")
  if (typeof request.reason !== "string" || !request.reason.trim() || request.reason.length > 1024) throw new ConfigurationError("Replay requires a reason of 1 to 1024 characters")
  const generation = record.replayGeneration + 1
  return { ...withoutRetryTime(record), state: "pending", attempt: 0, replayGeneration: generation, claim: null, replay: { kind: "replayed", replayGeneration: generation, requestedAt: iso(request.now), requestedBy: request.requestedBy, reason: request.reason }, lastObservedAt: iso(request.now) }
}
