import { describe, expect, it, vi } from "vitest"
import { forAllAsync, scaledRuns, type Rng } from "./harness"
import { drive, flush, ManualClock, MemoryWorkflowStore } from "./workflowFixtures"
import { buildWorld, stableJson, type Behavior, type StepSpec, type World, type WorldSpec } from "./workflowWorld"
import { ModelDispatcher, type ModelCounts, type RefPolicy } from "./workflowModel"
import { dispatchWorkflows, type WorkflowDispatchOptions, type WorkflowDispatchResult } from "../../workflow/workflowDispatcher"
import { createWorkflowRegistry } from "../../workflow/workflowRegistry"
import { MAX_TIMER_DELAY_MS } from "../../execution/types"
import { WorkflowStateError } from "../../workflow/workflowErrors"
import type { WorkflowClaim, WorkflowInstance } from "../../workflow/types"
import type { WorkflowFence, WorkflowStore } from "../../workflow/store"

/**
 * Orchestrated interleavings the sequential model cannot express on its own:
 * a worker whose lease expires while its step is paused (zombie takeover),
 * shutdown at every point of a claim, option validation and store failures.
 */

// Property runs scale with DIFFERENTIAL_SCALE; so does the time they may take.
vi.setConfig({ testTimeout: 60_000 * Math.max(1, scaledRuns(100) / 100) })

const SAMPLES = [0.5] as const
const ID = "i0"
const SCOPE = { kind: "tenant", tenantId: "t1" } as const

function emptyStep(): StepSpec {
  return { retry: undefined, compensationRetry: undefined, idempotent: undefined, hasCompensate: true, exec: [{ k: "complete" }], comp: [{ k: "complete" }] }
}

function worldWith(overrides: Partial<WorldSpec> & { a: Partial<StepSpec> }): WorldSpec {
  const { a, ...rest } = overrides
  return { graceMs: 20, steps: { a: { ...emptyStep(), ...a }, b: emptyStep(), c: emptyStep(), d: emptyStep() }, v2: null, ...rest }
}

function optionsFor(store: WorkflowStore, world: World, clock: ManualClock, spec: WorldSpec, extra: Partial<WorkflowDispatchOptions> = {}): WorkflowDispatchOptions {
  return {
    store, registry: world.registry, workerId: "w1", claimLimit: 1, leaseDurationMs: spec.leaseMs ?? 1000, stepTimeoutMs: spec.timeoutMs ?? 50, cancellationGraceMs: spec.graceMs, clock,
    random: () => SAMPLES[0], ...extra,
  }
}

const sum = (counts: WorkflowDispatchResult | ModelCounts): number => counts.advanced + counts.compensated + counts.retried + counts.deferred + counts.stalled + counts.leaseLost + counts.failed

/** A mutable delegating view of a store, so a test can override single operations. */
function wrapStore(base: MemoryWorkflowStore): WorkflowStore & { -readonly [K in keyof WorkflowStore]: WorkflowStore[K] } & { commits: MemoryWorkflowStore["commits"] } {
  return {
    start: (input) => base.start(input), get: (id) => base.get(id), claimDue: (args) => base.claimDue(args), assertLease: (fence) => base.assertLease(fence), renewLease: (fence, ms) => base.renewLease(fence, ms),
    commit: (fence, next) => base.commit(fence, next), deliverSignal: (signal) => base.deliverSignal(signal), cancel: (id) => base.cancel(id), getSignal: (id, name) => base.getSignal(id, name), commits: base.commits,
  }
}

function comparable(row: WorkflowInstance): unknown {
  return {
    status: row.status, step: row.currentStep, vars: JSON.parse(stableJson(row.variables)), attempt: row.stepAttempt, stack: row.compensationStack, signal: row.waitingSignal, wakeAt: row.wakeAt?.getTime() ?? null,
    outcome: row.outcome, revision: row.revision, version: row.workflowVersion, leased: row.leaseOwner !== null, leaseExpiresAt: row.leaseExpiresAt?.getTime() ?? null,
    failure: row.failure ? { code: row.failure.code, step: row.failure.step, phase: row.failure.phase, attempt: row.failure.attempt, at: row.failure.at.getTime() } : null,
  }
}

function comparableModel(row: ReturnType<ModelDispatcher["rows"]["get"]>): unknown {
  const r = row!
  return {
    status: r.status, step: r.step, vars: JSON.parse(stableJson(r.vars)), attempt: r.attempt, stack: r.stack, signal: r.signal, wakeAt: r.wakeAt, outcome: r.outcome, revision: r.revision, version: r.version,
    leased: r.leased, leaseExpiresAt: r.leaseExpiresAt,
    failure: r.failure ? { code: r.failure.code, step: r.failure.step, phase: r.failure.phase, attempt: r.failure.attempt, at: r.failure.at } : null,
  }
}

