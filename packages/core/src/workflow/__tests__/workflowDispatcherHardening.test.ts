import { describe, expect, it, vi } from "vitest"
import { defineWorkflow } from "../workflowDefinition"
import { dispatchWorkflows, type WorkflowDispatcherClock } from "../workflowDispatcher"
import { createWorkflowRegistry } from "../workflowRegistry"
import type { WorkflowInstance } from "../types"
import type { WorkflowStore } from "../store"

const instant = new Date("2026-09-25T00:00:00.000Z")

function workflowInstance(): WorkflowInstance {
  return { id: "wf", workflowType: "order", workflowVersion: 1, executionScope: { kind: "tenant", tenantId: "t1" }, status: "running", currentStep: "run", variables: {}, stepAttempt: 1, compensationStack: [], waitingSignal: null, wakeAt: null, outcome: null, revision: 1, leaseOwner: "worker", claimToken: "token", leaseExpiresAt: new Date(instant.getTime() + 1_000), createdAt: instant, updatedAt: instant }
}

class ManualClock implements WorkflowDispatcherClock {
  readonly timers = new Map<number, { at: number; callback: () => void }>()
  #id = 0
  #now = instant.getTime()
  now(): Date { return new Date(this.#now) }
  setTimeout(callback: () => void, ms: number): unknown { const id = ++this.#id; this.timers.set(id, { at: this.#now + ms, callback }); return id }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number) }
  advance(ms: number): void {
    this.#now += ms
    for (const [id, timer] of [...this.timers]) if (timer.at <= this.#now) { this.timers.delete(id); timer.callback() }
  }
}

function setup(execute: Parameters<typeof defineWorkflow>[0]["steps"][string]["execute"], renewLease = vi.fn(async () => true)) {
  const registry = createWorkflowRegistry()
  registry.register(defineWorkflow({ type: "order", version: 1, initialStep: "run", steps: { run: { name: "run", datasource: "primary", execute } }, decodeVariables: value => value as Record<string, unknown> }))
  const instance = workflowInstance()
  const commit = vi.fn(async () => true)
  const store = {
    claimDue: vi.fn(async () => [{ instance, workerId: "worker", claimToken: "token" }]),
    assertLease: vi.fn(async () => true),
    renewLease,
    commit,
  } as unknown as WorkflowStore
  return { registry, store, commit, renewLease }
}

describe("workflow dispatcher lifecycle hardening", () => {
  it("aborts a step at its deadline and does not commit", async () => {
    const clock = new ManualClock()
    let started!: () => void
    const stepStarted = new Promise<void>(resolve => { started = resolve })
    const { registry, store, commit } = setup(async context => {
      started()
      await new Promise<void>(resolve => context.executionSignal.addEventListener("abort", () => resolve(), { once: true }))
      return { kind: "complete" }
    })
    const dispatch = dispatchWorkflows({ store, registry, workerId: "worker", claimLimit: 1, leaseDurationMs: 300, stepTimeoutMs: 10, clock })
    await stepStarted
    clock.advance(10)

    await expect(dispatch).resolves.toMatchObject({ failed: 1, advanced: 0, leaseLost: 0 })
    expect(commit).not.toHaveBeenCalled()
    expect(clock.timers.size).toBe(0)
  })

  it("shares one renewal between a step fence and the heartbeat", async () => {
    const clock = new ManualClock()
    let calls = 0
    let active = 0
    let maxActive = 0
    let release!: () => void
    const renewLease = vi.fn(async () => {
      calls++
      active++
      maxActive = Math.max(maxActive, active)
      if (calls === 2) await new Promise<void>(resolve => { release = resolve })
      active--
      return true
    })
    let fenceStarted!: () => void
    const started = new Promise<void>(resolve => { fenceStarted = resolve })
    const { registry, store } = setup(async context => {
      const fence = context.assertLease()
      fenceStarted()
      await fence
      return { kind: "complete" }
    }, renewLease)
    const dispatch = dispatchWorkflows({ store, registry, workerId: "worker", claimLimit: 1, leaseDurationMs: 300, clock })
    await started
    clock.advance(100)
    await Promise.resolve()
    expect(renewLease).toHaveBeenCalledTimes(2)
    release()

    await expect(dispatch).resolves.toMatchObject({ advanced: 1, leaseLost: 0 })
    expect(maxActive).toBe(1)
    expect(clock.timers.size).toBe(0)
  })

  it("rejects excessive claim batches before executing them", async () => {
    const execute = vi.fn(async () => ({ kind: "complete" as const }))
    const { registry, store } = setup(execute)
    store.claimDue = vi.fn(async () => [
      { instance: workflowInstance(), workerId: "worker", claimToken: "one" },
      { instance: workflowInstance(), workerId: "worker", claimToken: "two" },
    ])

    await expect(dispatchWorkflows({ store, registry, workerId: "worker", claimLimit: 1, leaseDurationMs: 300 })).rejects.toThrow(/claim batch/)
    expect(execute).not.toHaveBeenCalled()
  })

  it("fails closed when the initial lease renewal never settles", async () => {
    const clock = new ManualClock()
    const execute = vi.fn(async () => ({ kind: "complete" as const }))
    const { registry, store } = setup(execute, vi.fn(() => new Promise<boolean>(() => undefined)))
    const dispatch = dispatchWorkflows({ store, registry, workerId: "worker", claimLimit: 1, leaseDurationMs: 300, clock })
    await Promise.resolve()
    await Promise.resolve()
    clock.advance(150)

    await expect(dispatch).resolves.toMatchObject({ leaseLost: 1, advanced: 0 })
    expect(execute).not.toHaveBeenCalled()
    expect(clock.timers.size).toBe(0)
  })
})
