import type { DurableAuthorityProvenanceV1, ExecutionScopeId } from "../../domain"

export type InboxState = "pending" | "claimed" | "retry_scheduled" | "processed" | "dead_lettered"
export interface InboxClaim { readonly token: string; readonly owner: string; readonly claimedAt: string; readonly leaseExpiresAt: string }
export interface InboxFailure { readonly code: string; readonly retryable: boolean; readonly occurredAt: string }
export interface InboxHistoryEntry { readonly generation: number; readonly terminalState: "processed" | "dead_lettered"; readonly at: string; readonly failure?: InboxFailure }
export interface InboxRecord {
  readonly messageId: string
  readonly consumerKey: string
  readonly consumerDefinitionVersion: number
  readonly scopeId: ExecutionScopeId
  readonly state: InboxState
  readonly attempt: number
  readonly replayGeneration: number
  readonly claim: InboxClaim | null
  readonly nextAttemptAt?: string
  readonly firstObservedAt: string
  readonly lastObservedAt: string
  readonly processedAt?: string
  readonly deadLetteredAt?: string
  readonly lastFailure?: InboxFailure
  readonly eventFormatVersion: number
  readonly eventPayloadVersion: number
  readonly originalProvenance: DurableAuthorityProvenanceV1
  readonly replay: { readonly kind: "original-delivery" } | { readonly kind: "replayed"; readonly replayGeneration: number; readonly requestedAt: string; readonly requestedBy: DurableAuthorityProvenanceV1; readonly reason: string }
  readonly history: readonly InboxHistoryEntry[]
}
export interface InboxKey { readonly consumerKey: string; readonly messageId: string; readonly scopeId: ExecutionScopeId }
export interface InboxPort {
  observe(record: InboxRecord): Promise<InboxRecord>
  get(key: InboxKey): Promise<InboxRecord | null>
  claim(key: InboxKey, owner: string, leaseMs: number): Promise<InboxRecord | null>
  renew(key: InboxKey, token: string, leaseMs: number): Promise<InboxRecord>
  acknowledge<T>(key: InboxKey, token: string, localMutation: (transaction?: unknown) => Promise<T>): Promise<{ record: InboxRecord; result: T }>
  scheduleRetry(key: InboxKey, token: string, failureCode: string, delayMs: number, maxAttempts: number): Promise<InboxRecord>
  deadLetter(key: InboxKey, token: string, failureCode: string): Promise<InboxRecord>
  replay(key: InboxKey, request: { requestedBy: DurableAuthorityProvenanceV1; reason: string; authorized: true; validateReplayEligibility: () => void }): Promise<InboxRecord>
}