// ---------------------------------------------------------------------------
// Zombie takeover

const RESULTS: Behavior[] = [
  { k: "next", to: "b", comp: "a" }, { k: "complete" }, { k: "fail" }, { k: "retry" }, { k: "wait", sig: "go" }, { k: "sleep", delay: 300 },
  { k: "throw", err: "plain" }, { k: "throw", err: "retryable" }, { k: "junk" },
]

interface ZombieCase { first: Behavior; second: Behavior; pauseMs: number; w2First: boolean; stack: boolean; policy: RefPolicy }

const ZOMBIE_LEASE_MS = 100

function generateZombie(rng: Rng): ZombieCase {
  return {
    first: rng.pick(RESULTS), second: rng.pick(RESULTS), pauseMs: rng.pick([0, 1, 33, 66, 99, 100, 101, 250, 5_000]), w2First: rng.bool(), stack: rng.bool(0.3),
    policy: { maxAttempts: rng.pick([1, 2, 3, 4]), initialDelayMs: rng.pick([0, 100, 400]), backoffMultiplier: rng.pick([1, 2]), maxDelayMs: 1_000, jitter: "none" },
  }
}

describe("workflow dispatcher — zombie takeover and lease fencing", () => {
  it("a worker paused past its lease loses the claim, the takeover commits once, and the late result is discarded", async () => {
    await forAllAsync("workflow zombie takeover", generateZombie, async (value) => {
      const spec = (gated: boolean): WorldSpec => worldWith({ leaseMs: ZOMBIE_LEASE_MS, timeoutMs: 10_000, a: { retry: value.policy, exec: [gated ? { k: "gate", then: value.first } : value.first, value.second, { k: "complete" }], comp: [{ k: "complete" }] } })
      const clock = new ManualClock()
      const store = new MemoryWorkflowStore(clock)
      const world = buildWorld(spec(true), clock, store)
      const model = new ModelDispatcher(spec(false), clock.current, SAMPLES)
      await store.start({ id: ID, workflowType: "order", workflowVersion: 1, executionScope: SCOPE, initialStep: "a", variables: {} })
      model.start(ID, "order", 1, {})
      if (value.stack) {
        store.rows.set(ID, { ...store.rows.get(ID)!, compensationStack: ["b"] })
        model.rows.get(ID)!.stack = ["b"]
      }
      let release: () => void = () => undefined
      let fenceHeld: boolean | null = null
      world.gate = async (_record, context) => {
        await new Promise<void>((resolve) => { release = resolve })
        fenceHeld = await context.assertLease().then(() => true, () => false)
      }
      const options = (workerId: string): WorkflowDispatchOptions => optionsFor(store, world, clock, spec(true), { workerId })
      const alive = value.pauseMs < ZOMBIE_LEASE_MS
      const start = clock.current

      const firstDispatch = dispatchWorkflows(options("w1"))
      await flush()
      expect(world.log.length, "the paused step has started").toBe(1)
      const firstToken = store.claims[0]!.claimToken
      await clock.jumpTo(start + value.pauseMs)
      await flush()

      // Reference timeline: the first claim, the pause, then the second dispatcher.
      const snapshot = model.claimBatch(1)
      expect(snapshot.length).toBe(1)
      model.time = start + value.pauseMs
      let expectedFirst: ModelCounts
      if (alive) expectedFirst = model.runBatch(snapshot)
      else {
        const claimed = snapshot[0]!
        model.counters.set(`${ID}/a/${claimed.status === "compensating" ? "compensate" : "execute"}`, 1)
        expectedFirst = { claimed: 1, advanced: 0, compensated: 0, retried: 0, deferred: 0, stalled: 0, leaseLost: 1, failed: 0 }
        model.log.push({ id: ID, step: "a", phase: claimed.status === "compensating" ? "compensate" : "execute", defVersion: 1, attempt: Math.max(1, claimed.attempt), signalId: null, vars: stableJson(claimed.vars) })
      }
      let secondResult: WorkflowDispatchResult | undefined
      // A second dispatcher started while the first worker still holds a valid lease finds nothing to claim.
      const secondWhileHeld = alive && value.w2First
      if (value.w2First) secondResult = await drive(dispatchWorkflows(options("w2")), clock)
      release()
      await flush()
      const firstResult = await drive(firstDispatch, clock)
      if (!value.w2First) secondResult = await drive(dispatchWorkflows(options("w2")), clock)
      const expectedSecond: ModelCounts = secondWhileHeld ? { claimed: 0, advanced: 0, compensated: 0, retried: 0, deferred: 0, stalled: 0, leaseLost: 0, failed: 0 } : model.dispatch(1)

      expect({ ...firstResult }, "first dispatcher").toEqual({ ...expectedFirst })
      expect({ ...secondResult }, "second dispatcher").toEqual({ ...expectedSecond })
      expect(comparable(store.rows.get(ID)!), "row after the race").toEqual(comparableModel(model.rows.get(ID)))
      expect(world.log, "step invocations").toEqual(model.log)
      expect(fenceHeld, "the paused step's own fence check agrees with the lease").toBe(alive)
      const firstCommits = store.commits.filter((commit) => commit.claimToken === firstToken)
      if (alive) expect(firstCommits.filter((commit) => commit.accepted).length, "an alive worker commits exactly once").toBe(1)
      else expect(firstCommits, "a worker that lost its lease must not even try to commit").toEqual([])
      for (const claim of store.claims) expect(store.commits.filter((commit) => commit.claimToken === claim.claimToken && commit.accepted).length).toBeLessThanOrEqual(1)

      // Drain: nothing may be lost; the instance must reach a terminal state.
      for (let round = 0; round < 40; round++) {
        const row = store.rows.get(ID)!
        if (["succeeded", "failed", "cancelled", "compensation_failed"].includes(row.status)) break
        await clock.jumpTo(clock.current + 2_000)
        model.time += 2_000
        if (row.status === "waiting" && row.wakeAt === null && row.waitingSignal !== null) {
          const id = `drain-${round}`
          await store.deliverSignal({ id, instanceId: ID, name: row.waitingSignal, payload: {} })
          model.signal(ID, row.waitingSignal, id)
        }
        const drained = await drive(dispatchWorkflows(optionsFor(store, world, clock, spec(true), { workerId: round % 2 === 0 ? "w1" : "w2" })), clock)
        expect({ ...drained }, `drain round ${round}`).toEqual({ ...model.dispatch(1) })
        expect(comparable(store.rows.get(ID)!), `drain round ${round}: row`).toEqual(comparableModel(model.rows.get(ID)))
      }
      expect(["succeeded", "failed", "cancelled", "compensation_failed"], "the instance reaches a terminal state").toContain(store.rows.get(ID)!.status)
    }, { runs: 200, describe: (value) => JSON.stringify(value) })
  })
})

