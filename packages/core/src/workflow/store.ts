import type { ExecutionScope } from "../domain/executionScope"
import type { WorkflowClaim, WorkflowInstance, WorkflowSignal } from "../workflow/types"

export interface StartWorkflowInput { readonly id: string; readonly workflowType: string; readonly workflowVersion: number; readonly executionScope: ExecutionScope; readonly initialStep: string; readonly variables: Readonly<Record<string, unknown>> }
export interface WorkflowFence { readonly instanceId: string; readonly workerId: string; readonly claimToken: string; readonly revision: number }

/**
 * Signal receipt contract (normative text: docs/spec/workflow.md, "Signals").
 *
 * - A receipt is durable and is consumed AT MOST ONCE; it is pending until consumed.
 * - The store assigns each receipt a monotonic delivery order; "oldest pending" means smallest delivery order.
 * - Consumption happens in exactly two places, both atomic with the instance transition:
 *   1. `deliverSignal`, when the instance is waiting for that signal name (status `waiting`, no `wakeAt`);
 *   2. `commit`, when `isWorkflowSignalWait(next)` and a pending receipt with that name exists: the store consumes
 *      the oldest one and stores `resumeWorkflowFromBufferedSignal(next, receipt, now)` instead of `next`.
 *   Both record the consumed receipt id in `resumeSignalId`.
 */
export interface WorkflowStore {
  start(input: StartWorkflowInput): Promise<WorkflowInstance>
  get(instanceId: string): Promise<WorkflowInstance | null>
  claimDue(args: { workerId: string; limit: number; leaseDurationMs: number; now?: Date }): Promise<readonly WorkflowClaim[]>
  /** Proves that the claim is still current immediately before external activity execution. */
  assertLease(fence: WorkflowFence): Promise<boolean>
  /** Monotonically extends a current, unexpired claim. Returns false for a stale fence. */
  renewLease(fence: WorkflowFence, extendByMs: number): Promise<boolean>
  /**
   * Fenced transition. Besides persisting `next`, a store that buffers signals MUST, in the same atomic step, resume
   * a signal wait immediately when a pending receipt of the awaited name exists (see the interface comment).
   * Stores must persist `next.resumeSignalId` (null when absent).
   */
  commit(fence: WorkflowFence, next: WorkflowInstance): Promise<boolean>
  /**
   * Records a signal receipt. Idempotent by signal id (`{ delivered: false, duplicate: true }`); an unknown or
   * terminal instance yields `{ delivered: false, duplicate: false }` and stores nothing. Otherwise the receipt is
   * stored (pending) and, when the instance is waiting for that name, the oldest pending receipt of that name is
   * consumed and the instance made pending (`deliverWorkflowSignal`).
   */
  deliverSignal(signal: Omit<WorkflowSignal, "deliveredAt">, now?: Date): Promise<{ delivered: boolean; duplicate: boolean }>
  cancel(instanceId: string, now?: Date): Promise<boolean>
  /**
   * Optional: the most recently delivered receipt with this name, whether pending or consumed. It is NOT
   * necessarily the receipt that resumed the step (a later signal of the same name may already be buffered), so the
   * dispatcher uses it only when the instance has no `resumeSignalId` or the store lacks `getSignalById`.
   */
  getSignal?(instanceId: string, name: string): Promise<WorkflowSignal | null>
  /**
   * Optional: the receipt with this id for this instance (pending or consumed), or null. The dispatcher hands the
   * receipt named by `instance.resumeSignalId` to the resumed step as `context.signal`.
   */
  getSignalById?(instanceId: string, signalId: string): Promise<WorkflowSignal | null>
}
