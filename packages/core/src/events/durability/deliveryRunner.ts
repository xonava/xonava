import { CancelledError, ConfigurationError, FrameworkCoreError, StaleClaimError, TimeoutError } from "../../domain/errors"
import { canRetryAfter, computeBackoffDelayMs, DEFAULT_BACKOFF_POLICY, type BackoffPolicy } from "../../resilience/backoff"
import type { EventEnvelope } from "../eventEnvelope"
import type { ConsumerDefinition } from "../consumerDefinition"
import type { InboxKey, InboxPort, InboxRecord } from "./inbox"
import type { EventPublisher, OutboxDeliveryKey, OutboxDeliveryRecord, OutboxStore } from "./outboxStore"
import { MAX_DELIVERY_RETRY_DELAY_MS, normalizeDeliveryFailureCode } from "./delivery"

/**
 * Reference runners for one outbox message and one inbox message. They own
 * the protocol (claim, bounded work, fenced transition, failure
 * classification); stores own persistence and atomicity. A relay or consumer
 * loop calls them per message with whatever concurrency it chooses.
 *
 * Delivery is at-least-once: a publish whose acknowledgement is lost is
 * published again, so consumers MUST deduplicate through the inbox.
 */

export type DeliveryOutcome = "published" | "processed" | "already_processed" | "retry_scheduled" | "dead_lettered" | "not_claimable" | "lease_lost" | "cancelled"

/** Errors a framework marks non-retryable (validation, authorization, configuration...) are permanent. */
function isPermanent(error: unknown): boolean {
  return error instanceof FrameworkCoreError && !error.retryable
}

function failureCode(error: unknown): string {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined
  return normalizeDeliveryFailureCode(typeof code === "string" ? code : error instanceof Error ? error.name : undefined)
}

function boundedLeaseWork(leaseMs: number, requested: number | undefined): number {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 2) throw new ConfigurationError("Delivery leaseMs must be an integer of at least 2")
  // Work must finish comfortably inside the lease so a stale worker cannot act after takeover.
  const ceiling = Math.max(1, Math.floor(leaseMs * 0.8))
  if (requested === undefined) return ceiling
  if (!Number.isSafeInteger(requested) || requested < 1) throw new ConfigurationError("Delivery work timeout must be a positive integer")
  return Math.min(requested, ceiling)
}

/** Runs `work` with an abort signal linked to `parent` and a hard deadline; always releases the timer and listener. */
async function withDeadline<T>(parent: AbortSignal | undefined, timeoutMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const onParentAbort = (): void => controller.abort(parent?.reason ?? new CancelledError())
  parent?.addEventListener("abort", onParentAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { const error = new TimeoutError("Delivery work deadline exceeded"); controller.abort(error); reject(error) }, timeoutMs)
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })
  })
  void deadline.catch(() => undefined)
  try {
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)), deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    parent?.removeEventListener("abort", onParentAbort)
  }
}

export interface DeliverOutboxMessageArgs {
  readonly store: OutboxStore
  readonly publisher: EventPublisher
  readonly key: OutboxDeliveryKey
  readonly owner: string
  readonly leaseMs: number
  readonly retry?: BackoffPolicy
  /** Publish deadline; capped at 80% of the lease. */
  readonly publishTimeoutMs?: number
  readonly signal?: AbortSignal
  readonly random?: () => number
}

export async function deliverOutboxMessage(args: DeliverOutboxMessageArgs): Promise<{ readonly outcome: DeliveryOutcome; readonly record: OutboxDeliveryRecord | null }> {
  const timeoutMs = boundedLeaseWork(args.leaseMs, args.publishTimeoutMs)
  const policy = args.retry ?? DEFAULT_BACKOFF_POLICY
  if (args.signal?.aborted) return { outcome: "cancelled", record: null }
  const claimed = await args.store.claim(args.key, args.owner, args.leaseMs, policy.maxAttempts)
  // A claim of an exhausted record dead-letters it instead of starting another attempt.
  if (claimed?.state === "dead_lettered") return { outcome: "dead_lettered", record: claimed }
  if (!claimed || !claimed.claim) return { outcome: "not_claimable", record: claimed }
  const token = claimed.claim.token
  try {
    await withDeadline(args.signal, timeoutMs, (signal) => args.publisher.publish(claimed.envelope, signal))
  } catch (error) {
    // Shutdown: leave the claim to lapse; the next claim counts the attempt.
    if (args.signal?.aborted) return { outcome: "cancelled", record: claimed }
    const permanent = isPermanent(error)
    const maxAttempts = permanent ? claimed.attempt : policy.maxAttempts
    const delayMs = permanent || !canRetryAfter(policy, claimed.attempt) ? 0 : Math.min(MAX_DELIVERY_RETRY_DELAY_MS, computeBackoffDelayMs(policy, claimed.attempt, args.random))
    try {
      const record = await args.store.recordFailure(args.key, token, failureCode(error), delayMs, maxAttempts)
      return { outcome: record.state === "dead_lettered" ? "dead_lettered" : "retry_scheduled", record }
    } catch (transitionError) {
      if (transitionError instanceof StaleClaimError) return { outcome: "lease_lost", record: claimed }
      throw transitionError
    }
  }
  try {
    return { outcome: "published", record: await args.store.markPublished(args.key, token) }
  } catch (error) {
    // Published but not recorded: it will be published again (at-least-once).
    if (error instanceof StaleClaimError) return { outcome: "lease_lost", record: claimed }
    throw error
  }
}

