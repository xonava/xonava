import type { ExecutionScopeId } from "../domain"

export type SequenceResetPeriod = "never" | "year" | "month" | "day"
export interface SequenceDefinition {
  readonly name: string
  readonly prefix?: string
  readonly padding?: number
  readonly reset?: SequenceResetPeriod
  /**
   * IANA time zone in which reset periods begin (default "UTC"). A monthly
   * invoice counter for an Indian business resets at local midnight, not 05:30.
   */
  readonly timeZone?: string
  /**
   * Embed the period in the formatted number: "compact" (202603) or "iso" (2026-03).
   * Required when `reset` is not "never": a resetting counter restarts at 1, so a
   * period-free formatted value repeats; choose "none" only when the period is carried
   * elsewhere. Omitting it on a resetting counter is a ConfigurationError; it defaults
   * to "none" otherwise.
   */
  readonly periodFormat?: "none" | "compact" | "iso"
  /** Separator between an embedded period and the number (default "-", at most 4 characters). */
  readonly periodSeparator?: string
}
export interface SequenceAllocationRequest {
  readonly scopeId: ExecutionScopeId
  readonly definition: SequenceDefinition
  /** Allocation instant; must come from a trusted server clock, never from client input. */
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
