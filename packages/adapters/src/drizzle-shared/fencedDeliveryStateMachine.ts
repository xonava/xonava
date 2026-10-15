import { ConfigurationError, ConflictError, type DurableAuthorityProvenanceV1 } from "@xonava/core/domain"
import type { InboxKey, InboxPort, InboxRecord, OutboxDeliveryKey, OutboxDeliveryRecord, OutboxStore } from "@xonava/core/events"
import {
  acknowledgeInboxRecord, appendOutboxDelivery, claimInboxRecord, claimOutboxDelivery, deadLetterInboxRecord, markOutboxDeliveryPublished,
  observeInboxRecord, recordOutboxDeliveryFailure, renewInboxClaim, replayInboxRecord, scheduleInboxRetry,
} from "@xonava/core/events"

export interface AtomicRecordBackend<TKey, TRecord> {
  readonly transactional: boolean
  transact<TResult>(key: TKey, transition: (current: TRecord | null, backendNow: Date, freshToken: () => string, transaction?: unknown) => { readonly record: TRecord; readonly result: TResult } | Promise<{ readonly record: TRecord; readonly result: TResult }>): Promise<TResult>
  read(key: TKey): Promise<TRecord | null>
}

function existing<T>(current: T | null, message?: string): T {
  if (!current) throw new ConflictError(message)
  return current
}

/**
 * Persistence for the core delivery state machines. Every rule lives in
 * core/events (pure transitions); this class only runs each transition
 * atomically against the current record through the backend.
 */
export class FencedInboxStore implements InboxPort {
  constructor(private readonly backend: AtomicRecordBackend<InboxKey, InboxRecord>) {}
  observe(record: InboxRecord): Promise<InboxRecord> {
    return this.backend.transact({ consumerKey: record.consumerKey, messageId: record.messageId, scopeId: record.scopeId }, (current, now) => { const next = observeInboxRecord(current, record, now); return { record: next, result: next } })
  }
  get(key: InboxKey): Promise<InboxRecord | null> { return this.backend.read(key) }
  claim(key: InboxKey, owner: string, leaseMs: number, maxAttempts?: number): Promise<InboxRecord | null> {
    return this.backend.transact<InboxRecord | null>(key, (current, now, freshToken) => {
      const record = existing(current, "Inbox record not observed")
      const next = claimInboxRecord(record, { owner, token: freshToken(), leaseMs, now, ...(maxAttempts !== undefined ? { maxAttempts } : {}) })
      return { record: next ?? record, result: next }
    })
  }
  renew(key: InboxKey, token: string, leaseMs: number): Promise<InboxRecord> {
    return this.backend.transact(key, (current, now) => { const next = renewInboxClaim(existing(current), { token, leaseMs, now }); return { record: next, result: next } })
  }
  acknowledge<T>(key: InboxKey, token: string, localMutation: (transaction?: unknown) => Promise<T>): Promise<{ record: InboxRecord; result: T }> {
    if (!this.backend.transactional) throw new ConfigurationError("Transactional inbox acknowledgement is unsupported by this backend")
    return this.backend.transact(key, async (current, now, _freshToken, transaction) => {
      const record = existing(current)
      // Fence before running the mutation, then transition in the same transaction.
      const next = acknowledgeInboxRecord(record, token, now)
      const result = await localMutation(transaction)
      return { record: next, result: { record: next, result } }
    })
  }
  scheduleRetry(key: InboxKey, token: string, failureCode: string, delayMs: number, maxAttempts: number): Promise<InboxRecord> {
    return this.backend.transact<InboxRecord>(key, (current, now) => { const next = scheduleInboxRetry(existing(current), { token, code: failureCode, delayMs, maxAttempts, now }); return { record: next, result: next } })
  }
  deadLetter(key: InboxKey, token: string, failureCode: string): Promise<InboxRecord> {
    return this.backend.transact(key, (current, now) => { const next = deadLetterInboxRecord(existing(current), { token, code: failureCode, now }); return { record: next, result: next } })
  }
  replay(key: InboxKey, request: { requestedBy: DurableAuthorityProvenanceV1; reason: string; authorized: true; validateReplayEligibility: () => void }): Promise<InboxRecord> {
    if (request.authorized !== true) throw new ConfigurationError("Replay requires authorization")
    request.validateReplayEligibility()
    return this.backend.transact<InboxRecord>(key, (current, now) => {
      const next = replayInboxRecord(existing(current, "Only dead-lettered delivery may be replayed"), { requestedBy: request.requestedBy, reason: request.reason, now })
      return { record: next, result: next }
    })
  }
}

export class FencedOutboxStore implements OutboxStore {
  constructor(private readonly backend: AtomicRecordBackend<OutboxDeliveryKey, OutboxDeliveryRecord>) {}
  append(record: OutboxDeliveryRecord): Promise<OutboxDeliveryRecord> {
    return this.backend.transact({ messageId: record.envelope.messageId, scopeId: record.scopeId }, (current) => { const next = appendOutboxDelivery(current, record); return { record: next, result: next } })
  }
  get(key: OutboxDeliveryKey) { return this.backend.read(key) }
  claim(key: OutboxDeliveryKey, owner: string, leaseMs: number, maxAttempts?: number): Promise<OutboxDeliveryRecord | null> {
    return this.backend.transact<OutboxDeliveryRecord | null>(key, (current, now, freshToken) => {
      const record = existing(current)
      const next = claimOutboxDelivery(record, { owner, token: freshToken(), leaseMs, now, ...(maxAttempts !== undefined ? { maxAttempts } : {}) })
      return { record: next ?? record, result: next }
    })
  }
  markPublished(key: OutboxDeliveryKey, token: string): Promise<OutboxDeliveryRecord> {
    return this.backend.transact(key, (current, now) => { const next = markOutboxDeliveryPublished(existing(current), token, now); return { record: next, result: next } })
  }
  recordFailure(key: OutboxDeliveryKey, token: string, code: string, delayMs: number, maxAttempts: number): Promise<OutboxDeliveryRecord> {
    return this.backend.transact(key, (current, now) => { const next = recordOutboxDeliveryFailure(existing(current), { token, code, delayMs, maxAttempts, now }); return { record: next, result: next } })
  }
}
