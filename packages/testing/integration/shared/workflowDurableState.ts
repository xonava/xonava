import { expect } from "vitest"
import { applyWorkflowStep, createWorkflowRegistry, defineWorkflow, dispatchWorkflows, type WorkflowStepContext, type WorkflowStepResult, type WorkflowStore } from "@xonava/core/workflow"

const scope = { kind: "tenant", tenantId: "t1" } as const
const decode = (value: unknown) => value as Record<string, unknown>
const step = (name: string, execute: (context: WorkflowStepContext) => Promise<WorkflowStepResult>) => ({ name, datasource: "primary", execute })
const noRetry = { maxAttempts: 1, initialDelayMs: 10, backoffMultiplier: 2, maxDelayMs: 100, jitter: "none" } as const

async function drain(store: WorkflowStore, registry: ReturnType<typeof createWorkflowRegistry>, id: string, workerId: string): Promise<void> {
  for (let index = 0; index < 5; index++) {
    await dispatchWorkflows({ store, registry, workerId, claimLimit: 100, leaseDurationMs: 30_000 })
    const current = await store.get(id)
    if (current?.status !== "pending") return
  }
}

/**
 * Durable-state invariants that every SQL workflow store must preserve:
 * a signal wait does not consume step attempts (also for rows persisted with a
 * count, which the store's signal wake resets), and variables upcast to the
 * running definition are committed with that definition's version.
 */
export async function assertWorkflowDurableState(store: WorkflowStore, prefix: string): Promise<void> {
  // A wait never consumes the step's (single) attempt.
  const waitType = `${prefix}-wait`
  const registry = createWorkflowRegistry()
  registry.register(defineWorkflow({ type: waitType, version: 1, initialStep: "approve", decodeVariables: decode, steps: {
    approve: { ...step("approve", async (context) => context.signal ? { kind: "complete", variables: { approved: true } } : { kind: "wait", signal: "go" }), retry: noRetry },
  } }))
  const waitId = `${prefix}-wait-1`
  await store.start({ id: waitId, workflowType: waitType, workflowVersion: 1, executionScope: scope, initialStep: "approve", variables: {} })
  await drain(store, registry, waitId, `${prefix}-w`)
  expect(await store.get(waitId)).toMatchObject({ status: "waiting", waitingSignal: "go", stepAttempt: 0 })
  expect(await store.deliverSignal({ id: `${prefix}-sig-1`, instanceId: waitId, name: "go", payload: {} })).toMatchObject({ delivered: true })
  await drain(store, registry, waitId, `${prefix}-w`)
  expect(await store.get(waitId)).toMatchObject({ status: "succeeded", variables: { approved: true } })

  // The store's signal wake resets an attempt count persisted by older code.
  const legacyId = `${prefix}-wait-legacy`
  await store.start({ id: legacyId, workflowType: waitType, workflowVersion: 1, executionScope: scope, initialStep: "approve", variables: {} })
  const [claim] = (await store.claimDue({ workerId: `${prefix}-legacy`, limit: 100, leaseDurationMs: 30_000 })).filter((entry) => entry.instance.id === legacyId)
  expect(claim).toBeDefined()
  const fence = { instanceId: legacyId, workerId: claim!.workerId, claimToken: claim!.claimToken, revision: claim!.instance.revision }
  expect(await store.commit(fence, { ...applyWorkflowStep(claim!.instance, { kind: "wait", signal: "go" }, new Date()), stepAttempt: 3 })).toBe(true)
  await store.deliverSignal({ id: `${prefix}-sig-2`, instanceId: legacyId, name: "go", payload: {} })
  expect(await store.get(legacyId)).toMatchObject({ status: "pending", stepAttempt: 0 })
  await drain(store, registry, legacyId, `${prefix}-w`)
  expect(await store.get(legacyId)).toMatchObject({ status: "succeeded" })

  // Upcast variables are persisted together with the running definition version.
  const upcastType = `${prefix}-upcast`
  const seen: unknown[] = []
  const upcasting = createWorkflowRegistry([{ type: upcastType, from: 1, to: 2, upcast: (value) => { const { amount, ...rest } = value as { amount: number }; return { ...rest, amountCents: amount * 100 } } }])
  upcasting.register(defineWorkflow({ type: upcastType, version: 1, initialStep: "a", decodeVariables: decode, steps: { a: step("a", async () => ({ kind: "complete" })) } }))
  upcasting.register(defineWorkflow({ type: upcastType, version: 2, initialStep: "a", decodeVariables: decode, steps: {
    a: step("a", async () => ({ kind: "next", step: "b", variables: { amountCents: 600 } })),
    b: step("b", async (context) => { seen.push(context.variables.amountCents); return { kind: "complete" } }),
  } }))
  const upcastId = `${prefix}-upcast-1`
  await store.start({ id: upcastId, workflowType: upcastType, workflowVersion: 1, executionScope: scope, initialStep: "a", variables: { amount: 5 } })
  await dispatchWorkflows({ store, registry: upcasting, workerId: `${prefix}-u`, claimLimit: 100, leaseDurationMs: 30_000 })
  const advanced = await store.get(upcastId)
  expect(advanced).toMatchObject({ workflowVersion: 2, currentStep: "b", variables: { amountCents: 600 } })
  expect(advanced!.variables).not.toHaveProperty("amount")
  await drain(store, upcasting, upcastId, `${prefix}-u`)
  expect(seen).toEqual([600])
  expect(await store.get(upcastId)).toMatchObject({ status: "succeeded" })
}
