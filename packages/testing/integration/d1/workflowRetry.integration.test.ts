import { describe, expect, it } from "vitest"
import { DrizzleD1WorkflowStore } from "@xonava/adapters/drizzle-d1"
import { createWorkflowRegistry, defineWorkflow, dispatchWorkflows, type WorkflowStepResult } from "@xonava/core/workflow"
import { temporaryD1Fixture } from "./database.js"

const noDelay = { maxAttempts: 2, initialDelayMs: 0, backoffMultiplier: 1, maxDelayMs: 0, jitter: "none" as const }

describe("W1 D1 workflow retry, failure, signal, and compensation persistence", () => {
  it("persists the full failure lifecycle through the real store", async () => {
    const fixture = await temporaryD1Fixture()
    try {
      const store = new DrizzleD1WorkflowStore(fixture.db as never)
      const registry = createWorkflowRegistry()
      let refundCalls = 0
      registry.register(defineWorkflow({
        type: "order", version: 1, initialStep: "reserve", decodeVariables: (value) => value as Record<string, unknown>,
        steps: {
          reserve: { name: "reserve", datasource: "primary", execute: async (): Promise<WorkflowStepResult> => ({ kind: "next", step: "approve", compensation: "reserve" }), compensate: async () => { refundCalls++; throw new Error("refund service unavailable") }, compensationRetry: noDelay },
          approve: { name: "approve", datasource: "primary", execute: async (context): Promise<WorkflowStepResult> => context.signal ? { kind: "next", step: "charge", variables: { approver: context.signal.payload.actor } } : { kind: "wait", signal: "decision" } },
          charge: { name: "charge", datasource: "primary", retry: noDelay, execute: async (): Promise<WorkflowStepResult> => ({ kind: "retry", error: "gateway busy" }) },
        },
      }))
      const dispatch = () => dispatchWorkflows({ store, registry, workerId: "w", claimLimit: 5, leaseDurationMs: 30_000 })
      await store.start({ id: "wf", workflowType: "order", workflowVersion: 1, executionScope: { kind: "tenant", tenantId: "t1" }, initialStep: "reserve", variables: {} })

      await expect(dispatch()).resolves.toMatchObject({ advanced: 1 })
      await expect(dispatch()).resolves.toMatchObject({ advanced: 1 })
      expect(await store.get("wf")).toMatchObject({ status: "waiting", waitingSignal: "decision" })
      expect(await store.deliverSignal({ id: "sig-1", instanceId: "wf", name: "decision", payload: { actor: "manager-7" } })).toEqual({ delivered: true, duplicate: false })
      await expect(dispatch()).resolves.toMatchObject({ advanced: 1 })
      expect(await store.get("wf")).toMatchObject({ currentStep: "charge", variables: { approver: "manager-7" }, waitingSignal: null })

      await expect(dispatch()).resolves.toMatchObject({ retried: 1 })
      expect(await store.get("wf")).toMatchObject({ status: "waiting", stepAttempt: 1 })
      await expect(dispatch()).resolves.toMatchObject({ failed: 1 })
      expect(await store.get("wf")).toMatchObject({ status: "compensating", stepAttempt: 0, failure: { code: "RETRY_EXHAUSTED", step: "charge", phase: "execute", attempt: 2 } })

      await expect(dispatch()).resolves.toMatchObject({ retried: 1 })
      await expect(dispatch()).resolves.toMatchObject({ failed: 1 })
      const final = await store.get("wf")
      expect(final).toMatchObject({ status: "compensation_failed", outcome: "failed", compensationStack: ["reserve"], failure: { code: "RETRY_EXHAUSTED", phase: "compensate", step: "reserve" } })
      expect(final!.failure!.at).toBeInstanceOf(Date)
      expect(refundCalls).toBe(2)
      await expect(dispatch()).resolves.toMatchObject({ claimed: 0 })
      expect(await store.cancel("wf")).toBe(false)
    } finally {
      await fixture.close(); await fixture.cleanup()
    }
  })

  it("cancels into compensation with a CANCELLED failure record and a fresh attempt budget", async () => {
    const fixture = await temporaryD1Fixture()
    try {
      const store = new DrizzleD1WorkflowStore(fixture.db as never)
      await store.start({ id: "wf-c", workflowType: "order", workflowVersion: 1, executionScope: { kind: "tenant", tenantId: "t1" }, initialStep: "reserve", variables: {} })
      await fixture.db.prepare("UPDATE framework_workflows SET compensation_stack='[\"reserve\"]', step_attempt=3 WHERE id='wf-c'").run()
      expect(await store.cancel("wf-c")).toBe(true)
      expect(await store.get("wf-c")).toMatchObject({ status: "compensating", stepAttempt: 0, failure: { code: "CANCELLED", step: "reserve", attempt: 3 } })
    } finally {
      await fixture.close(); await fixture.cleanup()
    }
  })
})
