import { describe, expect, it, vi } from "vitest"
import { defineWorkflow } from "../workflowDefinition"
import { dispatchWorkflows, type WorkflowDispatcherClock, type WorkflowDispatchOptions } from "../workflowDispatcher"
import { createWorkflowRegistry } from "../workflowRegistry"
import { deliverWorkflowSignal, applyWorkflowStep } from "../workflowStateMachine"
import type { WorkflowClaim, WorkflowInstance, WorkflowSignal, WorkflowStepContext, WorkflowStepDefinition, WorkflowStepResult, WorkflowUpcaster } from "../types"
import type { WorkflowFence, WorkflowStore } from "../store"

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

/** Reference in-memory store: claims count an attempt, commits persist `next` verbatim (like the SQL stores). */
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
  readonly renewLease = vi.fn(async (fence: WorkflowFence, extendByMs: number) => {
    const row = this.#current(fence)
    if (!row) return false
    this.rows.set(row.id, { ...row, leaseExpiresAt: new Date(Math.max(row.leaseExpiresAt!.getTime(), this.clock.current + extendByMs)) })
    return true
  })
  async commit(fence: WorkflowFence, next: WorkflowInstance) {
    if (!this.#current(fence)) return false
    const stored = { ...next, leaseOwner: null, claimToken: null, leaseExpiresAt: null }
    this.rows.set(next.id, stored)
    this.commits.push(stored)
    return true
  }
  async deliverSignal(signal: Omit<WorkflowSignal, "deliveredAt">) {
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

type Steps = Record<string, Omit<WorkflowStepDefinition, "name" | "datasource">>

function harness(steps: Steps, options: Partial<WorkflowDispatchOptions> = {}) {
  const clock = new ManualClock()
  const store = new MemoryWorkflowStore(clock)
  const registry = createWorkflowRegistry()
  const initialStep = Object.keys(steps)[0]!
  registry.register(defineWorkflow({ type: "order", version: 1, initialStep, steps: Object.fromEntries(Object.entries(steps).map(([name, step]) => [name, { name, datasource: "primary", ...step }])), decodeVariables: (value) => value as Record<string, unknown> }))
  const dispatch = (extra: Partial<WorkflowDispatchOptions> = {}) => dispatchWorkflows({ store, registry, workerId: "worker", claimLimit: 10, leaseDurationMs: 600, stepTimeoutMs: 50, clock, random: () => 0.5, ...options, ...extra })
  return { clock, store, registry, dispatch }
}

const single = { maxAttempts: 1, initialDelayMs: 100, backoffMultiplier: 2, maxDelayMs: 1_000, jitter: "none" } as const

describe("durable waits do not consume step attempts", () => {
  it("a maxAttempts-1 step that waits for a signal runs again after the signal", async () => {
    const execute = vi.fn(async (context: WorkflowStepContext): Promise<WorkflowStepResult> => context.signal ? { kind: "complete" } : { kind: "wait", signal: "go" })
    const { store, dispatch } = harness({ approve: { execute, retry: single } })
    store.add({ id: "wf", currentStep: "approve" })
    await expect(dispatch()).resolves.toMatchObject({ advanced: 1 })
    expect(store.rows.get("wf")).toMatchObject({ status: "waiting", stepAttempt: 0 })
    await store.deliverSignal({ id: "s1", instanceId: "wf", name: "go", payload: {} })
    await expect(dispatch()).resolves.toMatchObject({ advanced: 1, failed: 0 })
    expect(store.rows.get("wf")).toMatchObject({ status: "succeeded" })
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it("a polling step may sleep more times than its retry budget", async () => {
    let polls = 0
    const execute = vi.fn(async (): Promise<WorkflowStepResult> => (++polls < 6 ? { kind: "sleep", wakeAt: new Date(start + polls * 1_000) } : { kind: "complete" }))
    const { clock, store, dispatch } = harness({ poll: { execute } })
    store.add({ id: "wf", currentStep: "poll" })
    for (let index = 0; index < 6; index++) {
      await expect(dispatch()).resolves.toMatchObject({ advanced: 1, failed: 0 })
      clock.current += 1_000
    }
    expect(store.rows.get("wf")).toMatchObject({ status: "succeeded" })
    expect(execute).toHaveBeenCalledTimes(6)
  })

  it("state machine: wait/sleep reset the attempt, signal delivery resets legacy counts, retries keep theirs", () => {
    const at = new Date(start)
    const base: WorkflowInstance = { id: "wf", workflowType: "order", workflowVersion: 1, executionScope: { kind: "tenant", tenantId: "t1" }, status: "pending", currentStep: "a", variables: {}, stepAttempt: 2, compensationStack: [], waitingSignal: null, wakeAt: null, outcome: null, revision: 1, leaseOwner: "w", claimToken: "t", leaseExpiresAt: at, createdAt: at, updatedAt: at }
    expect(applyWorkflowStep(base, { kind: "wait", signal: "go" }, at).stepAttempt).toBe(0)
    expect(applyWorkflowStep(base, { kind: "sleep", wakeAt: at }, at).stepAttempt).toBe(0)
    expect(applyWorkflowStep(base, { kind: "retry", error: "x" }, at).stepAttempt).toBe(2)
    const legacyWaiting = { ...base, status: "waiting" as const, waitingSignal: "go", stepAttempt: 3 }
    expect(deliverWorkflowSignal(legacyWaiting, { id: "s", instanceId: "wf", name: "go", payload: {}, deliveredAt: at }, at).stepAttempt).toBe(0)
  })
})

describe("upcast workflow variables are persisted with the definition version", () => {
  it("a v1 instance running on v2 keeps step writes made under the v2 shape", async () => {
    const clock = new ManualClock()
    const store = new MemoryWorkflowStore(clock)
    const upcasters: WorkflowUpcaster[] = [{ type: "order", from: 1, to: 2, upcast: (value) => { const { amount, ...rest } = value as { amount: number }; return { ...rest, amountCents: amount * 100 } } }]
    const registry = createWorkflowRegistry(upcasters)
    const seen: unknown[] = []
    const step = (name: string, execute: WorkflowStepDefinition["execute"]): WorkflowStepDefinition => ({ name, datasource: "primary", execute })
    const decode = (value: unknown) => value as Record<string, unknown>
    registry.register(defineWorkflow({ type: "order", version: 1, initialStep: "a", steps: { a: step("a", async () => ({ kind: "complete" })) }, decodeVariables: decode }))
    registry.register(defineWorkflow({ type: "order", version: 2, initialStep: "a", decodeVariables: decode, steps: {
      a: step("a", async () => ({ kind: "next", step: "b", variables: { amountCents: 600 } })),
      b: step("b", async (context) => { seen.push(context.variables.amountCents); return { kind: "complete" } }),
    } }))
    store.add({ id: "wf", currentStep: "a", workflowVersion: 1, variables: { amount: 5 } })
    const dispatch = () => dispatchWorkflows({ store, registry, workerId: "w", claimLimit: 1, leaseDurationMs: 600, stepTimeoutMs: 50, clock })
    await expect(dispatch()).resolves.toMatchObject({ advanced: 1 })
    expect(store.rows.get("wf")).toMatchObject({ workflowVersion: 2, variables: { amountCents: 600 }, currentStep: "b" })
    expect(store.rows.get("wf")!.variables).not.toHaveProperty("amount")
    await expect(dispatch()).resolves.toMatchObject({ advanced: 1 })
    expect(seen).toEqual([600])
  })
})

describe("workflow dispatcher shutdown", () => {
  it("gives the attempt back for claims never started because the batch was aborted", async () => {
    const controller = new AbortController()
    const execute = vi.fn(async (): Promise<WorkflowStepResult> => { controller.abort(); return { kind: "complete" } })
    const { store, dispatch } = harness({ run: { execute } })
    store.add({ id: "a", currentStep: "run" })
    store.add({ id: "b", currentStep: "run", stepAttempt: 1 })
    const result = await dispatch({ signal: controller.signal })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ claimed: 2, advanced: 1, deferred: 1, failed: 0 })
    // The unstarted claim is immediately claimable again with its original attempt count.
    expect(store.rows.get("b")).toMatchObject({ status: "pending", stepAttempt: 1, leaseOwner: null, claimToken: null })
  })

  it("commits the result of a step that finishes within the grace period after shutdown", async () => {
    const controller = new AbortController()
    let finish!: () => void
    const { clock, store, dispatch } = harness({ run: { execute: () => new Promise<WorkflowStepResult>((resolve) => { finish = () => resolve({ kind: "complete", variables: { done: true } }) }) } }, { cancellationGraceMs: 100, stepTimeoutMs: 10_000 })
    store.add({ id: "wf", currentStep: "run" })
    const run = dispatch({ signal: controller.signal })
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"))
    controller.abort()
    await Promise.resolve()
    finish()
    await expect(run).resolves.toMatchObject({ advanced: 1, failed: 0 })
    expect(store.rows.get("wf")).toMatchObject({ status: "succeeded", variables: { done: true } })
    expect(clock.timers.size).toBe(0)
  })

  it("releases the attempt when a step stops cooperatively on shutdown", async () => {
    const controller = new AbortController()
    const { clock, store, dispatch } = harness({ run: { execute: (context) => new Promise<WorkflowStepResult>((_resolve, reject) => context.executionSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) } }, { cancellationGraceMs: 100, stepTimeoutMs: 10_000 })
    store.add({ id: "wf", currentStep: "run" })
    const run = dispatch({ signal: controller.signal })
    await vi.waitFor(() => expect(clock.timers.size).toBeGreaterThan(0))
    controller.abort()
    await expect(run).resolves.toMatchObject({ deferred: 1, failed: 0 })
    expect(store.rows.get("wf")).toMatchObject({ status: "pending", stepAttempt: 0, leaseOwner: null })
    expect(clock.timers.size).toBe(0)
  })

  it("waits up to the grace period, then abandons the claim and fences its lease", async () => {
    const controller = new AbortController()
    let context!: WorkflowStepContext
    const { clock, store, dispatch } = harness({ run: { execute: (ctx) => { context = ctx; return new Promise<WorkflowStepResult>(() => undefined) } } }, { cancellationGraceMs: 100, stepTimeoutMs: 10_000 })
    store.add({ id: "wf", currentStep: "run" })
    let settled = false
    const run = dispatch({ signal: controller.signal }).finally(() => { settled = true })
    await vi.waitFor(() => expect(context).toBeDefined())
    controller.abort()
    await vi.waitFor(() => expect([...clock.timers.values()].some((timer) => timer.at === clock.current + 100)).toBe(true))
    expect(settled).toBe(false)
    clock.advance(100)
    await expect(run).resolves.toMatchObject({ failed: 1 })
    const renewals = store.renewLease.mock.calls.length
    await expect(context.assertLease()).rejects.toMatchObject({ code: "STALE_CLAIM" })
    expect(store.renewLease.mock.calls.length).toBe(renewals)
    expect(clock.timers.size).toBe(0)
  })
})
