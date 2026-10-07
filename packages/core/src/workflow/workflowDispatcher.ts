import type { WorkflowFence, WorkflowStore } from "../workflow/store"
import { applyWorkflowStep, completeCompensation, createWorkflowFailure, failCompensation, failWorkflowStep, scheduleWorkflowRetry } from "./workflowStateMachine"
import { createWorkflowContext } from "./workflowContext"
import { WorkflowDefinitionError, WorkflowLeaseLostError, WorkflowStateError, WorkflowVersionError } from "./workflowErrors"
import type { WorkflowRegistry } from "./workflowRegistry"
import type { WorkflowDefinition, WorkflowInstance, WorkflowSignal, WorkflowStepDefinition, WorkflowStepResult } from "./types"
import { TimeoutError } from "../domain/errors"
import { canRetryAfter, computeBackoffDelayMs, DEFAULT_BACKOFF_POLICY, type BackoffPolicy } from "../resilience/backoff"

export const DEFAULT_WORKFLOW_STEP_TIMEOUT_MS = 30_000
export const MAX_WORKFLOW_STEP_TIMEOUT_MS = 300_000
export const MAX_WORKFLOW_CLAIM_LIMIT = 100
export const DEFAULT_WORKFLOW_CANCELLATION_GRACE_MS = 5_000
export const MAX_WORKFLOW_CANCELLATION_GRACE_MS = 60_000

export interface WorkflowDispatcherClock {
  now(): Date
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/**
 * Per-batch outcome counts.
 * - advanced / compensated: a step or compensation step committed its transition
 * - retried: a retry was scheduled with backoff
 * - failed: a failure transition was committed, or the claim could not run
 * - deferred: this worker has no definition for the instance's version and handed it back
 * - stalled: a timed-out step ignored cancellation; nothing was committed and the lease lapses
 * - leaseLost: the claim was lost to another worker
 */
export interface WorkflowDispatchResult { claimed: number; advanced: number; compensated: number; retried: number; deferred: number; stalled: number; leaseLost: number; failed: number }

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
  /** Claims executed concurrently within one batch (1..claimLimit, default 1). */
  concurrency?: number
  /** How long a timed-out step may take to honour cancellation before it is treated as stalled (default 5s). */
  cancellationGraceMs?: number
  /** Source of jitter in [0, 1); injectable for deterministic tests. */
  random?: () => number
}

