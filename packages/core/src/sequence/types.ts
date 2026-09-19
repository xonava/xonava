import type { ExecutionScopeId } from "../domain"

export type SequenceResetPeriod = "never" | "year" | "month" | "day"
export interface SequenceDefinition {
  readonly name: string
  readonly prefix?: string
  readonly padding?: number
  readonly reset?: SequenceResetPeriod
}
export interface SequenceAllocationRequest {
  readonly scopeId: ExecutionScopeId
  readonly definition: SequenceDefinition
  readonly at?: Date
}
export interface SequenceAllocation {
  readonly scopeId: ExecutionScopeId
  readonly name: string
  readonly period: string
  readonly value: number
  readonly formatted: string
}
export interface SequenceStore {
  /** Allocates inside the store's current transaction. Rollback must return the number to the sequence. */
  next(scopeId: ExecutionScopeId, name: string, period: string): Promise<number>
}