// ---------------------------------------------------------------------------
// Shutdown

type StepKind = "coopThrow" | "retryableThrow" | "coopResolve" | "finishWithinGrace" | "ignoreForever" | "resolveFail"
interface ShutdownCase { phase: "execute" | "compensate"; count: number; abortAt: "before" | "afterClaim" | "inStep"; stepKind: StepKind; graceMs: number }

function generateShutdown(rng: Rng): ShutdownCase {
  const phase = rng.pick(["execute", "compensate"] as const)
  const kinds: StepKind[] = ["coopThrow", "retryableThrow", "coopResolve", "finishWithinGrace", "ignoreForever", ...(phase === "execute" ? ["resolveFail" as const] : [])]
  const stepKind = rng.pick(kinds)
  return { phase, count: 1 + rng.int(3), abortAt: rng.pick(["before", "afterClaim", "inStep", "inStep", "inStep"] as const), stepKind, graceMs: stepKind === "finishWithinGrace" ? rng.pick([20, 100]) : rng.pick([0, 20, 100]) }
}

describe("workflow dispatcher — shutdown", () => {
  it("never consumes an attempt or records a failure for interrupted work, and finishes work that completes within the grace period", async () => {
    await forAllAsync("workflow shutdown", generateShutdown, async (value) => {
      const gateThen: Behavior = value.stepKind === "resolveFail" ? { k: "fail" } : { k: "complete" }
      const spec = worldWith({ graceMs: value.graceMs, a: { exec: [{ k: "gate", then: gateThen }, { k: "complete" }], comp: [{ k: "gate", then: { k: "complete" } }, { k: "complete" }] } })
      const clock = new ManualClock()
      const store = new MemoryWorkflowStore(clock)
      const world = buildWorld(spec, clock, store)
      const ids = Array.from({ length: value.count }, (_, index) => `i${index}`)
      for (const id of ids) {
        await store.start({ id, workflowType: "order", workflowVersion: 1, executionScope: SCOPE, initialStep: "a", variables: {} })
        if (value.phase === "compensate") {
          const failure = { code: "STEP_FAILED", message: "earlier failure", step: "a", phase: "execute" as const, attempt: 1, at: new Date(clock.current) }
          store.rows.set(id, { ...store.rows.get(id)!, status: "compensating", compensationStack: ["a"], failure })
        }
      }
      const initial = new Map(ids.map((id) => [id, store.rows.get(id)!]))
      const controller = new AbortController()
      const t0 = clock.current
      world.gate = async (_record, context) => {
        if (value.abortAt === "inStep") controller.abort(new Error("shutdown"))
        switch (value.stepKind) {
          case "coopThrow": throw new Error("stopped")
          case "retryableThrow": throw Object.assign(new Error("stopped"), { retryable: true })
          case "ignoreForever": await new Promise<never>(() => undefined); break
          case "finishWithinGrace": await new Promise<void>((resolve) => { clock.setTimeout(resolve, Math.floor(value.graceMs / 2)) }); break
          default: expect(context.executionSignal.aborted, "the step is told to stop").toBe(value.abortAt === "inStep")
        }
      }
      if (value.abortAt === "before") controller.abort(new Error("shutdown"))
      const claimDue = store.claimDue.bind(store)
      store.claimDue = async (args) => {
        const claims = await claimDue(args)
        if (value.abortAt === "afterClaim") controller.abort(new Error("shutdown"))
        return claims
      }
      const result = await drive(dispatchWorkflows(optionsFor(store, world, clock, spec, { claimLimit: 4, signal: controller.signal })), clock)

      const rows = ids.map((id) => store.rows.get(id)!)
      // Grace 0 means "do not wait": the dispatcher cannot have seen the step settle, so every step looks like one that ignores the stop request.
      const observed: StepKind = value.graceMs === 0 && value.abortAt === "inStep" ? "ignoreForever" : value.stepKind
      const released = (id: string): void => {
        const before = initial.get(id)!
        expect(comparable(store.rows.get(id)!), `${id} handed back`).toEqual({ ...(comparable(before) as object), revision: 2, attempt: 0 })
      }
      if (value.abortAt === "before") {
        expect({ ...result }).toEqual({ claimed: 0, advanced: 0, compensated: 0, retried: 0, deferred: 0, stalled: 0, leaseLost: 0, failed: 0 })
        for (const id of ids) expect(store.rows.get(id)).toBe(initial.get(id))
        expect(world.log).toEqual([])
        return
      }
      expect(result.claimed).toBe(value.count)
      expect(sum(result), "every claim has exactly one outcome").toBe(value.count)
      // No interrupted claim may leave a failure behind or move the instance forward by itself.
      const first = ids[0]!
      if (value.abortAt === "afterClaim") {
        expect(result.deferred).toBe(value.count)
        for (const id of ids) released(id)
        expect(world.log, "no step ran after shutdown").toEqual([])
      } else {
        for (const id of ids.slice(1)) released(id)
        expect(world.log.map((entry) => entry.id), "only the claim in flight when shutdown arrived ran").toEqual([first])
        const row = store.rows.get(first)!
        switch (observed) {
          case "coopThrow":
          case "retryableThrow":
            released(first)
            expect(result.deferred).toBe(value.count)
            break
          case "ignoreForever":
            // The step ignores the stop request and never settles: nothing is committed, the attempt stays counted, and the lease simply lapses.
            expect(result.failed).toBe(1)
            expect(result.deferred).toBe(value.count - 1)
            expect(comparable(row)).toMatchObject({ attempt: 1, revision: 1, leased: true, status: value.phase === "compensate" ? "compensating" : "pending" })
            expect(row.failure?.code ?? null, "no failure is recorded for interrupted work").toBe(value.phase === "compensate" ? "STEP_FAILED" : null)
            break
          case "resolveFail":
            expect(result.failed).toBe(1)
            expect(row).toMatchObject({ status: "failed", outcome: "failed" })
            expect(row.failure?.code).toBe("STEP_FAILED")
            expect(result.deferred).toBe(value.count - 1)
            break
          default: {
            // coopResolve / finishWithinGrace: the step finished, so its result is committed even though shutdown was requested.
            expect(value.phase === "compensate" ? result.compensated : result.advanced).toBe(1)
            expect(row).toMatchObject({ status: value.phase === "compensate" ? "failed" : "succeeded", revision: 2 })
            expect(result.deferred).toBe(value.count - 1)
          }
        }
      }
      expect(rows.every((row) => row.failure === null || value.phase === "compensate" || row.id === first)).toBe(true)

      // Restart: handed-back work runs again from attempt 1; work that was hung keeps its attempt counted.
      world.log.length = 0
      await clock.jumpTo(t0 + 5_000)
      const rerun = await drive(dispatchWorkflows(optionsFor(store, world, clock, spec, { claimLimit: 4 })), clock)
      expect(sum(rerun)).toBe(rerun.claimed)
      for (const entry of world.log) {
        const hung = value.abortAt === "inStep" && observed === "ignoreForever" && entry.id === first
        expect(entry.attempt, `${entry.id} attempt after restart`).toBe(hung ? 2 : 1)
      }
      for (const row of ids.map((id) => store.rows.get(id)!)) expect(row.leaseOwner).toBeNull()
    }, { runs: 200, describe: (value) => JSON.stringify(value) })
  })
})

