import type { WorkflowFence, WorkflowStore } from "../workflow/store"
import { applyWorkflowStep, completeCompensation } from "./workflowStateMachine"
import { createWorkflowContext } from "./workflowContext"
import { WorkflowLeaseLostError, WorkflowStateError } from "./workflowErrors"
import type { WorkflowRegistry } from "./workflowRegistry"
import type { WorkflowInstance, WorkflowStepResult } from "./types"

export const DEFAULT_WORKFLOW_STEP_TIMEOUT_MS = 30_000
export const MAX_WORKFLOW_STEP_TIMEOUT_MS = 300_000
export const MAX_WORKFLOW_CLAIM_LIMIT = 100

export interface WorkflowDispatcherClock {
  now(): Date
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface WorkflowDispatchResult { claimed: number; advanced: number; compensated: number; leaseLost: number; failed: number }

export interface WorkflowDispatchOptions {
  store: WorkflowStore
  registry: WorkflowRegistry
  workerId: string
  claimLimit: number
  leaseDurationMs: number
  /** Retained for compatibility; prefer clock when injecting time. */
  now?: () => Date
  clock?: WorkflowDispatcherClock
  signal?: AbortSignal
  stepTimeoutMs?: number
}

const systemClock: WorkflowDispatcherClock = {
  now: () => new Date(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

function validateOptions(args: WorkflowDispatchOptions): void {
  if (typeof args.workerId !== "string" || !args.workerId.trim()) throw new WorkflowStateError("Workflow workerId must be non-empty")
  if (!Number.isSafeInteger(args.claimLimit) || args.claimLimit < 1 || args.claimLimit > MAX_WORKFLOW_CLAIM_LIMIT) throw new WorkflowStateError(`Workflow claimLimit must be between 1 and ${MAX_WORKFLOW_CLAIM_LIMIT}`)
  if (!Number.isSafeInteger(args.leaseDurationMs) || args.leaseDurationMs < 3) throw new WorkflowStateError("Workflow leaseDurationMs must be a safe integer of at least 3")
  const timeout = args.stepTimeoutMs ?? DEFAULT_WORKFLOW_STEP_TIMEOUT_MS
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_WORKFLOW_STEP_TIMEOUT_MS) throw new WorkflowStateError(`Workflow stepTimeoutMs must be between 1 and ${MAX_WORKFLOW_STEP_TIMEOUT_MS}`)
  if (args.signal !== undefined && !(args.signal instanceof AbortSignal)) throw new WorkflowStateError("Workflow signal must be an AbortSignal")
}

function validNow(now: () => Date): Date {
  const value = now()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new WorkflowStateError("Workflow clock returned an invalid date")
  return new Date(value.getTime())
}

interface LeaseLifecycle {
  readonly lost: Promise<never>
  assertHeld(): Promise<void>
  stop(): Promise<void>
}

function startLeaseLifecycle(args: { store: WorkflowStore; fence: WorkflowFence; leaseDurationMs: number; clock: WorkflowDispatcherClock; controller: AbortController }): LeaseLifecycle {
  let stopped = false
  let leaseLost = false
  let inFlight: Promise<void> | undefined
  let timer: unknown
  let cancelWait: (() => void) | undefined
  let stopPromise: Promise<void> | undefined
  let rejectLost: (error: WorkflowLeaseLostError) => void = () => undefined
  const lost = new Promise<never>((_resolve, reject) => { rejectLost = reject })
  // Always attach an observer, including when a step completes before loss.
  void lost.catch(() => undefined)
  const lose = (): WorkflowLeaseLostError => {
    const error = new WorkflowLeaseLostError()
    if (!leaseLost) {
      leaseLost = true
      args.controller.abort(error)
      rejectLost(error)
    }
    return error
  }
  const assertHeld = (): Promise<void> => {
    if (leaseLost) return Promise.reject(new WorkflowLeaseLostError())
    if (inFlight) return inFlight
    const operation = (async (): Promise<void> => {
      let timeout: unknown
      try {
        const renewal = args.store.renewLease(args.fence, args.leaseDurationMs)
        const renewalTimeout = new Promise<never>((_resolve, reject) => {
          timeout = args.clock.setTimeout(() => reject(new WorkflowLeaseLostError("Workflow lease renewal timed out")), Math.max(1, Math.floor(args.leaseDurationMs / 2)))
        })
        if (!await Promise.race([renewal, renewalTimeout])) throw lose()
      } catch (error) {
        if (!leaseLost) lose()
        throw error instanceof WorkflowLeaseLostError ? error : new WorkflowLeaseLostError()
      } finally {
        if (timeout !== undefined) args.clock.clearTimeout(timeout)
      }
    })()
    let tracked: Promise<void>
    tracked = operation.then(
      () => { if (inFlight === tracked) inFlight = undefined },
      (error: unknown) => { if (inFlight === tracked) inFlight = undefined; throw error },
    )
    inFlight = tracked
    return tracked
  }
  const wait = (): Promise<boolean> => new Promise((resolve) => {
    let settled = false
    const finish = (elapsed: boolean): void => {
      if (settled) return
      settled = true
      timer = undefined
      cancelWait = undefined
      resolve(elapsed)
    }
    timer = args.clock.setTimeout(() => finish(true), Math.max(1, Math.floor(args.leaseDurationMs / 3)))
    cancelWait = () => { if (timer !== undefined) args.clock.clearTimeout(timer); finish(false) }
  })
  const loop = (async (): Promise<void> => {
    while (!stopped && !leaseLost) {
      if (!await wait() || stopped) return
      try { await assertHeld() } catch { return }
    }
  })()
  return {
    lost,
    assertHeld,
    stop: () => {
      if (stopPromise) return stopPromise
      stopped = true
      cancelWait?.()
      stopPromise = loop.then(() => inFlight).then(() => undefined, () => undefined)
      return stopPromise
    },
  }
}

async function runClaim(args: WorkflowDispatchOptions, instance: WorkflowInstance, fence: WorkflowFence, clock: WorkflowDispatcherClock, now: () => Date): Promise<"advanced" | "compensated" | "failed" | "lease-lost"> {
  const controller = new AbortController()
  const parent = args.signal
  const onParentAbort = (): void => controller.abort(parent?.reason)
  if (parent?.aborted) return "failed"
  parent?.addEventListener("abort", onParentAbort, { once: true })
  const timeoutMs = args.stepTimeoutMs ?? DEFAULT_WORKFLOW_STEP_TIMEOUT_MS
  const deadline = validNow(now).getTime() + timeoutMs
  let timeout: unknown
  const cancellation = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })
    timeout = clock.setTimeout(() => controller.abort(new WorkflowStateError("Workflow step deadline exceeded")), timeoutMs)
  })
  void cancellation.catch(() => undefined)
  const lifecycle = startLeaseLifecycle({ store: args.store, fence, leaseDurationMs: args.leaseDurationMs, clock, controller })
  const bounded = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, cancellation, lifecycle.lost])
  let transitionCommitAttempted = false
  try {
    await bounded(lifecycle.assertHeld())
    const decoded = args.registry.decode(instance.workflowType, instance.workflowVersion, instance.variables)
    let transition: "advanced" | "compensated"
    let work: Promise<WorkflowStepResult | void>
    if (instance.status === "compensating") {
      const compensation = instance.compensationStack.at(-1)
      const step = compensation ? decoded.definition.steps[compensation] : undefined
      if (!step?.compensate) throw new WorkflowStateError(`Missing compensation step: ${String(compensation)}`)
      const context = createWorkflowContext({ instanceId: instance.id, executionScope: instance.executionScope, attempt: instance.stepAttempt, variables: decoded.variables, datasource: step.datasource, executionSignal: controller.signal, deadline, assertLease: lifecycle.assertHeld })
      work = Promise.resolve().then(() => step.compensate!(context))
      transition = "compensated"
    } else {
      const step = decoded.definition.steps[instance.currentStep]
      if (!step) throw new WorkflowStateError(`Unknown workflow step: ${instance.currentStep}`)
      const context = createWorkflowContext({ instanceId: instance.id, executionScope: instance.executionScope, attempt: instance.stepAttempt, variables: decoded.variables, datasource: step.datasource, executionSignal: controller.signal, deadline, assertLease: lifecycle.assertHeld })
      work = Promise.resolve().then(() => step.execute(context))
      transition = "advanced"
    }
    const stepResult = await bounded(work)
    await bounded(lifecycle.assertHeld())
    const next = transition === "compensated" ? completeCompensation(instance, validNow(now)) : applyWorkflowStep(instance, stepResult as WorkflowStepResult, validNow(now))
    transitionCommitAttempted = true
    return await bounded(args.store.commit(fence, next)) ? transition : "lease-lost"
  } catch (error) {
    if (error instanceof WorkflowLeaseLostError) return "lease-lost"
    if (controller.signal.aborted) return "failed"
    if (transitionCommitAttempted) return "failed"
    try {
      await bounded(lifecycle.assertHeld())
      const next = applyWorkflowStep(instance, { kind: "fail", error: "workflow step failed" }, validNow(now))
      return await bounded(args.store.commit(fence, next)) ? "failed" : "lease-lost"
    } catch (commitError) {
      return commitError instanceof WorkflowLeaseLostError ? "lease-lost" : "failed"
    }
  } finally {
    if (timeout !== undefined) clock.clearTimeout(timeout)
    parent?.removeEventListener("abort", onParentAbort)
    await lifecycle.stop()
  }
}

