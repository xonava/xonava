import type { WorkflowFailure, WorkflowInstance, WorkflowSignal, WorkflowStepResult } from "./types"
import { WorkflowStateError } from "./workflowErrors"
import { assertWorkflowDurableValue } from "./workflowDefinition"
import { snapshotData } from "../kernel/snapshotData"
import { defaultAuditSanitizer } from "../events/durability/audit"

const terminal = new Set(["succeeded", "failed", "cancelled", "compensation_failed"])
export function isWorkflowTerminal(instance: WorkflowInstance): boolean { return terminal.has(instance.status) }

export const MAX_WORKFLOW_FAILURE_MESSAGE_LENGTH = 512
/** Longest raw failure text handed to the sanitizer. */
const MAX_SANITIZED_INPUT = 4096

/**
 * When the raw text was cut, its last token may be the head of a contact detail whose tail was cut away: it no longer matches any
 * redaction pattern and would survive. Drop the trailing run of digit/separator characters (a phone number in progress) and then the
 * trailing non-space token (an email address or date in progress).
 */
function dropCutToken(text: string): string {
  let end = text.length
  while (end > 0 && /[\d\s+().-]/.test(text[end - 1]!)) end--
  while (end > 0 && !/\s/.test(text[end - 1]!)) end--
  return text.slice(0, end)
}
/** Stored when the capped text was one long token that had to be dropped whole, so the failure does not read as an empty message. */
const TRUNCATED_WORKFLOW_FAILURE_MESSAGE = "Workflow step failed (message truncated)"
const FAILURE_CODE = /^[A-Z][A-Z0-9_.:-]{0,63}$/

function seal(instance: WorkflowInstance): WorkflowInstance {
  return snapshotData(instance, { label: "Workflow instance" })
}

const released = { leaseOwner: null, claimToken: null, leaseExpiresAt: null } as const

/**
 * Builds a bounded, sanitized failure record. Messages pass through the
 * conservative audit sanitizer (emails, phone numbers, dates redacted) and are
 * truncated on a code-point boundary, so durable workflow state never carries
 * unbounded or obviously sensitive error text. Stack traces are never stored.
 */
export function createWorkflowFailure(args: { code: string; message: unknown; step: string; phase: WorkflowFailure["phase"]; attempt: number; at: Date }): WorkflowFailure {
  const code = typeof args.code === "string" && FAILURE_CODE.test(args.code) ? args.code : "STEP_ERROR"
  const raw = typeof args.message === "string" ? args.message : args.message instanceof Error ? args.message.message : "Workflow step failed"
  // The audit sanitizer's patterns backtrack quadratically on adversarial text (a 100 kB run of "a.a.a." takes tens of seconds), and a
  // step can throw arbitrarily large messages. Only a bounded prefix is ever stored, so only a bounded prefix is sanitized.
  const capped = raw.length > MAX_SANITIZED_INPUT
  const redacted = String(defaultAuditSanitizer(capped ? raw.slice(0, MAX_SANITIZED_INPUT) : raw))
  const trimmed = capped ? dropCutToken(redacted) : redacted
  const sanitized = capped && trimmed.trim() === "" ? TRUNCATED_WORKFLOW_FAILURE_MESSAGE : trimmed
  const characters = Array.from(sanitized)
  const message = characters.length > MAX_WORKFLOW_FAILURE_MESSAGE_LENGTH ? characters.slice(0, MAX_WORKFLOW_FAILURE_MESSAGE_LENGTH).join("") : sanitized
  const attempt = Number.isSafeInteger(args.attempt) && args.attempt >= 0 ? args.attempt : 0
  return Object.freeze({ code, message, step: String(args.step), phase: args.phase, attempt, at: new Date(args.at.getTime()) })
}

/** Moves a failed execution to compensation, or to `failed` when nothing needs compensating. */
function enterFailure(instance: WorkflowInstance, failure: WorkflowFailure, now: Date): WorkflowInstance {
  const compensate = instance.compensationStack.length > 0
  return seal({
    ...instance, ...released,
    status: compensate ? "compensating" : "failed",
    outcome: compensate ? null : "failed",
    stepAttempt: 0, waitingSignal: null, wakeAt: null, failure,
    revision: instance.revision + 1, updatedAt: now,
  })
}

function isDataObject(value: unknown): boolean { return typeof value === "object" && value !== null && !Array.isArray(value) }
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0

/**
 * A malformed result must never reach durable state: a sleep without a valid
 * wake time or a wait without a signal name would leave the instance waiting
 * for a wake-up that can never come (and no store would ever claim it again).
 */