// ---------------------------------------------------------------------------
// Options and store failures

interface OptionsCase {
  workerId: unknown; claimLimit: unknown; leaseDurationMs: unknown; stepTimeoutMs: unknown; concurrency: unknown; cancellationGraceMs: unknown; random: "none" | "fn" | "bad"; signal: "none" | "live" | "aborted" | "bad"
}

function generateOptions(rng: Rng): OptionsCase {
  return {
    workerId: rng.pick(["w", "worker-1", "", "   ", 5, undefined, null]),
    claimLimit: rng.pick([1, 5, 100, 101, 0, -1, 1.5, Number.NaN, "3", 1, 2, 3]),
    leaseDurationMs: rng.pick([3, 2, 1000, MAX_TIMER_DELAY_MS, MAX_TIMER_DELAY_MS + 1, 0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 30_000]),
    stepTimeoutMs: rng.pick([undefined, undefined, 1, 0, 300_000, 300_001, 50.5, -1, Number.NaN]),
    concurrency: rng.pick([undefined, undefined, 1, 2, 0, -1, 1000, 1.5]),
    cancellationGraceMs: rng.pick([undefined, undefined, 0, 60_000, 60_001, -1, 2.5, Number.NaN]),
    random: rng.pick(["none", "none", "fn", "bad"] as const),
    signal: rng.pick(["none", "none", "live", "aborted", "bad"] as const),
  }
}

