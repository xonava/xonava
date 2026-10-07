import { describe, expect, it, vi } from "vitest"
import { dispatchWorkflows } from "../workflowDispatcher"
import { createWorkflowRegistry } from "../workflowRegistry"
import type { WorkflowStore } from "../store"
import { ConfigurationError } from "../../domain/errors"

const MAX_TIMER_DELAY_MS = 2_147_483_647

function options(leaseDurationMs: number) {
  const store = { claimDue: vi.fn(async () => []), assertLease: vi.fn(async () => true), renewLease: vi.fn(async () => true), commit: vi.fn(async () => true) } as unknown as WorkflowStore
  return { store, registry: createWorkflowRegistry(), workerId: "worker", claimLimit: 1, leaseDurationMs }
}

describe("workflow dispatcher timer-backed options", () => {
  it("rejects a leaseDurationMs beyond the platform timer limit before claiming", async () => {
    for (const leaseDurationMs of [MAX_TIMER_DELAY_MS + 1, MAX_TIMER_DELAY_MS * 3, Number.MAX_SAFE_INTEGER]) {
      const args = options(leaseDurationMs)
      await expect(dispatchWorkflows(args)).rejects.toBeInstanceOf(ConfigurationError)
      expect(args.store.claimDue).not.toHaveBeenCalled()
    }
  })

  it("accepts a leaseDurationMs at the platform timer limit", async () => {
    await expect(dispatchWorkflows(options(MAX_TIMER_DELAY_MS))).resolves.toMatchObject({ claimed: 0 })
  })
})
