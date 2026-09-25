import type { WorkflowInstance, WorkflowSignal, WorkflowStepResult } from "./types"
import { WorkflowStateError } from "./workflowErrors"
import { assertWorkflowDurableValue } from "./workflowDefinition"
import { snapshotData } from "../kernel/snapshotData"

const terminal = new Set(["succeeded", "failed", "cancelled"])
export function isWorkflowTerminal(instance: WorkflowInstance): boolean { return terminal.has(instance.status) }

function seal(instance: WorkflowInstance): WorkflowInstance {
  return snapshotData(instance, { label: "Workflow instance" })
}

export function applyWorkflowStep(instance: WorkflowInstance, result: WorkflowStepResult, now: Date): WorkflowInstance {
  if (isWorkflowTerminal(instance)) throw new WorkflowStateError("Terminal workflow cannot transition")
  const variables = Object.freeze({ ...instance.variables, ...(result.kind === "retry" || result.kind === "fail" ? {} : result.variables ?? {}) })
  assertWorkflowDurableValue(variables)
  const base = { ...instance, variables, revision: instance.revision + 1, updatedAt: now, leaseOwner: null, claimToken: null, leaseExpiresAt: null }
  switch (result.kind) {
    case "next": return seal({ ...base, status: "pending", currentStep: result.step, stepAttempt: 0, compensationStack: result.compensation ? [...instance.compensationStack, result.compensation] : instance.compensationStack, waitingSignal: null, wakeAt: null })
    case "wait": return seal({ ...base, status: "waiting", waitingSignal: result.signal, wakeAt: null })
    case "sleep": return seal({ ...base, status: "waiting", waitingSignal: null, wakeAt: result.wakeAt })
    case "complete": return seal({ ...base, status: "succeeded", outcome: "succeeded", waitingSignal: null, wakeAt: null })
    case "retry": return seal({ ...base, status: "pending", stepAttempt: instance.stepAttempt + 1 })
    case "fail": return seal({ ...base, status: instance.compensationStack.length ? "compensating" : "failed", outcome: instance.compensationStack.length ? null : "failed" })
  }
}

export function deliverWorkflowSignal(instance: WorkflowInstance, signal: WorkflowSignal, now: Date): WorkflowInstance {
  if (instance.status !== "waiting" || instance.waitingSignal !== signal.name) throw new WorkflowStateError("Workflow is not waiting for this signal")
  return seal({ ...instance, status: "pending", waitingSignal: null, revision: instance.revision + 1, updatedAt: now })
}

export function cancelWorkflow(instance: WorkflowInstance, now: Date): WorkflowInstance {
  if (isWorkflowTerminal(instance)) return instance
  return seal({ ...instance, status: instance.compensationStack.length ? "compensating" : "cancelled", outcome: instance.compensationStack.length ? null : "cancelled", revision: instance.revision + 1, updatedAt: now, leaseOwner: null, claimToken: null, leaseExpiresAt: null })
}

export function completeCompensation(instance: WorkflowInstance, now: Date): WorkflowInstance {
  if (instance.status !== "compensating") throw new WorkflowStateError("Workflow is not compensating")
  const remaining = instance.compensationStack.slice(0, -1)
  return seal({ ...instance, compensationStack: remaining, status: remaining.length ? "compensating" : "failed", outcome: remaining.length ? null : "failed", revision: instance.revision + 1, updatedAt: now })
}