function optionsAreValid(value: OptionsCase): boolean {
  const integer = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x)
  const claimLimit = value.claimLimit
  if (typeof value.workerId !== "string" || value.workerId.trim() === "") return false
  if (!integer(claimLimit) || claimLimit < 1 || claimLimit > 100) return false
  if (!integer(value.leaseDurationMs) || value.leaseDurationMs < 3 || value.leaseDurationMs > MAX_TIMER_DELAY_MS) return false
  if (value.stepTimeoutMs !== undefined && (!integer(value.stepTimeoutMs) || value.stepTimeoutMs < 1 || value.stepTimeoutMs > 300_000)) return false
  if (value.concurrency !== undefined && (!integer(value.concurrency) || value.concurrency < 1 || value.concurrency > claimLimit)) return false
  if (value.cancellationGraceMs !== undefined && (!integer(value.cancellationGraceMs) || value.cancellationGraceMs < 0 || value.cancellationGraceMs > 60_000)) return false
  return value.random !== "bad" && value.signal !== "bad"
}

describe("workflow dispatcher — options and store failures", () => {
  it("accepts exactly the documented option ranges and rejects everything else before touching the store", async () => {
    await forAllAsync("workflow dispatcher option validation", generateOptions, async (value) => {
      const claimDue = vi.fn(async (): Promise<readonly WorkflowClaim[]> => [])
      const store = { claimDue } as unknown as WorkflowStore
      const aborted = new AbortController()
      aborted.abort()
      const signal = value.signal === "none" ? undefined : value.signal === "live" ? new AbortController().signal : value.signal === "aborted" ? aborted.signal : ({} as AbortSignal)
      const call = dispatchWorkflows({
        store, registry: createWorkflowRegistry(), workerId: value.workerId as string, claimLimit: value.claimLimit as number, leaseDurationMs: value.leaseDurationMs as number,
        ...(value.stepTimeoutMs !== undefined ? { stepTimeoutMs: value.stepTimeoutMs as number } : {}), ...(value.concurrency !== undefined ? { concurrency: value.concurrency as number } : {}),
        ...(value.cancellationGraceMs !== undefined ? { cancellationGraceMs: value.cancellationGraceMs as number } : {}),
        ...(value.random === "none" ? {} : { random: (value.random === "fn" ? () => 0.5 : 5) as () => number }), ...(signal !== undefined ? { signal } : {}),
      })
      if (!optionsAreValid(value)) {
        await expect(call).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" })
        expect(claimDue, "invalid options must be rejected before claiming").not.toHaveBeenCalled()
        return
      }
      await expect(call).resolves.toMatchObject({ claimed: 0, advanced: 0, failed: 0 })
      expect(claimDue).toHaveBeenCalledTimes(value.signal === "aborted" ? 0 : 1)
      if (value.signal !== "aborted") expect(claimDue).toHaveBeenCalledWith(expect.objectContaining({ workerId: value.workerId, limit: value.claimLimit, leaseDurationMs: value.leaseDurationMs }))
    }, { runs: 400, describe: (value) => JSON.stringify(value, (_key, item: unknown) => (typeof item === "number" && !Number.isFinite(item) ? String(item) : item)) })
  })

  it("an oversized or non-array claim batch is a store contract violation (WorkflowStateError)", async () => {
    await forAllAsync("workflow dispatcher claim batch violation", (rng) => ({ limit: 1 + rng.int(4), extra: 1 + rng.int(3), shape: rng.pick(["oversized", "notArray"] as const) }), async (value) => {
      const clock = new ManualClock()
      const real = new MemoryWorkflowStore(clock)
      const spec = worldWith({ a: {} })
      const world = buildWorld(spec, clock, real)
      for (let index = 0; index < value.limit + value.extra; index++) await real.start({ id: `i${index}`, workflowType: "order", workflowVersion: 1, executionScope: SCOPE, initialStep: "a", variables: {} })
      const claims = await real.claimDue({ workerId: "w9", limit: value.limit + value.extra, leaseDurationMs: 1000 })
      const hostile = { claimDue: async () => (value.shape === "notArray" ? ({ length: 0 } as unknown as readonly WorkflowClaim[]) : claims) } as unknown as WorkflowStore
      await expect(dispatchWorkflows(optionsFor(hostile, world, clock, spec, { claimLimit: value.limit }))).rejects.toBeInstanceOf(WorkflowStateError)
      expect(world.log, "no step may run for a rejected batch").toEqual([])
    }, { runs: 60 })
  })
})

