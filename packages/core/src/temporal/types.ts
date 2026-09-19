import type { ExecutionScopeId } from "../domain"
import type { PersistenceProvider } from "../persistence"
import type { EntityVersion } from "../serialization"

export interface TemporalResource { readonly scopeId: ExecutionScopeId; readonly entityType: string; readonly entityId: string }
export type TemporalRevisionKind = "created" | "updated" | "deleted" | "restored"
export interface TemporalRevision<TState extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> extends TemporalResource {
  readonly revision: number
  readonly occurredAt: Date
  readonly kind: TemporalRevisionKind
  /** Full authoritative state after this revision; null represents deletion. */
  readonly state: TState | null
  readonly entityVersion?: EntityVersion
  readonly eventId?: string
  readonly auditId?: string
}
export type NewTemporalRevision<TState extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> = Omit<TemporalRevision<TState>, "revision">
export interface TemporalSnapshot<TState extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> extends TemporalResource {
  readonly revision: number
  readonly occurredAt: Date
  readonly state: TState | null
}
export interface TemporalRevisionPage<TState extends Readonly<Record<string, unknown>>> { readonly items: readonly TemporalRevision<TState>[]; readonly hasMore: boolean }
export interface TemporalHistoryStore<TState extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> {
  /** Atomically allocates the next resource revision and appends it. */
  append(revision: NewTemporalRevision<TState>): Promise<TemporalRevision<TState>>
  saveSnapshot(snapshot: TemporalSnapshot<TState>): Promise<void>
  latestSnapshot(resource: TemporalResource, asOf: Date): Promise<TemporalSnapshot<TState> | null>
  revisions(resource: TemporalResource, options: { afterRevision: number; asOf: Date; limit: number }): Promise<TemporalRevisionPage<TState>>
}
export interface TemporalHistoryStoreFactory { create<TState extends Readonly<Record<string, unknown>>>(persistence: PersistenceProvider): TemporalHistoryStore<TState> }
export interface TemporalReconstruction<TState extends Readonly<Record<string, unknown>>> { readonly resource: TemporalResource; readonly asOf: Date; readonly revision: number | null; readonly state: TState | null; readonly deleted: boolean; readonly replayedRevisions: number }
