import type { PredicateNode } from "../domain"

export type RuleAction = Readonly<Record<string, unknown>>

export interface RuleDefinition<TAction extends RuleAction = RuleAction> {
  readonly key: string
  readonly version: number
  readonly priority: number
  readonly when: PredicateNode
  readonly actions: readonly TAction[]
  /** Matching rules with the same conflict key compete when using per-key resolution. */
  readonly conflictKey?: string
  /** Inclusive ISO-8601 instant. */
  readonly effectiveFrom?: string
  /** Exclusive ISO-8601 instant. */
  readonly effectiveUntil?: string
  readonly description?: string
}

export type RuleConflictResolution =
  | { readonly kind: "all-matches" }
  | { readonly kind: "highest-priority"; readonly onPriorityTie: "rule-key" | "error" }
  | { readonly kind: "highest-priority-per-key"; readonly onPriorityTie: "rule-key" | "error" }

export interface RuleSetDefinition<TAction extends RuleAction = RuleAction> {
  readonly key: string
  readonly version: number
  readonly rules: readonly RuleDefinition<TAction>[]
  readonly conflictResolution: RuleConflictResolution
}

export interface CompiledRuleSet<TAction extends RuleAction = RuleAction> {
  readonly key: string
  readonly version: number
  readonly rules: readonly RuleDefinition<TAction>[]
  readonly conflictResolution: RuleConflictResolution
}

export type RuleEvaluationDisposition =
  | "inactive"
  | "superseded"
  | "not-matched"
  | "selected"
  | "conflict-discarded"

export interface RuleEvaluationTraceEntry {
  readonly key: string
  readonly version: number
  readonly priority: number
  readonly disposition: RuleEvaluationDisposition
  readonly conflictKey?: string
}

export interface RuleMatch<TAction extends RuleAction = RuleAction> {
  readonly key: string
  readonly version: number
  readonly priority: number
  readonly conflictKey?: string
  readonly actions: readonly TAction[]
}

export interface RuleEvaluationResult<TAction extends RuleAction = RuleAction> {
  readonly ruleSetKey: string
  readonly ruleSetVersion: number
  readonly evaluatedAt: Date
  readonly matches: readonly RuleMatch<TAction>[]
  readonly actions: readonly TAction[]
  readonly trace: readonly RuleEvaluationTraceEntry[]
}
