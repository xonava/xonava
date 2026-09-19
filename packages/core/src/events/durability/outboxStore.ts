import type { EventEnvelope } from "../eventEnvelope"
import type { ExecutionScopeId } from "../../domain"

export type OutboxDeliveryState = "pending" | "claimed" | "published" | "retry_scheduled" | "dead_lettered"
export interface OutboxDeliveryRecord {
  readonly envelope: EventEnvelope
  readonly scopeId: ExecutionScopeId
  readonly idempotencyKey: string
  readonly state: OutboxDeliveryState
  readonly attempt: number
  readonly claim: null | { readonly token: string; readonly owner: string; readonly claimedAt: string; readonly leaseExpiresAt: string }
  readonly nextAttemptAt?: string
  readonly publishedAt?: string
  readonly lastFailure?: { readonly code: string; readonly occurredAt: string }
}
export interface OutboxDeliveryKey { readonly messageId: string; readonly scopeId: ExecutionScopeId }
export interface OutboxStore {
  append(record: OutboxDeliveryRecord): Promise<OutboxDeliveryRecord>
  get(key: OutboxDeliveryKey): Promise<OutboxDeliveryRecord | null>
  claim(key: OutboxDeliveryKey, owner: string, leaseMs: number): Promise<OutboxDeliveryRecord | null>
  markPublished(key: OutboxDeliveryKey, token: string): Promise<OutboxDeliveryRecord>
  recordFailure(key: OutboxDeliveryKey, token: string, code: string, delayMs: number, maxAttempts: number): Promise<OutboxDeliveryRecord>
}
export interface EventPublisher { publish(envelope: EventEnvelope, signal?: AbortSignal): Promise<void> }
