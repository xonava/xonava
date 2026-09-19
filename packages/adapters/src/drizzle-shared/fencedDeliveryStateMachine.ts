import { ConfigurationError, ConflictError, StaleClaimError, type DurableAuthorityProvenanceV1 } from "core/domain"
import type { InboxKey, InboxPort, InboxRecord, OutboxDeliveryKey, OutboxDeliveryRecord, OutboxStore } from "core/events"

export interface AtomicRecordBackend<TKey, TRecord> {
  readonly transactional: boolean
  transact<TResult>(key: TKey, transition: (current: TRecord | null, backendNow: Date, freshToken: () => string, transaction?: unknown) => { readonly record: TRecord; readonly result: TResult } | Promise<{ readonly record: TRecord; readonly result: TResult }>): Promise<TResult>
  read(key: TKey): Promise<TRecord | null>
}

const iso = (date: Date) => date.toISOString()
const alive = (record: { state: string; claim: null | { token: string; leaseExpiresAt: string } }, token: string, now: Date): void => {
  if (record.state !== "claimed" || record.claim?.token !== token || now.getTime() >= Date.parse(record.claim.leaseExpiresAt)) throw new StaleClaimError()
}
const claimable = (record: { state: string; claim: null | { leaseExpiresAt: string }; nextAttemptAt?: string }, now: Date): boolean =>
  record.state === "pending" || (record.state === "retry_scheduled" && record.nextAttemptAt !== undefined && now.getTime() >= Date.parse(record.nextAttemptAt)) || (record.state === "claimed" && record.claim !== null && now.getTime() >= Date.parse(record.claim.leaseExpiresAt))

export class FencedInboxStore implements InboxPort {
  constructor(private readonly backend: AtomicRecordBackend<InboxKey, InboxRecord>) {}
  observe(record: InboxRecord): Promise<InboxRecord> { return this.backend.transact({ consumerKey: record.consumerKey, messageId: record.messageId, scopeId: record.scopeId }, (current, now) => { const observed = current ?? { ...record, lastObservedAt: iso(now) }; return { record: observed, result: observed } }) }
  get(key: InboxKey): Promise<InboxRecord | null> { return this.backend.read(key) }
  claim(key: InboxKey, owner: string, leaseMs: number): Promise<InboxRecord | null> {
    return this.backend.transact<InboxRecord | null>(key, (current, now, freshToken) => {
      if (!current) throw new ConflictError("Inbox record not observed")
      if (!claimable(current, now)) return { record: current, result: null }
      const { nextAttemptAt: _nextAttemptAt, ...base } = current
      const next: InboxRecord = { ...base, state: "claimed", attempt: current.attempt + 1, claim: { token: freshToken(), owner, claimedAt: iso(now), leaseExpiresAt: iso(new Date(now.getTime() + leaseMs)) }, lastObservedAt: iso(now) }
      return { record: next, result: next }
    })
  }
  renew(key: InboxKey, token: string, leaseMs: number): Promise<InboxRecord> { return this.backend.transact(key, (current, now) => { if (!current) throw new ConflictError(); alive(current, token, now); const next = { ...current, claim: { ...current.claim!, leaseExpiresAt: iso(new Date(now.getTime() + leaseMs)) }, lastObservedAt: iso(now) }; return { record: next, result: next } }) }
  acknowledge<T>(key: InboxKey, token: string, localMutation: (transaction?: unknown) => Promise<T>): Promise<{ record: InboxRecord; result: T }> {
    if (!this.backend.transactional) throw new ConfigurationError("Transactional inbox acknowledgement is unsupported by this backend")
    return this.backend.transact(key, async (current, now, _freshToken, transaction) => {
      if (!current) throw new ConflictError(); alive(current, token, now)
      const result = await localMutation(transaction)
      const next = { ...current, state: "processed" as const, claim: null, processedAt: iso(now), lastObservedAt: iso(now), history: [...current.history, { generation: current.replayGeneration, terminalState: "processed" as const, at: iso(now) }] }
      return { record: next, result: { record: next, result } }
    })
  }
  scheduleRetry(key: InboxKey, token: string, failureCode: string, delayMs: number, maxAttempts: number): Promise<InboxRecord> {
    return this.backend.transact<InboxRecord>(key, (current, now) => { if (!current) throw new ConflictError(); alive(current, token, now); if (current.attempt >= maxAttempts) return this.deadLetterTransition(current, failureCode, now); const failure = { code: failureCode, retryable: true, occurredAt: iso(now) }; const next: InboxRecord = { ...current, state: "retry_scheduled", claim: null, nextAttemptAt: iso(new Date(now.getTime() + delayMs)), lastFailure: failure, lastObservedAt: iso(now) }; return { record: next, result: next } })
  }
  deadLetter(key: InboxKey, token: string, failureCode: string): Promise<InboxRecord> { return this.backend.transact(key, (current, now) => { if (!current) throw new ConflictError(); alive(current, token, now); return this.deadLetterTransition(current, failureCode, now) }) }
  replay(key: InboxKey, request: { requestedBy: DurableAuthorityProvenanceV1; reason: string; authorized: true; validateReplayEligibility: () => void }): Promise<InboxRecord> {
    if (request.authorized !== true) throw new ConfigurationError("Replay requires authorization")
    request.validateReplayEligibility()
    return this.backend.transact<InboxRecord>(key, (current, now) => { if (!current || current.state !== "dead_lettered") throw new ConflictError("Only dead-lettered delivery may be replayed"); const generation = current.replayGeneration + 1; const { nextAttemptAt: _nextAttemptAt, ...base } = current; const next: InboxRecord = { ...base, state: "pending", attempt: 0, replayGeneration: generation, claim: null, replay: { kind: "replayed", replayGeneration: generation, requestedAt: iso(now), requestedBy: request.requestedBy, reason: request.reason }, lastObservedAt: iso(now) }; return { record: next, result: next } })
  }
  private deadLetterTransition(current: InboxRecord, code: string, now: Date) { const failure = { code, retryable: false, occurredAt: iso(now) }; const next = { ...current, state: "dead_lettered" as const, claim: null, deadLetteredAt: iso(now), lastFailure: failure, lastObservedAt: iso(now), history: [...current.history, { generation: current.replayGeneration, terminalState: "dead_lettered" as const, at: iso(now), failure }] }; return { record: next, result: next } }
}

