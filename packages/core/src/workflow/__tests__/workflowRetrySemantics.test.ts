import { describe, expect, it, vi } from "vitest"
import { defineWorkflow } from "../workflowDefinition"
import { dispatchWorkflows, type WorkflowDispatcherClock, type WorkflowDispatchOptions } from "../workflowDispatcher"
import { createWorkflowRegistry } from "../workflowRegistry"
import { cancelWorkflow, completeCompensation, createWorkflowFailure, isWorkflowTerminal, applyWorkflowStep, deliverWorkflowSignal } from "../workflowStateMachine"
import { WorkflowDefinitionError } from "../workflowErrors"
import type { WorkflowClaim, WorkflowInstance, WorkflowSignal, WorkflowStepDefinition, WorkflowStepResult } from "../types"
import type { WorkflowFence, WorkflowStore } from "../store"
import { RetryablePersistenceError, ValidationError } from "../../domain/errors"
import type { BackoffPolicy } from "../../resilience/backoff"

const start = new Date("2026-10-01T00:00:00.000Z").getTime()

class ManualClock implements WorkflowDispatcherClock {
  readonly timers = new Map<number, { at: number; callback: () => void }>()
  #id = 0
  current = start
  now(): Date { return new Date(this.current) }
  setTimeout(callback: () => void, ms: number): unknown { const id = ++this.#id; this.timers.set(id, { at: this.current + ms, callback }); return id }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number) }
  advance(ms: number): void {
    this.current += ms
    for (const [id, timer] of [...this.timers]) if (timer.at <= this.current) { this.timers.delete(id); timer.callback() }
  }
}

/** Reference in-memory store with the claim semantics required of real stores. */
class MemoryWorkflowStore implements WorkflowStore {
  readonly rows = new Map<string, WorkflowInstance>()
  readonly signals: WorkflowSignal[] = []
  readonly commits: WorkflowInstance[] = []
  #token = 0
  constructor(private readonly clock: ManualClock) {}
  add(instance: Partial<WorkflowInstance> & { id: string; currentStep: string }): void {
    const at = this.clock.now()
    this.rows.set(instance.id, { workflowType: "order", workflowVersion: 1, executionScope: { kind: "tenant", tenantId: "t1" }, status: "pending", variables: {}, stepAttempt: 0, compensationStack: [], waitingSignal: null, wakeAt: null, outcome: null, revision: 0, leaseOwner: null, claimToken: null, leaseExpiresAt: null, createdAt: at, updatedAt: at, failure: null, ...instance })
  }
  async start(): Promise<WorkflowInstance> { throw new Error("unused") }
  async get(id: string) { return this.rows.get(id) ?? null }
  async claimDue(args: { workerId: string; limit: number; leaseDurationMs: number }): Promise<readonly WorkflowClaim[]> {
    const now = this.clock.current
    const due = [...this.rows.values()].filter((row) => (row.status === "pending" || (row.status === "compensating" && (row.wakeAt === null || row.wakeAt.getTime() <= now)) || (row.status === "waiting" && row.wakeAt !== null && row.wakeAt.getTime() <= now)) && (row.leaseExpiresAt === null || row.leaseExpiresAt.getTime() <= now)).slice(0, args.limit)
    return due.map((row) => {
      const claimToken = `token-${++this.#token}`
      const claimed: WorkflowInstance = { ...row, status: row.status === "waiting" ? "pending" : row.status, leaseOwner: args.workerId, claimToken, leaseExpiresAt: new Date(now + args.leaseDurationMs), stepAttempt: row.stepAttempt + 1, revision: row.revision + 1 }
      this.rows.set(row.id, claimed)
      return { instance: claimed, workerId: args.workerId, claimToken }
    })
  }
  #current(fence: WorkflowFence): WorkflowInstance | undefined {
    const row = this.rows.get(fence.instanceId)
    return row && row.leaseOwner === fence.workerId && row.claimToken === fence.claimToken && row.revision === fence.revision && row.leaseExpiresAt !== null && row.leaseExpiresAt.getTime() > this.clock.current ? row : undefined
  }
  async assertLease(fence: WorkflowFence) { return this.#current(fence) !== undefined }
  async renewLease(fence: WorkflowFence, extendByMs: number) {
    const row = this.#current(fence)
    if (!row) return false
    this.rows.set(row.id, { ...row, leaseExpiresAt: new Date(Math.max(row.leaseExpiresAt!.getTime(), this.clock.current + extendByMs)) })
    return true
  }
  async commit(fence: WorkflowFence, next: WorkflowInstance) {
    if (!this.#current(fence)) return false
    const stored = { ...next, revision: next.revision, leaseOwner: null, claimToken: null, leaseExpiresAt: null }
    this.rows.set(next.id, stored)
    this.commits.push(stored)
    return true
  }
  async deliverSignal(signal: Omit<WorkflowSignal, "deliveredAt">) {
    if (this.signals.some((existing) => existing.id === signal.id)) return { delivered: false, duplicate: true }
    const delivered = { ...signal, deliveredAt: this.clock.now() }
    this.signals.push(delivered)
    const row = this.rows.get(signal.instanceId)
    if (row) this.rows.set(row.id, deliverWorkflowSignal(row, delivered, this.clock.now()))
    return { delivered: true, duplicate: false }
  }
  async cancel() { return false }
  async getSignal(instanceId: string, name: string) {
    return [...this.signals].reverse().find((signal) => signal.instanceId === instanceId && signal.name === name) ?? null
  }
}

const fastRetry: BackoffPolicy = { maxAttempts: 3, initialDelayMs: 100, backoffMultiplier: 2, maxDelayMs: 1_000, jitter: "none" }

function harness(steps: Record<string, Omit<WorkflowStepDefinition, "name" | "datasource">>, options: Partial<WorkflowDispatchOptions> = {}) {
  const clock = new ManualClock()
  const store = new MemoryWorkflowStore(clock)
  const registry = createWorkflowRegistry()
  const initialStep = Object.keys(steps)[0]!
  registry.register(defineWorkflow({ type: "order", version: 1, initialStep, steps: Object.fromEntries(Object.entries(steps).map(([name, step]) => [name, { name, datasource: "primary", ...step }])), decodeVariables: (value) => value as Record<string, unknown> }))
  const dispatch = () => dispatchWorkflows({ store, registry, workerId: "worker", claimLimit: 10, leaseDurationMs: 600, stepTimeoutMs: 50, clock, random: () => 0.5, ...options })
  return { clock, store, registry, dispatch }
}

describe("workflow retry, failure, and compensation semantics", () => {
  it("retries a `retry` result with backoff, then fails with RETRY_EXHAUSTED after maxAttempts", async () => {
    const execute = vi.fn(async (): Promise<WorkflowStepResult> => ({ kind: "retry", error: "inventory busy" }))
    const { clock, store, dispatch } = harness({ reserve: { execute, retry: fastRetry } })
    store.add({ id: "wf", currentStep: "reserve" })

    await expect(dispatch()).resolves.toMatchObject({ claimed: 1, retried: 1 })
    expect(store.rows.get("wf")).toMatchObject({ status: "waiting", stepAttempt: 1, wakeAt: new Date(start + 100) })
    await expect(dispatch()).resolves.toMatchObject({ claimed: 0 })
    clock.current += 100
    await expect(dispatch()).resolves.toMatchObject({ retried: 1 })
    expect(store.rows.get("wf")!.wakeAt).toEqual(new Date(start + 100 + 200))
    clock.current += 200
    await expect(dispatch()).resolves.toMatchObject({ failed: 1 })
    expect(store.rows.get("wf")).toMatchObject({ status: "failed", outcome: "failed", failure: { code: "RETRY_EXHAUSTED", step: "reserve", attempt: 3, phase: "execute" } })
    expect(store.rows.get("wf")!.failure!.message).toContain("inventory busy")
    expect(execute).toHaveBeenCalledTimes(3)
    expect(clock.timers.size).toBe(0)
  })

  it("retries retryable errors but fails non-retryable errors immediately", async () => {
    let calls = 0
    const { clock, store, dispatch } = harness({ reserve: { retry: fastRetry, execute: async () => { calls++; if (calls === 1) throw new RetryablePersistenceError("deadlock"); throw new ValidationError("bad input") } } })
    store.add({ id: "wf", currentStep: "reserve" })
    await expect(dispatch()).resolves.toMatchObject({ retried: 1 })
    clock.current += 100
    await expect(dispatch()).resolves.toMatchObject({ failed: 1 })
    expect(store.rows.get("wf")).toMatchObject({ status: "failed", failure: { code: "VALIDATION_ERROR", message: "bad input", attempt: 2 } })
  })

  it("compensates in reverse order after a failure and finishes `failed`", async () => {
    const order: string[] = []
    const { store, dispatch } = harness({
      charge: { execute: async () => ({ kind: "fail", error: "card declined" }) },
      reserve: { execute: async () => ({ kind: "complete" }), compensate: async () => { order.push("reserve") } },
      ship: { execute: async () => ({ kind: "complete" }), compensate: async () => { order.push("ship") } },
    })
    store.add({ id: "wf", currentStep: "charge", compensationStack: ["reserve", "ship"], stepAttempt: 1 })
    await expect(dispatch()).resolves.toMatchObject({ failed: 1 })
    expect(store.rows.get("wf")).toMatchObject({ status: "compensating", stepAttempt: 0, failure: { code: "STEP_FAILED", message: "card declined" } })
    await expect(dispatch()).resolves.toMatchObject({ compensated: 1 })
    await expect(dispatch()).resolves.toMatchObject({ compensated: 1 })
    expect(order).toEqual(["ship", "reserve"])
    expect(store.rows.get("wf")).toMatchObject({ status: "failed", outcome: "failed", compensationStack: [] })
    await expect(dispatch()).resolves.toMatchObject({ claimed: 0 })
  })

  it("retries a failing compensation with backoff and ends in terminal compensation_failed", async () => {
    const compensate = vi.fn(async () => { throw new Error("refund API down for alice@example.com") })
    const { clock, store, dispatch } = harness({ reserve: { execute: async () => ({ kind: "complete" }), compensate, compensationRetry: { ...fastRetry, maxAttempts: 2 } } })
    store.add({ id: "wf", currentStep: "x", status: "compensating", compensationStack: ["reserve"] })
    await expect(dispatch()).resolves.toMatchObject({ retried: 1 })
    expect(store.rows.get("wf")).toMatchObject({ status: "compensating", wakeAt: new Date(start + 100) })
    await expect(dispatch()).resolves.toMatchObject({ claimed: 0 })
    clock.current += 100
    await expect(dispatch()).resolves.toMatchObject({ failed: 1 })
    const row = store.rows.get("wf")!
    expect(row).toMatchObject({ status: "compensation_failed", outcome: "failed", compensationStack: ["reserve"], failure: { code: "RETRY_EXHAUSTED", phase: "compensate", step: "reserve" } })
    expect(row.failure!.message).not.toContain("alice@example.com")
    expect(isWorkflowTerminal(row)).toBe(true)
    clock.current += 10_000
    await expect(dispatch()).resolves.toMatchObject({ claimed: 0 })
    expect(compensate).toHaveBeenCalledTimes(2)
  })

  it("terminates a poison step that crashes workers before it can report (ATTEMPTS_EXHAUSTED)", async () => {
    const execute = vi.fn(async (): Promise<WorkflowStepResult> => ({ kind: "complete" }))
    const { store, dispatch } = harness({ reserve: { execute, retry: fastRetry } })
    store.add({ id: "wf", currentStep: "reserve", stepAttempt: 3 })
    await expect(dispatch()).resolves.toMatchObject({ failed: 1 })
    expect(execute).not.toHaveBeenCalled()
    expect(store.rows.get("wf")).toMatchObject({ status: "failed", failure: { code: "ATTEMPTS_EXHAUSTED", attempt: 4 } })
  })

  it("retries a timed-out idempotent step but fails a timed-out non-idempotent step", async () => {
    const hang = async (context: { executionSignal: AbortSignal }): Promise<WorkflowStepResult> => {
      await new Promise<void>((resolve) => context.executionSignal.addEventListener("abort", () => resolve(), { once: true }))
      return { kind: "complete" }
    }
    for (const idempotent of [true, false]) {
      const { clock, store, dispatch } = harness({ reserve: { execute: hang, idempotent, retry: fastRetry } })
      store.add({ id: "wf", currentStep: "reserve" })
      const run = dispatch()
      await vi.waitFor(() => expect(clock.timers.size).toBeGreaterThan(0))
      clock.advance(50)
      await expect(run).resolves.toMatchObject(idempotent ? { retried: 1 } : { failed: 1 })
      expect(store.rows.get("wf")!.status).toBe(idempotent ? "waiting" : "failed")
      if (!idempotent) expect(store.rows.get("wf")!.failure!.code).toBe("TIMEOUT")
      expect(clock.timers.size).toBe(0)
    }
  })

  it("never commits while a timed-out step ignores cancellation (stalled)", async () => {
    let finish!: () => void
    const { clock, store, dispatch } = harness({ reserve: { execute: () => new Promise<WorkflowStepResult>((resolve) => { finish = () => resolve({ kind: "complete" }) }) } }, { cancellationGraceMs: 20 })
    store.add({ id: "wf", currentStep: "reserve" })
    const run = dispatch()
    await vi.waitFor(() => expect(clock.timers.size).toBeGreaterThan(0))
    clock.advance(50)
    await vi.waitFor(() => expect([...clock.timers.values()].some((timer) => timer.at === clock.current + 20)).toBe(true))
    clock.advance(20)
    await expect(run).resolves.toMatchObject({ stalled: 1, failed: 0 })
    expect(store.commits).toHaveLength(0)
    expect(clock.timers.size).toBe(0)
    finish()
  })

  it("hands the resuming signal payload to the step", async () => {
    const seen: unknown[] = []
    const { store, dispatch } = harness({
      approve: { execute: async (context) => { seen.push(context.signal); if (!context.signal) return { kind: "wait", signal: "decision" }; return { kind: "complete", variables: { approvedBy: context.signal.payload.actor } } } },
    })
    store.add({ id: "wf", currentStep: "approve" })
    await expect(dispatch()).resolves.toMatchObject({ advanced: 1 })
    expect(store.rows.get("wf")).toMatchObject({ status: "waiting", waitingSignal: "decision" })
    await store.deliverSignal({ id: "sig-1", instanceId: "wf", name: "decision", payload: { actor: "manager-7" } })
    await expect(dispatch()).resolves.toMatchObject({ advanced: 1 })
    expect(store.rows.get("wf")).toMatchObject({ status: "succeeded", variables: { approvedBy: "manager-7" }, waitingSignal: null })
    expect(seen[1]).toMatchObject({ id: "sig-1", name: "decision", payload: { actor: "manager-7" } })
    expect(Object.isFrozen((seen[1] as WorkflowSignal).payload)).toBe(true)
  })

  it("defers an unknown definition version without consuming an attempt", async () => {
    const { store, dispatch } = harness({ reserve: { execute: async () => ({ kind: "complete" }) } })
    store.add({ id: "wf", currentStep: "reserve", workflowVersion: 2, stepAttempt: 2 })
    await expect(dispatch()).resolves.toMatchObject({ deferred: 1 })
    expect(store.rows.get("wf")).toMatchObject({ status: "waiting", stepAttempt: 2, wakeAt: new Date(start + 600) })
  })

  it("fails invalid step results and undefined steps without retrying", async () => {
    const { store, dispatch } = harness({ reserve: { execute: async () => ({ kind: "bogus" }) as unknown as WorkflowStepResult } })
    store.add({ id: "a", currentStep: "reserve" })
    store.add({ id: "b", currentStep: "missing" })
    await expect(dispatch()).resolves.toMatchObject({ failed: 2 })
    expect(store.rows.get("a")!.failure!.code).toBe("INVALID_STEP_RESULT")
    expect(store.rows.get("b")!.failure!.code).toBe("STEP_NOT_DEFINED")
  })

  it("runs claims with bounded concurrency", async () => {
    let active = 0
    let peak = 0
    const releases: (() => void)[] = []
    const { store, dispatch } = harness({ reserve: { execute: async () => { active++; peak = Math.max(peak, active); await new Promise<void>((resolve) => releases.push(resolve)); active--; return { kind: "complete" } } } }, { concurrency: 3, stepTimeoutMs: 10_000 })
    for (let index = 0; index < 7; index++) store.add({ id: `wf-${index}`, currentStep: "reserve" })
    const run = dispatch()
    for (let released = 0; released < 7;) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0))
      releases.shift()!()
      released++
    }
    await expect(run).resolves.toMatchObject({ claimed: 7, advanced: 7 })
    expect(peak).toBe(3)
  })

