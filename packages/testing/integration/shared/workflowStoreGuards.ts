import { expect } from "vitest"
import { applyWorkflowStep, cancelWorkflow, scheduleWorkflowRetry, type WorkflowStore } from "@xonava/core/workflow"

async function claimOne(store: WorkflowStore, id: string) {
  const claims = await store.claimDue({ workerId: "guards", limit: 10, leaseDurationMs: 60_000 })
  const claim = claims.find((entry) => entry.instance.id === id)
  expect(claim, `claim ${id}`).toBeDefined()
  return { claim: claim!, fence: { instanceId: id, workerId: "guards", claimToken: claim!.claimToken, revision: claim!.instance.revision } }
}

/**
 * Store-level guards that mirror the pure state machine: cancelling a
 * compensating instance is a no-op, and a repeated signal cannot cut a retry
 * backoff short.
 */
export async function assertWorkflowStoreGuards(store: WorkflowStore, prefix: string): Promise<void> {
  const compensatingId = `${prefix}-compensating`
  await store.start({ id: compensatingId, workflowType: "order", workflowVersion: 1, executionScope: { kind: "tenant", tenantId: "t1" }, initialStep: "reserve", variables: {} })
  const first = await claimOne(store, compensatingId)
  expect(await store.commit(first.fence, applyWorkflowStep(first.claim.instance, { kind: "next", step: "charge", compensation: "release" }, new Date()))).toBe(true)
  const second = await claimOne(store, compensatingId)
  expect(await store.commit(second.fence, cancelWorkflow(second.claim.instance, new Date()))).toBe(true)
  const compensating = await store.get(compensatingId)
  expect(compensating?.status).toBe("compensating")
  expect(await store.cancel(compensatingId)).toBe(false)
  const after = await store.get(compensatingId)
  expect(after?.status).toBe("compensating")
  expect(after?.failure?.code).toBe(compensating?.failure?.code)
  expect(after?.revision).toBe(compensating?.revision)

  const signalId = `${prefix}-signal`
  await store.start({ id: signalId, workflowType: "order", workflowVersion: 1, executionScope: { kind: "tenant", tenantId: "t1" }, initialStep: "approve", variables: {} })
  const waiting = await claimOne(store, signalId)
  expect(await store.commit(waiting.fence, applyWorkflowStep(waiting.claim.instance, { kind: "wait", signal: "approve" }, new Date()))).toBe(true)
  expect(await store.deliverSignal({ id: `${prefix}-sig-1`, instanceId: signalId, name: "approve", payload: {} })).toMatchObject({ delivered: true })
  const resumed = await claimOne(store, signalId)
  const wakeAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 3_600_000)
  expect(await store.commit(resumed.fence, scheduleWorkflowRetry(resumed.claim.instance, wakeAt, new Date()))).toBe(true)
  await store.deliverSignal({ id: `${prefix}-sig-2`, instanceId: signalId, name: "approve", payload: {} })
  const backingOff = await store.get(signalId)
  expect(backingOff?.status).toBe("waiting")
  expect(backingOff?.wakeAt?.getTime()).toBe(wakeAt.getTime())
}