type Fault = "commitThrows" | "commitFalse" | "renewThrows" | "renewFalse" | "renewHangs" | "getSignalThrows" | "getSignalHangs" | "assertLeaseFalse"

describe("workflow dispatcher — store failures", () => {
  it("a failing store never lets a step run without its fence, never advances state, and never rejects the dispatch", async () => {
    await forAllAsync("workflow dispatcher store faults", (rng) => ({
      fault: rng.pick(["commitThrows", "commitFalse", "renewThrows", "renewFalse", "renewHangs", "getSignalThrows", "getSignalHangs", "assertLeaseFalse"] as const satisfies readonly Fault[]),
      resumed: rng.bool(), idempotent: rng.pick([undefined, true, false]), count: 1 + rng.int(3),
    }), async (value) => {
      const spec = worldWith({ a: { idempotent: value.idempotent, retry: { maxAttempts: 3, initialDelayMs: 100, backoffMultiplier: 2, maxDelayMs: 1000, jitter: "none" } } })
      const clock = new ManualClock()
      const base = new MemoryWorkflowStore(clock)
      const world = buildWorld(spec, clock, base)
      const store = wrapStore(base)
      const ids = Array.from({ length: value.count }, (_, index) => `i${index}`)
      for (const id of ids) {
        await base.start({ id, workflowType: "order", workflowVersion: 1, executionScope: SCOPE, initialStep: "a", variables: {} })
        if (value.resumed) base.rows.set(id, { ...base.rows.get(id)!, waitingSignal: "go" })
      }
      if (value.resumed) await base.deliverSignal({ id: "s", instanceId: ids[0]!, name: "go", payload: {} })
      const fault = value.fault
      store.commit = async (fence: WorkflowFence, next: WorkflowInstance) => {
        if (fault === "commitThrows") throw new Error("db down")
        if (fault === "commitFalse") return false
        return await base.commit(fence, next)
      }
      store.renewLease = async (fence: WorkflowFence, extendByMs: number) => {
        if (fault === "renewThrows") throw new Error("db down")
        if (fault === "renewFalse") return false
        if (fault === "renewHangs") return await new Promise<boolean>(() => undefined)
        return await base.renewLease(fence, extendByMs)
      }
      store.getSignal = async (instanceId: string, name: string) => {
        if (fault === "getSignalThrows") throw new Error("db down")
        if (fault === "getSignalHangs") return await new Promise<never>(() => undefined)
        return await base.getSignal(instanceId, name)
      }
      store.assertLease = async (fence: WorkflowFence) => (fault === "assertLeaseFalse" ? false : await base.assertLease(fence))
      const result = await drive(dispatchWorkflows(optionsFor(store, world, clock, spec, { claimLimit: 4 })), clock)

      expect(result.claimed).toBe(value.count)
      expect(sum(result), "every claim has exactly one outcome").toBe(value.count)
      const fenceFailures: Fault[] = ["renewThrows", "renewFalse", "renewHangs"]
      const readsSignal = fault === "getSignalThrows" || fault === "getSignalHangs"
      if (fenceFailures.includes(fault)) {
        expect(world.log, "a step must not run when its first fence check fails").toEqual([])
        expect(result.leaseLost).toBe(value.count)
      }
      if (fault === "commitFalse") expect(result.leaseLost).toBe(value.count)
      if (fault === "commitThrows") expect(result.failed).toBe(value.count)
      if (fault === "commitFalse" || fault === "commitThrows") expect(world.log.length, "the step ran once per claim").toBe(value.count)
      if (fault === "getSignalHangs" && value.resumed) {
        // The step never started, so a deadline that expired while reading the signal is retried even for a non-idempotent step.
        expect(world.log, "the step never started").toEqual([])
        expect(result.retried, "a pre-start timeout is retried, not failed").toBe(value.count)
        for (const id of ids) expect(base.rows.get(id)).toMatchObject({ status: "waiting", stepAttempt: 1, failure: null })
      }
      for (const id of ids) {
        const row = base.rows.get(id)!
        if (fenceFailures.includes(fault) || fault === "commitFalse" || fault === "commitThrows") {
          expect(comparable(row), `${id}: nothing but the claim was written`).toMatchObject({ status: "pending", revision: 1, outcome: null, attempt: 1, leased: true })
        } else if (!readsSignal || !value.resumed) {
          expect(row.status, `${id}: the fault is not on this path`).toBe("succeeded")
        }
      }
      expect(base.commits.filter((commit) => commit.accepted).length === 0 || !(fenceFailures.includes(fault) || fault === "commitFalse" || fault === "commitThrows")).toBe(true)
    }, { runs: 120, describe: (value) => JSON.stringify(value) })
  })

  it("an instance never becomes unclaimable: after a failed commit its lease lapses and the next worker re-runs it with the attempt counted", async () => {
    await forAllAsync("workflow dispatcher crash recovery", (rng) => ({ fault: rng.pick(["commitThrows", "commitFalse"] as const), maxAttempts: rng.pick([1, 2, 3]), rounds: 1 + rng.int(5) }), async (value) => {
      const spec = worldWith({ a: { retry: { maxAttempts: value.maxAttempts, initialDelayMs: 0, backoffMultiplier: 1, maxDelayMs: 0, jitter: "none" }, exec: [{ k: "complete" }] } })
      const clock = new ManualClock()
      const base = new MemoryWorkflowStore(clock)
      const world = buildWorld(spec, clock, base)
      const store = wrapStore(base)
      await base.start({ id: ID, workflowType: "order", workflowVersion: 1, executionScope: SCOPE, initialStep: "a", variables: {} })
      let broken = true
      store.commit = async (fence: WorkflowFence, next: WorkflowInstance) => {
        if (broken && value.fault === "commitThrows") throw new Error("db down")
        if (broken) return false
        return await base.commit(fence, next)
      }
      for (let round = 0; round < value.rounds; round++) {
        await drive(dispatchWorkflows(optionsFor(store, world, clock, spec)), clock)
        // Right after the failure the lease still protects the claim.
        const during = await drive(dispatchWorkflows(optionsFor(store, world, clock, spec)), clock)
        expect(during.claimed, "a live lease is not stolen").toBe(0)
        await clock.jumpTo(clock.current + 1_001)
      }
      broken = false
      const recovered = await drive(dispatchWorkflows(optionsFor(store, world, clock, spec)), clock)
      expect(recovered.claimed, "the instance is claimable again").toBe(1)
      const attempt = value.rounds + 1
      if (attempt > value.maxAttempts) expect(base.rows.get(ID)).toMatchObject({ status: "failed", failure: { code: "ATTEMPTS_EXHAUSTED" } })
      else expect(base.rows.get(ID)).toMatchObject({ status: "succeeded" })
      expect(world.log.length, "steps that would exceed the budget never run").toBe(Math.min(attempt, value.maxAttempts))
    }, { runs: 80, describe: (value) => JSON.stringify(value) })
  })
})

