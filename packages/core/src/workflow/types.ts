import type { ExecutionScope } from "../domain/executionScope"

export type WorkflowStatus = "pending" | "running" | "waiting" | "compensating" | "succeeded" | "failed" | "cancelled"
export type WorkflowTerminalOutcome = "succeeded" | "failed" | "cancelled"

export interface WorkflowInstance {
  readonly id: string
  readonly workflowType: string
  readonly workflowVersion: number
  readonly executionScope: ExecutionScope
  readonly status: WorkflowStatus
  readonly currentStep: string
  readonly variables: Readonly<Record<string, unknown>>
  readonly stepAttempt: number
  readonly compensationStack: readonly string[]
  readonly waitingSignal: string | null
  readonly wakeAt: Date | null
  readonly outcome: WorkflowTerminalOutcome | null
  readonly revision: number
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
