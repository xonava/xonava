import type { PersistenceProvider, TransactionOptions } from "../persistence"

export type AggregateSnapshot = Readonly<Record<string, unknown>>
export type AggregateInvariantPhase = "before" | "after" | "both"

export interface AggregateInvariant<TSnapshot extends AggregateSnapshot = AggregateSnapshot> {
  readonly key: string
  readonly phase: AggregateInvariantPhase
  /** Must be deterministic and side-effect-free. */
  readonly check: (snapshot: TSnapshot) => boolean
}

export interface AggregateDefinition<TSnapshot extends AggregateSnapshot = AggregateSnapshot> {
  readonly key: string
  readonly version: number
  readonly members: readonly string[]
  readonly invariants: readonly AggregateInvariant<TSnapshot>[]
}

export interface CompiledAggregateDefinition<TSnapshot extends AggregateSnapshot = AggregateSnapshot> extends AggregateDefinition<TSnapshot> {}

export interface AggregateTransactionResult<TResult, TSnapshot extends AggregateSnapshot> {
  readonly result: TResult
  readonly before: TSnapshot
  readonly after: TSnapshot
}

export interface AggregateTransactionOptions<TSnapshot extends AggregateSnapshot, TResult> {
  readonly definition: CompiledAggregateDefinition<TSnapshot>
  readonly persistence: PersistenceProvider
  readonly load: (persistence: PersistenceProvider) => Promise<TSnapshot>
  readonly mutate: (persistence: PersistenceProvider, before: TSnapshot) => Promise<TResult>
  readonly transaction?: TransactionOptions
}
