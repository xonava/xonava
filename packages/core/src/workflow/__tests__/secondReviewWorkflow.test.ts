import { describe, expect, it } from "vitest"
import { applyWorkflowStep, cancelWorkflow, deliverWorkflowSignal, scheduleWorkflowRetry } from "../workflowStateMachine"
import { WorkflowStateError } from "../workflowErrors"
import type { WorkflowInstance } from "../types"

const t0 = new Date("2026-10-01T00:00:00.000Z")
const at = (ms: number) => new Date(t0.getTime() + ms)

function instance(overrides: Partial<WorkflowInstance> = {}): WorkflowInstance {
  return { id: "wf", workflowType: "order", workflowVersion: 1, executionScope: { kind: "tenant", tenantId: "t1" }, status: "pending", currentStep: "charge", variables: {}, stepAttempt: 1, compensationStack: [], waitingSignal: null, wakeAt: null, outcome: null, revision: 1, failure: null, leaseOwner: null, claimToken: null, leaseExpiresAt: null, createdAt: t0, updatedAt: t0, ...overrides }
}

describe("cancelWorkflow on a compensating instance (C7)", () => {
  it("is idempotent: keeps the original failure, attempt budget, and failed outcome", () => {
    const running = instance({ compensationStack: ["reserve"] })
    const compensating = applyWorkflowStep(running, { kind: "fail", error: "card declined" }, at(1))
    const retrying = { ...compensating, stepAttempt: 2 }
    expect(retrying).toMatchObject({ status: "compensating", failure: { code: "STEP_FAILED" } })
    const cancelled = cancelWorkflow(retrying, at(2))
    expect(cancelled).toBe(retrying)
    expect(cancelled).toMatchObject({ status: "compensating", stepAttempt: 2, failure: { code: "STEP_FAILED" }, outcome: null })
  })
})

describe("repeated signal during a retry backoff", () => {
  it("rejects delivering the waited-for signal while a retry timer is pending", () => {
    const waiting = applyWorkflowStep(instance(), { kind: "wait", signal: "approved" }, at(1))
    const resumed = deliverWorkflowSignal(waiting, { id: "s1", instanceId: "wf", name: "approved", payload: {}, deliveredAt: at(2) }, at(2))
    const backingOff = scheduleWorkflowRetry(resumed, at(10_000), at(3))
    expect(backingOff).toMatchObject({ status: "waiting", wakeAt: at(10_000) })
    expect(() => deliverWorkflowSignal(backingOff, { id: "s2", instanceId: "wf", name: "approved", payload: {}, deliveredAt: at(4) }, at(4))).toThrow(WorkflowStateError)
  })
})