/** Builds the initial inbox record for a consumer observing an envelope. */
export function createInboxRecord(envelope: EventEnvelope, consumer: ConsumerDefinition, now: Date): InboxRecord {
  const at = now.toISOString()
  return {
    messageId: envelope.messageId, consumerKey: consumer.key, consumerDefinitionVersion: consumer.definitionVersion, scopeId: envelope.scopeId,
    state: "pending", attempt: 0, replayGeneration: 0, claim: null, firstObservedAt: at, lastObservedAt: at,
    eventFormatVersion: envelope.formatVersion, eventPayloadVersion: envelope.payloadVersion,
    originalProvenance: envelope.provenance, replay: { kind: "original-delivery" }, history: [],
  }
}

export interface ConsumeInboxMessageArgs<T> {
  readonly inbox: InboxPort
  readonly envelope: EventEnvelope
  readonly consumer: ConsumerDefinition
  readonly owner: string
  readonly leaseMs: number
  /**
   * The consumer's local mutation. It runs inside the store's acknowledgement
   * transaction, so its effects commit atomically with "processed". It must
   * finish within the work timeout and honour `signal`.
   */
  readonly handle: (context: { readonly envelope: EventEnvelope; readonly transaction?: unknown; readonly signal: AbortSignal; readonly attempt: number }) => Promise<T>
  /** Handler deadline; capped at 80% of the lease. */
  readonly handleTimeoutMs?: number
  readonly now?: () => Date
  readonly signal?: AbortSignal
  readonly random?: () => number
}

function consumerDelay(consumer: ConsumerDefinition, attempt: number, random?: () => number): number {
  if (consumer.backoff) return Math.min(MAX_DELIVERY_RETRY_DELAY_MS, computeBackoffDelayMs(consumer.backoff, attempt, random))
  const delay = consumer.retry.delayMs(attempt)
  return Number.isSafeInteger(delay) && delay >= 0 ? Math.min(delay, MAX_DELIVERY_RETRY_DELAY_MS) : 0
}

export async function consumeInboxMessage<T>(args: ConsumeInboxMessageArgs<T>): Promise<{ readonly outcome: DeliveryOutcome; readonly record: InboxRecord | null; readonly result?: T }> {
  const { envelope, consumer } = args
  if (envelope.eventType !== consumer.eventType) throw new ConfigurationError(`Consumer ${consumer.key} does not handle ${envelope.eventType}`)
  const timeoutMs = boundedLeaseWork(args.leaseMs, args.handleTimeoutMs)
  if (args.signal?.aborted) return { outcome: "cancelled", record: null }
  const key: InboxKey = { consumerKey: consumer.key, messageId: envelope.messageId, scopeId: envelope.scopeId }
  const observed = await args.inbox.observe(createInboxRecord(envelope, consumer, (args.now ?? (() => new Date()))()))
  if (observed.state === "processed") return { outcome: "already_processed", record: observed }
  const maxAttempts = consumer.backoff?.maxAttempts ?? consumer.retry.maxAttempts
  const claimed = await args.inbox.claim(key, args.owner, args.leaseMs, maxAttempts)
  // A claim of an exhausted record dead-letters it instead of starting another attempt.
  if (claimed?.state === "dead_lettered") return { outcome: "dead_lettered", record: claimed }
  if (!claimed || !claimed.claim) return { outcome: "not_claimable", record: claimed }
  const token = claimed.claim.token
  const fail = async (code: string, permanent: boolean): Promise<{ outcome: DeliveryOutcome; record: InboxRecord | null }> => {
    try {
      const record = permanent
        ? await args.inbox.deadLetter(key, token, code)
        : await args.inbox.scheduleRetry(key, token, code, consumerDelay(consumer, claimed.attempt, args.random), maxAttempts)
      return { outcome: record.state === "dead_lettered" ? "dead_lettered" : "retry_scheduled", record }
    } catch (error) {
      if (error instanceof StaleClaimError) return { outcome: "lease_lost", record: claimed }
      throw error
    }
  }
  // A worker that cannot read this payload version (e.g. mid rolling deploy) backs off
  // so a newer worker can take it; the attempt budget still bounds it.
  if (!consumer.acceptedPayloadVersions.includes(envelope.payloadVersion)) return fail("UNSUPPORTED_PAYLOAD_VERSION", false)
  try {
    const acknowledged = await withDeadline(args.signal, timeoutMs, (signal) =>
      args.inbox.acknowledge(key, token, (transaction) => args.handle({ envelope, ...(transaction !== undefined ? { transaction } : {}), signal, attempt: claimed.attempt })))
    return { outcome: "processed", record: acknowledged.record, result: acknowledged.result }
  } catch (error) {
    if (error instanceof StaleClaimError) return { outcome: "lease_lost", record: claimed }
    if (args.signal?.aborted) return { outcome: "cancelled", record: claimed }
    return fail(failureCode(error), isPermanent(error))
  }
}