function assertWellFormedResult(result: WorkflowStepResult): void {
  const invalid = (reason: string): never => { throw new WorkflowStateError(`Workflow step returned a malformed ${result.kind} result: ${reason}`) }
  if ("variables" in result && result.variables !== undefined && result.variables !== null && !isDataObject(result.variables)) invalid("variables must be an object")
  if (result.kind === "next") {
    if (!nonEmptyString(result.step)) invalid("step must be a non-empty string")
    // null/undefined/"" mean "no compensation" (the pre-validation behaviour); only a non-string truthy value is malformed.
    const compensation: unknown = result.compensation
    if (compensation !== undefined && compensation !== null && compensation !== "" && typeof compensation !== "string") invalid("compensation must be a string")
  } else if (result.kind === "wait") {
    if (!nonEmptyString(result.signal)) invalid("signal must be a non-empty string")
  } else if (result.kind === "sleep") {
    if (!(result.wakeAt instanceof Date) || Number.isNaN(result.wakeAt.getTime())) invalid("wakeAt must be a valid Date")
  }
}

export function applyWorkflowStep(instance: WorkflowInstance, result: WorkflowStepResult, now: Date): WorkflowInstance {
  if (isWorkflowTerminal(instance)) throw new WorkflowStateError("Terminal workflow cannot transition")
  if (result.kind === "fail") {
    const phase = instance.status === "compensating" ? "compensate" : "execute"
    const step = phase === "compensate" ? instance.compensationStack.at(-1) ?? instance.currentStep : instance.currentStep
    const failure = createWorkflowFailure({ code: "STEP_FAILED", message: result.error, step, phase, attempt: instance.stepAttempt, at: now })
    return phase === "compensate" ? failCompensation(instance, failure, now) : enterFailure(instance, failure, now)
  }
  assertWellFormedResult(result)
  // Compensation only ever fails or retries (completeCompensation finishes a step): a forward result must never
  // resurrect an instance that is undoing its work.
  if (instance.status === "compensating" && result.kind !== "retry") throw new WorkflowStateError(`Compensating workflow cannot apply a ${result.kind} result`)
  const variables = Object.freeze({ ...instance.variables, ...(result.kind === "retry" ? {} : result.variables ?? {}) })
  assertWorkflowDurableValue(variables)
  const base = { ...instance, ...released, variables, revision: instance.revision + 1, updatedAt: now }
  // A forward result is the step succeeding: a failure recorded for an earlier attempt (the stalled-attempt TIMEOUT marker) is spent and
  // must not outlive it. `retry` keeps the record (the step has not succeeded), as do the failure/compensation transitions.
  const forward = { ...base, failure: null }
  switch (result.kind) {
    case "next": return seal({ ...forward, status: "pending", currentStep: result.step, stepAttempt: 0, compensationStack: result.compensation ? [...instance.compensationStack, result.compensation] : instance.compensationStack, waitingSignal: null, wakeAt: null })
    // A durable wait or sleep is a successful step outcome, not a failed
    // attempt: the resumed step starts a fresh attempt budget. Only retries
    // (scheduleWorkflowRetry / `retry`) keep counting.
    case "wait": return seal({ ...forward, status: "waiting", stepAttempt: 0, waitingSignal: result.signal, wakeAt: null })
    case "sleep": return seal({ ...forward, status: "waiting", stepAttempt: 0, waitingSignal: null, wakeAt: result.wakeAt })
    case "complete": return seal({ ...forward, status: "succeeded", outcome: "succeeded", waitingSignal: null, wakeAt: null })
    // An immediate re-run. The attempt counter is advanced by the store when it
    // claims the instance; dispatchers use scheduleWorkflowRetry for backoff.
    case "retry": return seal({ ...base, status: instance.status === "compensating" ? "compensating" : "pending", wakeAt: null })
  }
}

/**
 * Re-runs the current step (or compensation step) no earlier than `wakeAt`.
 * Execution retries wait as `waiting` with a timer and keep the resuming
 * signal; compensation retries stay `compensating` with a timer.
 */
export function scheduleWorkflowRetry(instance: WorkflowInstance, wakeAt: Date, now: Date): WorkflowInstance {
  if (isWorkflowTerminal(instance)) throw new WorkflowStateError("Terminal workflow cannot transition")
  if (!(wakeAt instanceof Date) || Number.isNaN(wakeAt.getTime())) throw new WorkflowStateError("Workflow retry time is invalid")
  const compensating = instance.status === "compensating"
  return seal({ ...instance, ...released, status: compensating ? "compensating" : "waiting", wakeAt, revision: instance.revision + 1, updatedAt: now })
}

/** Fails the current execution step: compensate when there is anything to compensate, else `failed`. */
export function failWorkflowStep(instance: WorkflowInstance, failure: WorkflowFailure, now: Date): WorkflowInstance {
  if (isWorkflowTerminal(instance)) throw new WorkflowStateError("Terminal workflow cannot transition")
  if (instance.status === "compensating") return failCompensation(instance, failure, now)
  return enterFailure(instance, failure, now)
}