  it("rejects invalid dispatcher options as configuration errors", async () => {
    const { dispatch } = harness({ reserve: { execute: async () => ({ kind: "complete" }) } })
    await expect(dispatch.call(null)).resolves.toBeDefined()
    const { store, registry } = harness({ reserve: { execute: async () => ({ kind: "complete" }) } })
    for (const bad of [{ concurrency: 0 }, { concurrency: 11 }, { cancellationGraceMs: -1 }, { cancellationGraceMs: 60_001 }, { workerId: " " }]) {
      await expect(dispatchWorkflows({ store, registry, workerId: "w", claimLimit: 10, leaseDurationMs: 600, ...bad })).rejects.toBeInstanceOf(WorkflowDefinitionError)
    }
  })
})

describe("workflow state machine records", () => {
  const at = new Date(start)
  const base = { id: "wf", workflowType: "order", workflowVersion: 1, executionScope: { kind: "tenant" as const, tenantId: "t1" }, status: "pending" as const, currentStep: "pay", variables: {}, stepAttempt: 2, compensationStack: ["reserve"], waitingSignal: null, wakeAt: null, outcome: null, revision: 1, leaseOwner: "w", claimToken: "t", leaseExpiresAt: at, createdAt: at, updatedAt: at }

  it("bounds and sanitizes failure records", () => {
    const failure = createWorkflowFailure({ code: "lower case", message: `call 555-123-4567 ${"x".repeat(2_000)}`, step: "pay", phase: "execute", attempt: -1, at })
    expect(failure.code).toBe("STEP_ERROR")
    expect(failure.message).not.toContain("555-123-4567")
    expect(Array.from(failure.message)).toHaveLength(512)
    expect(failure.attempt).toBe(0)
    expect(Object.isFrozen(failure)).toBe(true)
  })

  it("cancellation compensates and finishes `cancelled`", () => {
    const cancelling = cancelWorkflow(base, at)
    expect(cancelling).toMatchObject({ status: "compensating", stepAttempt: 0, failure: { code: "CANCELLED" } })
    expect(completeCompensation(cancelling, at)).toMatchObject({ status: "cancelled", outcome: "cancelled" })
  })

  it("a `fail` on a compensating instance can no longer loop", () => {
    const compensating = { ...base, status: "compensating" as const }
    expect(applyWorkflowStep(compensating, { kind: "fail", error: "refund failed" }, at)).toMatchObject({ status: "compensation_failed", outcome: "failed", failure: { phase: "compensate", step: "reserve" } })
  })
})