// ---------------------------------------------------------------------------
// Lease lifecycle

interface LeaseCase { leaseMs: number; renewDelayMs: number; fenceCalls: Array<{ after: number; parallel: number }>; stepMs: number; probeEvery: number }

function generateLease(rng: Rng): LeaseCase {
  const leaseMs = rng.pick([3, 30, 100, 1_000])
  const half = Math.max(1, Math.floor(leaseMs / 2))
  return {
    leaseMs,
    // Never exactly the renewal timeout (a tie would be decided by timer creation order, which the contract does not specify).
    renewDelayMs: rng.pick([0, 0, 1, Math.max(0, half - 1), half + 1, half * 3]),
    fenceCalls: Array.from({ length: rng.int(4) }, () => ({ after: rng.int(leaseMs * 2), parallel: 1 + rng.int(3) })),
    stepMs: rng.pick([0, 1, Math.floor(leaseMs / 3), leaseMs, Math.floor(leaseMs * 2.5), leaseMs * 6]),
    probeEvery: 1 + rng.int(3),
  }
}

describe("workflow dispatcher — lease lifecycle", () => {
  it("renewals are serialized per claim, heartbeats keep a long step alive, nobody steals a live lease, and a finished claim leaves no timers or fence behind", async () => {
    await forAllAsync("workflow lease lifecycle", generateLease, async (value) => {
      const half = Math.max(1, Math.floor(value.leaseMs / 2))
      const spec = worldWith({ leaseMs: value.leaseMs, timeoutMs: 100_000, a: { exec: [{ k: "gate", then: { k: "complete" } }] } })
      const clock = new ManualClock()
      const base = new MemoryWorkflowStore(clock)
      const world = buildWorld(spec, clock, base)
      const store = wrapStore(base)
      await base.start({ id: ID, workflowType: "order", workflowVersion: 1, executionScope: SCOPE, initialStep: "a", variables: {} })
      let active = 0
      let maxActive = 0
      let renewals = 0
      const expiries: number[] = []
      store.renewLease = async (fence: WorkflowFence, extendByMs: number) => {
        active++
        renewals++
        maxActive = Math.max(maxActive, active)
        if (value.renewDelayMs > 0) await new Promise<void>((resolve) => { clock.setTimeout(resolve, value.renewDelayMs) })
        const granted = await base.renewLease(fence, extendByMs)
        const expiry = base.rows.get(fence.instanceId)?.leaseExpiresAt?.getTime()
        if (granted && expiry !== undefined) expiries.push(expiry)
        active--
        return granted
      }
      let heldContext: Parameters<NonNullable<World["gate"]>>[1] | undefined
      let fenceResults: boolean[] = []
      world.gate = async (_record, context) => {
        heldContext = context
        for (const call of value.fenceCalls) {
          await new Promise<void>((resolve) => { clock.setTimeout(resolve, call.after) })
          const settled = await Promise.allSettled(Array.from({ length: call.parallel }, () => context.assertLease()))
          fenceResults = fenceResults.concat(settled.map((entry) => entry.status === "fulfilled"))
        }
        await new Promise<void>((resolve) => { clock.setTimeout(resolve, value.stepMs) })
      }
      const options = (workerId: string): WorkflowDispatchOptions => optionsFor(store, world, clock, spec, { workerId })

      const running = dispatchWorkflows(options("w1"))
      let result: WorkflowDispatchResult | undefined
      let failure: unknown
      running.then((done) => { result = done }, (error: unknown) => { failure = error })
      let steps = 0
      for (let fired = 0; result === undefined && failure === undefined && fired < 5_000; fired++) {
        await flush()
        if (result !== undefined || failure !== undefined) break
        if (steps++ % value.probeEvery === 0) {
          const probe = await dispatchWorkflows(options("w2"))
          const row = base.rows.get(ID)!
          if (row.leaseOwner === "w1" && row.leaseExpiresAt!.getTime() > clock.current) expect(probe.claimed, "a live lease must not be stolen").toBe(0)
        }
        if (!clock.fireNext()) { await flush(); break }
      }
      await flush()
      expect(failure).toBeUndefined()
      expect(result, "the dispatch finishes").toBeDefined()
      expect(maxActive, "renewals for one claim are serialized").toBeLessThanOrEqual(1)
      for (let index = 1; index < expiries.length; index++) expect(expiries[index]!, "lease expiry only moves forward").toBeGreaterThanOrEqual(expiries[index - 1]!)

      const slowRenewal = value.renewDelayMs >= half
      if (!slowRenewal) {
        expect(result, "healthy renewals: the step commits").toMatchObject({ claimed: 1, advanced: 1, leaseLost: 0, failed: 0 })
        expect(base.rows.get(ID)).toMatchObject({ status: "succeeded", leaseOwner: null })
      } else {
        // A renewal that exceeds half the lease is treated as lost, and a lost claim never commits.
        expect(result!.advanced + result!.leaseLost).toBe(1)
        if (result!.leaseLost === 1) expect(base.commits.filter((commit) => commit.accepted)).toEqual([])
      }
      // (A store call that was abandoned after its timeout may still own its own timer; the dispatcher's must all be gone.)
      if (!slowRenewal) expect(clock.timers.size, "no heartbeat, deadline, or renewal timer outlives the claim").toBe(0)

      // Once the dispatcher has returned, a step that is still running must not be able to pass the fence or extend the lease.
      const before = renewals
      if (heldContext !== undefined) await expect(heldContext.assertLease()).rejects.toBeInstanceOf(Error)
      expect(renewals, "a finished claim never renews").toBe(before)
    }, { runs: 150, describe: (value) => JSON.stringify(value) })
  })
})