/** Compensation exhausted its policy: stop, keep the remaining stack, and require manual intervention. */
export function failCompensation(instance: WorkflowInstance, failure: WorkflowFailure, now: Date): WorkflowInstance {
  if (instance.status !== "compensating") throw new WorkflowStateError("Workflow is not compensating")
  return seal({ ...instance, ...released, status: "compensation_failed", outcome: "failed", wakeAt: null, failure, revision: instance.revision + 1, updatedAt: now })
}

/**
 * Records that the current attempt timed out and ignored cancellation, so it
 * may still be running. The instance waits until `wakeAt` (giving the stalled
 * attempt time to stop) and, for execution, records a TIMEOUT failure for the
 * attempt; the dispatcher then fails a non-idempotent step on its next claim
 * instead of re-running it (see isStalledWorkflowAttempt). Compensation keeps
 * its original failure and is simply retried.
 */
export function markWorkflowAttemptStalled(instance: WorkflowInstance, failure: WorkflowFailure, wakeAt: Date, now: Date): WorkflowInstance {
  const scheduled = scheduleWorkflowRetry(instance, wakeAt, now)
  return instance.status === "compensating" ? scheduled : seal({ ...scheduled, failure })
}

/** Whether an earlier attempt of the instance's current execution step stalled past its deadline. */
export function isStalledWorkflowAttempt(instance: WorkflowInstance): boolean {
  const failure = instance.failure
  return instance.status !== "compensating" && !!failure && failure.code === "TIMEOUT" && failure.phase === "execute" &&
    failure.step === instance.currentStep && failure.attempt >= 1 && failure.attempt < instance.stepAttempt
}

/**
 * Resumes a waiting instance. The signal name stays recorded on the pending
 * instance so the dispatcher can hand the delivered signal to the step; the
 * step's next transition clears or replaces it. An instance waiting on a retry
 * timer (wakeAt set) is not waiting for a signal: it already received it, and a
 * repeated delivery must not skip the backoff.
 */
export function deliverWorkflowSignal(instance: WorkflowInstance, signal: WorkflowSignal, now: Date): WorkflowInstance {
  if (instance.status !== "waiting" || instance.wakeAt !== null || instance.waitingSignal !== signal.name) throw new WorkflowStateError("Workflow is not waiting for this signal")
  // A signal wait never carries a retry count (see applyWorkflowStep), so the
  // resumed step starts from attempt 0 even for instances persisted earlier.
  return seal({ ...instance, status: "pending", stepAttempt: 0, waitingSignal: signal.name, wakeAt: null, revision: instance.revision + 1, updatedAt: now })
}

/**
 * Hands a live claim back without consuming its attempt: the attempt counted
 * when the instance was claimed is returned and the lease is cleared, so the
 * instance is immediately claimable in its current state. Used when a claim is
 * never started or its step stopped cooperatively because the worker is
 * shutting down.
 */
export function releaseWorkflowClaim(instance: WorkflowInstance, now: Date): WorkflowInstance {
  if (isWorkflowTerminal(instance)) throw new WorkflowStateError("Terminal workflow cannot transition")
  return seal({ ...instance, ...released, stepAttempt: Math.max(0, instance.stepAttempt - 1), revision: instance.revision + 1, updatedAt: now })
}

/**
 * Cancels a running instance, compensating completed steps first. Cancelling a
 * terminal or already-compensating instance is a no-op: compensation is
 * already undoing the work, and its original failure, retry budget, and
 * outcome must be preserved.
 */
export function cancelWorkflow(instance: WorkflowInstance, now: Date): WorkflowInstance {
  if (isWorkflowTerminal(instance) || instance.status === "compensating") return instance
  const compensate = instance.compensationStack.length > 0
  const failure = createWorkflowFailure({ code: "CANCELLED", message: "Workflow was cancelled", step: instance.currentStep, phase: "execute", attempt: instance.stepAttempt, at: now })
  return seal({ ...instance, ...released, status: compensate ? "compensating" : "cancelled", outcome: compensate ? null : "cancelled", stepAttempt: 0, waitingSignal: null, wakeAt: null, failure, revision: instance.revision + 1, updatedAt: now })
}

export function completeCompensation(instance: WorkflowInstance, now: Date): WorkflowInstance {
  if (instance.status !== "compensating") throw new WorkflowStateError("Workflow is not compensating")
  const remaining = instance.compensationStack.slice(0, -1)
  const outcome = instance.failure?.code === "CANCELLED" ? "cancelled" : "failed"
  return seal({
    ...instance, ...released,
    compensationStack: remaining,
    status: remaining.length ? "compensating" : outcome,
    outcome: remaining.length ? null : outcome,
    stepAttempt: 0, wakeAt: null,
    revision: instance.revision + 1, updatedAt: now,
  })
}
