import type { ExecutionScope } from "../domain/executionScope"
import type { BackoffPolicy } from "../resilience/backoff"

/**
 * `compensation_failed` is terminal: compensation exhausted its retry policy
 * and the instance needs manual intervention. It is never claimed again.
 */
export type WorkflowStatus = "pending" | "running" | "waiting" | "compensating" | "succeeded" | "failed" | "cancelled" | "compensation_failed"
export type WorkflowTerminalOutcome = "succeeded" | "failed" | "cancelled"

/** Bounded, sanitized description of the failure that drove a workflow to compensate or fail. */
export interface WorkflowFailure {
  /** Stable machine code, e.g. STEP_FAILED, RETRY_EXHAUSTED, ATTEMPTS_EXHAUSTED, TIMEOUT, or an error code. */
  readonly code: string
  /** Sanitized message (PII patterns redacted, at most 512 characters). */
  readonly message: string
  readonly step: string
  readonly phase: "execute" | "compensate"
  readonly attempt: number
  readonly at: Date
}

export interface WorkflowInstance {
  readonly id: string
  readonly workflowType: string
  readonly workflowVersion: number
  readonly executionScope: ExecutionScope
  readonly status: WorkflowStatus
  readonly currentStep: string
  readonly variables: Readonly<Record<string, unknown>>
  /**
   * Attempts started for the current step (or current compensation step).
   * Stores increment it atomically when they claim the instance, so crashed,
   * hung, and timed-out attempts are counted too. Core resets it to 0 when
   * the workflow moves to a new step or compensation step.
   */
  readonly stepAttempt: number
  readonly compensationStack: readonly string[]
  readonly waitingSignal: string | null
  readonly wakeAt: Date | null
  readonly outcome: WorkflowTerminalOutcome | null
  readonly revision: number
  /** Most recent failure; null/absent when none. Stores without the column omit it. */
  readonly failure?: WorkflowFailure | null
  readonly leaseOwner: string | null
  readonly claimToken: string | null
  readonly leaseExpiresAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface WorkflowClaim { readonly instance: WorkflowInstance; readonly workerId: string; readonly claimToken: string }
export interface WorkflowSignal { readonly id: string; readonly instanceId: string; readonly name: string; readonly payload: Readonly<Record<string, unknown>>; readonly deliveredAt: Date }
export interface WorkflowTimer { readonly instanceId: string; readonly wakeAt: Date }

export type WorkflowStepResult =
  | { readonly kind: "next"; readonly step: string; readonly variables?: Readonly<Record<string, unknown>>; readonly compensation?: string }
  | { readonly kind: "wait"; readonly signal: string; readonly variables?: Readonly<Record<string, unknown>> }
  | { readonly kind: "sleep"; readonly wakeAt: Date; readonly variables?: Readonly<Record<string, unknown>> }
  | { readonly kind: "complete"; readonly variables?: Readonly<Record<string, unknown>> }
  | { readonly kind: "retry"; readonly error: string }
  | { readonly kind: "fail"; readonly error: string }

export interface WorkflowStepContext {
  readonly instanceId: string
  readonly executionScope: ExecutionScope
  readonly attempt: number
  readonly variables: Readonly<Record<string, unknown>>
  /** The signal that resumed this step, when the store exposes delivered signals. */
  readonly signal?: WorkflowSignal
  /** Cooperative lifecycle signal. Steps must stop external activity when aborted. */
  readonly executionSignal: AbortSignal
  /** Absolute Unix-millisecond execution deadline. */
  readonly deadline: number
  /** Re-fences immediately before an external effect. */
  readonly assertLease: () => Promise<void>
  /** A workflow step may write one datasource only. Cross-datasource work is sequenced as separate steps. */
  readonly datasource: string
}

export interface WorkflowStepDefinition {
  readonly name: string
  readonly datasource: string
  /**
   * Retry policy for `retry` results and retryable errors. Defaults to
   * DEFAULT_BACKOFF_POLICY. Non-retryable errors fail the step immediately.
   */
  readonly retry?: BackoffPolicy
  /**
   * Declares that re-running `execute` after a timeout is safe. Only
   * idempotent steps are retried after a timeout, because a timed-out step
   * may already have performed its external effect.
   */
  readonly idempotent?: boolean
  /** Retry policy for `compensate`. Defaults to DEFAULT_BACKOFF_POLICY. */
  readonly compensationRetry?: BackoffPolicy
  execute(context: WorkflowStepContext): Promise<WorkflowStepResult>
  compensate?(context: WorkflowStepContext): Promise<void>
}

export interface WorkflowDefinition {
  readonly type: string
  readonly version: number
  readonly initialStep: string
  readonly steps: Readonly<Record<string, WorkflowStepDefinition>>
  decodeVariables(value: unknown): Readonly<Record<string, unknown>>
}

export interface WorkflowUpcaster { readonly type: string; readonly from: number; readonly to: number; upcast(value: unknown): unknown }
