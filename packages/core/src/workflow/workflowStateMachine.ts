import type { WorkflowFailure, WorkflowInstance, WorkflowSignal, WorkflowStepResult } from "./types"
import { WorkflowStateError } from "./workflowErrors"
import { assertWorkflowDurableValue } from "./workflowDefinition"
import { snapshotData } from "../kernel/snapshotData"
import { defaultAuditSanitizer } from "../events/durability/audit"

const terminal = new Set(["succeeded", "failed", "cancelled", "compensation_failed"])
export function isWorkflowTerminal(instance: WorkflowInstance): boolean { return terminal.has(instance.status) }

export const MAX_WORKFLOW_FAILURE_MESSAGE_LENGTH = 512
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
  const sanitized = String(defaultAuditSanitizer(raw))
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

export function applyWorkflowStep(instance: WorkflowInstance, result: WorkflowStepResult, now: Date): WorkflowInstance {
  if (isWorkflowTerminal(instance)) throw new WorkflowStateError("Terminal workflow cannot transition")
  if (result.kind === "fail") {
    const phase = instance.status === "compensating" ? "compensate" : "execute"
    const step = phase === "compensate" ? instance.compensationStack.at(-1) ?? instance.currentStep : instance.currentStep
    const failure = createWorkflowFailure({ code: "STEP_FAILED", message: result.error, step, phase, attempt: instance.stepAttempt, at: now })
    return phase === "compensate" ? failCompensation(instance, failure, now) : enterFailure(instance, failure, now)
  }
  const variables = Object.freeze({ ...instance.variables, ...(result.kind === "retry" ? {} : result.variables ?? {}) })
  assertWorkflowDurableValue(variables)
  const base = { ...instance, ...released, variables, revision: instance.revision + 1, updatedAt: now }
  switch (result.kind) {
    case "next": return seal({ ...base, status: "pending", currentStep: result.step, stepAttempt: 0, compensationStack: result.compensation ? [...instance.compensationStack, result.compensation] : instance.compensationStack, waitingSignal: null, wakeAt: null })
    case "wait": return seal({ ...base, status: "waiting", waitingSignal: result.signal, wakeAt: null })
    case "sleep": return seal({ ...base, status: "waiting", waitingSignal: null, wakeAt: result.wakeAt })
    case "complete": return seal({ ...base, status: "succeeded", outcome: "succeeded", waitingSignal: null, wakeAt: null })
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
 * Resumes a waiting instance. The signal name stays recorded on the pending
 * instance so the dispatcher can hand the delivered signal to the step; the
 * step's next transition clears or replaces it.
 */
export function deliverWorkflowSignal(instance: WorkflowInstance, signal: WorkflowSignal, now: Date): WorkflowInstance {
  if (instance.status !== "waiting" || instance.waitingSignal !== signal.name) throw new WorkflowStateError("Workflow is not waiting for this signal")
  return seal({ ...instance, status: "pending", waitingSignal: signal.name, wakeAt: null, revision: instance.revision + 1, updatedAt: now })
}

export function cancelWorkflow(instance: WorkflowInstance, now: Date): WorkflowInstance {
  if (isWorkflowTerminal(instance)) return instance
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
