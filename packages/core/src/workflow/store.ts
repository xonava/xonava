import type { ExecutionScope } from "../domain/executionScope"
import type { WorkflowClaim, WorkflowInstance, WorkflowSignal } from "../workflow/types"

export interface StartWorkflowInput { readonly id: string; readonly workflowType: string; readonly workflowVersion: number; readonly executionScope: ExecutionScope; readonly initialStep: string; readonly variables: Readonly<Record<string, unknown>> }
export interface WorkflowFence { readonly instanceId: string; readonly workerId: string; readonly claimToken: string; readonly revision: number }

export interface WorkflowStore {
  start(input: StartWorkflowInput): Promise<WorkflowInstance>
  get(instanceId: string): Promise<WorkflowInstance | null>
  claimDue(args: { workerId: string; limit: number; leaseDurationMs: number; now?: Date }): Promise<readonly WorkflowClaim[]>
  /** Proves that the claim is still current immediately before external activity execution. */
  assertLease(fence: WorkflowFence): Promise<boolean>
  /** Monotonically extends a current, unexpired claim. Returns false for a stale fence. */
  renewLease(fence: WorkflowFence, extendByMs: number): Promise<boolean>
  commit(fence: WorkflowFence, next: WorkflowInstance): Promise<boolean>
  deliverSignal(signal: Omit<WorkflowSignal, "deliveredAt">, now?: Date): Promise<{ delivered: boolean; duplicate: boolean }>
  cancel(instanceId: string, now?: Date): Promise<boolean>
  /**
   * Optional: the most recently delivered signal with this name. When present,
   * the dispatcher hands the signal that resumed a step to that step.
   */
  getSignal?(instanceId: string, name: string): Promise<WorkflowSignal | null>
}