export class FencedOutboxStore implements OutboxStore {
  constructor(private readonly backend: AtomicRecordBackend<OutboxDeliveryKey, OutboxDeliveryRecord>) {}
  append(record: OutboxDeliveryRecord): Promise<OutboxDeliveryRecord> { return this.backend.transact({ messageId: record.envelope.messageId, scopeId: record.scopeId }, current => { if (current && current.envelope.messageId !== record.envelope.messageId) throw new ConflictError("Outbox idempotency conflict"); return { record: current ?? record, result: current ?? record } }) }
  get(key: OutboxDeliveryKey) { return this.backend.read(key) }
  claim(key: OutboxDeliveryKey, owner: string, leaseMs: number): Promise<OutboxDeliveryRecord | null> { return this.backend.transact<OutboxDeliveryRecord | null>(key, (current, now, freshToken) => { if (!current) throw new ConflictError(); if (!claimable(current, now)) return { record: current, result: null }; const { nextAttemptAt: _nextAttemptAt, ...base } = current; const next: OutboxDeliveryRecord = { ...base, state: "claimed", attempt: current.attempt + 1, claim: { token: freshToken(), owner, claimedAt: iso(now), leaseExpiresAt: iso(new Date(now.getTime() + leaseMs)) } }; return { record: next, result: next } }) }
  markPublished(key: OutboxDeliveryKey, token: string): Promise<OutboxDeliveryRecord> { return this.backend.transact(key, (current, now) => { if (!current) throw new ConflictError(); alive(current, token, now); const next = { ...current, state: "published" as const, claim: null, publishedAt: iso(now) }; return { record: next, result: next } }) }
  recordFailure(key: OutboxDeliveryKey, token: string, code: string, delayMs: number, maxAttempts: number): Promise<OutboxDeliveryRecord> { return this.backend.transact(key, (current, now) => { if (!current) throw new ConflictError(); alive(current, token, now); const terminal = current.attempt >= maxAttempts; const next = { ...current, state: terminal ? "dead_lettered" as const : "retry_scheduled" as const, claim: null, ...(terminal ? {} : { nextAttemptAt: iso(new Date(now.getTime() + delayMs)) }), lastFailure: { code, occurredAt: iso(now) } }; return { record: next, result: next } }) }
}