const systemClock: WorkflowDispatcherClock = {
  now: () => new Date(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const STEP_RESULT_KINDS = new Set(["next", "wait", "sleep", "complete", "retry", "fail"])

function validateOptions(args: WorkflowDispatchOptions): void {
  if (typeof args.workerId !== "string" || !args.workerId.trim()) throw new WorkflowDefinitionError("Workflow workerId must be non-empty")
  if (!Number.isSafeInteger(args.claimLimit) || args.claimLimit < 1 || args.claimLimit > MAX_WORKFLOW_CLAIM_LIMIT) throw new WorkflowDefinitionError(`Workflow claimLimit must be between 1 and ${MAX_WORKFLOW_CLAIM_LIMIT}`)
  if (!Number.isSafeInteger(args.leaseDurationMs) || args.leaseDurationMs < 3) throw new WorkflowDefinitionError("Workflow leaseDurationMs must be a safe integer of at least 3")
  const timeout = args.stepTimeoutMs ?? DEFAULT_WORKFLOW_STEP_TIMEOUT_MS
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_WORKFLOW_STEP_TIMEOUT_MS) throw new WorkflowDefinitionError(`Workflow stepTimeoutMs must be between 1 and ${MAX_WORKFLOW_STEP_TIMEOUT_MS}`)
  const concurrency = args.concurrency ?? 1
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > args.claimLimit) throw new WorkflowDefinitionError("Workflow concurrency must be between 1 and claimLimit")
  const grace = args.cancellationGraceMs ?? DEFAULT_WORKFLOW_CANCELLATION_GRACE_MS
  if (!Number.isSafeInteger(grace) || grace < 0 || grace > MAX_WORKFLOW_CANCELLATION_GRACE_MS) throw new WorkflowDefinitionError(`Workflow cancellationGraceMs must be between 0 and ${MAX_WORKFLOW_CANCELLATION_GRACE_MS}`)
  if (args.random !== undefined && typeof args.random !== "function") throw new WorkflowDefinitionError("Workflow random must be a function")
  if (args.signal !== undefined && !(args.signal instanceof AbortSignal)) throw new WorkflowDefinitionError("Workflow signal must be an AbortSignal")
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
    const tracked: Promise<void> = operation.then(
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

type ClaimOutcome = "advanced" | "compensated" | "retried" | "deferred" | "stalled" | "failed" | "lease-lost"

/** Errors that may succeed on another attempt: framework-retryable errors and errors tagged `kind: "retryable"`. */
function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const candidate = error as { retryable?: unknown; kind?: unknown }
  return candidate.retryable === true || candidate.kind === "retryable"
}

function errorCode(error: unknown, fallback: string): string {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined
  return typeof code === "string" ? code : fallback
}

function isValidSignal(value: unknown, instanceId: string, name: string): value is WorkflowSignal {
  if (!value || typeof value !== "object") return false
  const signal = value as Partial<WorkflowSignal>
  return signal.instanceId === instanceId && signal.name === name && typeof signal.id === "string" &&
    !!signal.payload && typeof signal.payload === "object" && !Array.isArray(signal.payload) &&
    signal.deliveredAt instanceof Date && Number.isFinite(signal.deliveredAt.getTime())
}

function isStepResult(value: unknown): value is WorkflowStepResult {
  return !!value && typeof value === "object" && STEP_RESULT_KINDS.has(String((value as { kind?: unknown }).kind))
}

/** Waits up to `ms` for work to settle without leaving timers behind. */
function waitForSettlement(work: Promise<unknown>, isSettled: () => boolean, ms: number, clock: WorkflowDispatcherClock): Promise<boolean> {
  if (isSettled()) return Promise.resolve(true)
  if (ms === 0) return Promise.resolve(false)
  return new Promise((resolve) => {
    let done = false
    const finish = (settled: boolean): void => {
      if (done) return
      done = true
      clock.clearTimeout(handle)
      resolve(settled)
    }
    const handle = clock.setTimeout(() => finish(isSettled()), ms)
    work.then(() => finish(true), () => finish(true))
  })
}

async function runClaim(args: WorkflowDispatchOptions, instance: WorkflowInstance, fence: WorkflowFence, clock: WorkflowDispatcherClock, now: () => Date): Promise<ClaimOutcome> {
  const controller = new AbortController()
  const parent = args.signal
  const onParentAbort = (): void => controller.abort(parent?.reason)
  if (parent?.aborted) return "failed"
  parent?.addEventListener("abort", onParentAbort, { once: true })
  const timeoutMs = args.stepTimeoutMs ?? DEFAULT_WORKFLOW_STEP_TIMEOUT_MS
  const graceMs = args.cancellationGraceMs ?? DEFAULT_WORKFLOW_CANCELLATION_GRACE_MS
  let timedOut = false
  let timeout: unknown
  const cancellation = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })
    timeout = clock.setTimeout(() => { timedOut = true; controller.abort(new TimeoutError("Workflow step deadline exceeded")) }, timeoutMs)
  })
  void cancellation.catch(() => undefined)
  const lifecycle = startLeaseLifecycle({ store: args.store, fence, leaseDurationMs: args.leaseDurationMs, clock, controller })
  // Step work is bounded by the deadline, cancellation, and lease loss.
  const bounded = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, cancellation, lifecycle.lost])
  // Durable transitions are bounded by lease loss only: a step that finished
  // must still be able to commit even if its deadline fires meanwhile.
  const fenced = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, lifecycle.lost])

  let commitAttempted = false
  const commit = async (next: WorkflowInstance, outcome: ClaimOutcome): Promise<ClaimOutcome> => {
    await fenced(lifecycle.assertHeld())
    commitAttempted = true
    return await fenced(args.store.commit(fence, next)) ? outcome : "lease-lost"
  }

  const phase: "execute" | "compensate" = instance.status === "compensating" ? "compensate" : "execute"
  const stepName = phase === "compensate" ? instance.compensationStack.at(-1) ?? "" : instance.currentStep
  const attempt = Math.max(1, instance.stepAttempt)
  let policy: BackoffPolicy = DEFAULT_BACKOFF_POLICY
  let step: WorkflowStepDefinition | undefined
  let work: Promise<unknown> | undefined
  let workSettled = false

  const failOrRetry = async (retryable: boolean, code: string, message: unknown): Promise<ClaimOutcome> => {
    const at = validNow(now)
    if (retryable && canRetryAfter(policy, attempt)) {
      const wakeAt = new Date(at.getTime() + computeBackoffDelayMs(policy, attempt, args.random))
      return commit(scheduleWorkflowRetry(instance, wakeAt, at), "retried")
    }
    const failure = createWorkflowFailure({ code: retryable ? "RETRY_EXHAUSTED" : code, message: retryable ? `${code}: ${typeof message === "string" ? message : message instanceof Error ? message.message : "retry exhausted"}` : message, step: stepName, phase, attempt, at })
    return commit(phase === "compensate" ? failCompensation(instance, failure, at) : failWorkflowStep(instance, failure, at), "failed")
  }

  try {
    await bounded(lifecycle.assertHeld())
    let definition: WorkflowDefinition
    let variables: Readonly<Record<string, unknown>>
    try {
      ({ definition, variables } = args.registry.decode(instance.workflowType, instance.workflowVersion, instance.variables))
    } catch (error) {
      if (error instanceof WorkflowVersionError) {
        // This worker does not know this definition version (for example during
        // a rolling deploy). Hand the instance back without consuming an attempt.
        const at = validNow(now)
        const deferred = { ...instance, stepAttempt: Math.max(0, instance.stepAttempt - 1) }
        return await commit(scheduleWorkflowRetry(deferred, new Date(at.getTime() + args.leaseDurationMs), at), "deferred")
      }
      return await failOrRetry(false, "DECODE_FAILED", error)
    }
    step = definition.steps[stepName]
    if (!step || (phase === "compensate" && typeof step.compensate !== "function")) {
      return await failOrRetry(false, "STEP_NOT_DEFINED", `Workflow ${phase === "compensate" ? "compensation " : ""}step is not defined: ${stepName}`)
    }
    policy = (phase === "compensate" ? step.compensationRetry : step.retry) ?? DEFAULT_BACKOFF_POLICY
    if (attempt > policy.maxAttempts) {
      // Crashed, hung, or stalled attempts are counted by the store at claim
      // time, so a poison step terminates here instead of looping forever.
      return await failOrRetry(false, "ATTEMPTS_EXHAUSTED", `Attempt ${attempt} exceeds maxAttempts ${policy.maxAttempts}`)
    }
    let signal: WorkflowSignal | undefined
    if (phase === "execute" && instance.waitingSignal !== null && typeof args.store.getSignal === "function") {
      const delivered = await bounded(args.store.getSignal(instance.id, instance.waitingSignal))
      if (isValidSignal(delivered, instance.id, instance.waitingSignal)) signal = delivered
    }
    const context = createWorkflowContext({
      instanceId: instance.id, executionScope: instance.executionScope, attempt, variables,
      ...(signal !== undefined ? { signal } : {}),
      datasource: step.datasource, executionSignal: controller.signal, deadline: validNow(now).getTime() + timeoutMs, assertLease: lifecycle.assertHeld,
    })
    const current = step
    work = phase === "compensate"
      ? Promise.resolve().then(() => current.compensate!(context))
      : Promise.resolve().then(() => current.execute(context))
    work.then(() => { workSettled = true }, () => { workSettled = true })
    const result = await bounded(work)
    if (phase === "compensate") return await commit(completeCompensation(instance, validNow(now)), "compensated")
    if (!isStepResult(result)) return await failOrRetry(false, "INVALID_STEP_RESULT", "Workflow step returned an invalid result")
    if (result.kind === "retry") return await failOrRetry(true, "STEP_RETRY", result.error)
    if (result.kind === "fail") return await failOrRetry(false, "STEP_FAILED", result.error)
    return await commit(applyWorkflowStep(instance, result, validNow(now)), "advanced")
  } catch (error) {
    if (error instanceof WorkflowLeaseLostError) return "lease-lost"
    if (commitAttempted) return "failed"
    if (parent?.aborted) return "failed"
    try {
      if (timedOut) {
        const settled = work === undefined || await waitForSettlement(work, () => workSettled, graceMs, clock)
        // Never record a failure (and start compensating) while the step may
        // still be running. Its lease lapses; the next claim counts the attempt.
        if (!settled) return "stalled"
        const retryable = step?.idempotent === true || phase === "compensate"
        return await failOrRetry(retryable, "TIMEOUT", "Workflow step deadline exceeded")
      }
      if (controller.signal.aborted) return "failed"
      // Compensation is must-complete work: every compensation error is retried
      // under its policy before the instance stops in compensation_failed.
      return await failOrRetry(phase === "compensate" || isRetryableError(error), errorCode(error, "STEP_ERROR"), error)
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
  const result: WorkflowDispatchResult = { claimed: 0, advanced: 0, compensated: 0, retried: 0, deferred: 0, stalled: 0, leaseLost: 0, failed: 0 }
  if (args.signal?.aborted) return result
  const claims = await args.store.claimDue({ workerId: args.workerId, limit: args.claimLimit, leaseDurationMs: args.leaseDurationMs, now: validNow(now) })
  if (!Array.isArray(claims) || claims.length > args.claimLimit) throw new WorkflowStateError("Workflow store returned an invalid claim batch")
  result.claimed = claims.length
  let next = 0
  let started = 0
  const worker = async (): Promise<void> => {
    while (next < claims.length && !args.signal?.aborted) {
      const claim = claims[next++]!
      started++
      const instance = claim.instance
      const fence = { instanceId: instance.id, workerId: claim.workerId, claimToken: claim.claimToken, revision: instance.revision }
      let outcome: ClaimOutcome
      try { outcome = await runClaim(args, instance, fence, clock, now) } catch { outcome = "failed" }
      if (outcome === "advanced") result.advanced++
      else if (outcome === "compensated") result.compensated++
      else if (outcome === "retried") result.retried++
      else if (outcome === "deferred") result.deferred++
      else if (outcome === "stalled") result.stalled++
      else if (outcome === "lease-lost") result.leaseLost++
      else result.failed++
    }
  }
  const concurrency = Math.min(args.concurrency ?? 1, Math.max(1, claims.length))
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  // Claims never started because the batch was aborted: their leases lapse.
  result.failed += claims.length - started
  return result
}