export async function dispatchWorkflows(args: WorkflowDispatchOptions): Promise<WorkflowDispatchResult> {
  validateOptions(args)
  const clock = args.clock ?? systemClock
  const now = args.now ?? (() => clock.now())
  if (args.signal?.aborted) return { claimed: 0, advanced: 0, compensated: 0, leaseLost: 0, failed: 0 }
  const claims = await args.store.claimDue({ workerId: args.workerId, limit: args.claimLimit, leaseDurationMs: args.leaseDurationMs, now: validNow(now) })
  if (!Array.isArray(claims) || claims.length > args.claimLimit) throw new WorkflowStateError("Workflow store returned an invalid claim batch")
  const result: WorkflowDispatchResult = { claimed: claims.length, advanced: 0, compensated: 0, leaseLost: 0, failed: 0 }
  for (const claim of claims) {
    if (args.signal?.aborted) { result.failed += claims.length - result.advanced - result.compensated - result.leaseLost - result.failed; break }
    const instance = claim.instance
    const fence = { instanceId: instance.id, workerId: claim.workerId, claimToken: claim.claimToken, revision: instance.revision }
    const outcome = await runClaim(args, instance, fence, clock, now)
    if (outcome === "advanced") result.advanced++
    else if (outcome === "compensated") result.compensated++
    else if (outcome === "lease-lost") result.leaseLost++
    else result.failed++
  }
  return result
}
