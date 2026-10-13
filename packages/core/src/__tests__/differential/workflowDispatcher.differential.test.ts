import { describe, expect, it, vi } from "vitest"
import { forAllAsync, scaledRuns, type Rng } from "./harness"
import { drive, ManualClock, MemoryWorkflowStore } from "./workflowFixtures"
import { buildWorld, generateWorld, LEASE_MS, STEP_TIMEOUT_MS, stableJson, type World, type WorldSpec } from "./workflowWorld"
import { ModelDispatcher, type ModelCounts, type ModelRow } from "./workflowModel"
import { dispatchWorkflows, type WorkflowDispatchResult } from "../../workflow/workflowDispatcher"
import type { WorkflowInstance } from "../../workflow/types"

/**
 * Model-based differential for the workflow dispatcher: random interleavings of
 * start / signal / cancel / clock movement / dispatch rounds against an
 * in-memory store with the SQL stores' semantics and a reference model of the
 * claim -> step -> commit protocol (workflowModel.ts).
 */

const IDS = ["i0", "i1", "i2", "i3", "i4"] as const
// Property runs scale with DIFFERENTIAL_SCALE; so does the time they may take.
vi.setConfig({ testTimeout: 60_000 * Math.max(1, scaledRuns(100) / 100) })

const SAMPLES = [0, 0.25, 0.5, 0.999] as const

type Op =
  | { t: "start"; id: string; type: string; version: number; poison: boolean }
  | { t: "advance"; ms: number }
  | { t: "signal"; id: string; name: string; sid: string }
  | { t: "cancel"; id: string }
  | { t: "wake"; pick: number; sid: string }
  | { t: "dispatch"; limit: number; worker: string; parallel: boolean }
  | { t: "burst"; limits: number[]; concurrency: number[] }

interface DispatcherCase { world: WorldSpec; ops: Op[] }

function generateOp(rng: Rng, serial: number, burst: boolean): Op {
  const roll = rng.int(100)
  if (roll < 14) return { t: "start", id: rng.pick(IDS), type: rng.bool(0.93) ? "order" : "ghost", version: rng.pick([1, 1, 1, 2, 3]), poison: rng.bool(0.15) }
  if (roll < 40) return { t: "advance", ms: rng.pick([0, 1, 5, 40, 300, 1_200, 5_000, -3, -250]) }
  if (roll < 52) return { t: "signal", id: rng.pick(IDS), name: rng.pick(["go", "stop"]), sid: rng.bool(0.2) ? `dup-${rng.int(2)}` : `sig-${serial}` }
  if (roll < 56) return { t: "cancel", id: rng.pick(IDS) }
  if (roll < 66) return { t: "wake", pick: rng.int(8), sid: `wake-${serial}` }
  if (burst) {
    const dispatchers = 2 + rng.int(2)
    const limits = Array.from({ length: dispatchers }, () => 1 + rng.int(4))
    return { t: "burst", limits, concurrency: limits.map((limit) => 1 + rng.int(limit)) }
  }
  return { t: "dispatch", limit: 1 + rng.int(4), worker: rng.pick(["w1", "w2"]), parallel: rng.bool(0.4) }
}

function generateCase(rng: Rng): DispatcherCase {
  const world = generateWorld(rng)
  return { world, ops: Array.from({ length: 6 + rng.int(40) }, (_, index) => generateOp(rng, index, false)) }
}

/** Quiet worlds: steps take no fake time, so concurrent claims commute and only the claim partition matters. */
function generateBurstCase(rng: Rng): DispatcherCase {
  const world = generateWorld(rng, { quiet: true })
  return { world, ops: Array.from({ length: 6 + rng.int(30) }, (_, index) => generateOp(rng, index, rng.bool(0.5))) }
}

function* shrinkCase(value: DispatcherCase): Iterable<DispatcherCase> {
  for (let index = 0; index < value.ops.length; index++) yield { ...value, ops: value.ops.filter((_, position) => position !== index) }
}

const describeCase = (value: DispatcherCase): string => JSON.stringify(value)

function projectRow(row: WorkflowInstance): Omit<ModelRow, "id"> & { id: string } {
  return {
    id: row.id, type: row.workflowType, version: row.workflowVersion, status: row.status, step: row.currentStep, vars: JSON.parse(stableJson(row.variables)) as Record<string, unknown>,
    attempt: row.stepAttempt, stack: [...row.compensationStack], signal: row.waitingSignal, resume: row.resumeSignalId ?? null, wakeAt: row.wakeAt === null ? null : row.wakeAt.getTime(), outcome: row.outcome, revision: row.revision,
    failure: row.failure ? { code: row.failure.code, step: row.failure.step, phase: row.failure.phase, attempt: row.failure.attempt, at: row.failure.at.getTime(), message: row.failure.message } : null,
    leased: row.leaseOwner !== null, leaseExpiresAt: row.leaseExpiresAt === null ? null : row.leaseExpiresAt.getTime(),
  }
}

function normalizeModelRow(row: ModelRow): ReturnType<typeof projectRow> {
  const { failure, vars, ...rest } = row
  return {
    ...rest, vars: JSON.parse(stableJson(vars)) as Record<string, unknown>,
    failure: failure === null ? null : { code: failure.code, step: failure.step, phase: failure.phase, attempt: failure.attempt, at: failure.at, message: failure.message },
  }
}

/** Failure messages are compared only where the model knows the exact text. */
function expectRowsMatch(store: MemoryWorkflowStore, model: ModelDispatcher, label: string): void {
  expect([...store.rows.keys()].sort(), `${label}: instance set`).toEqual([...model.rows.keys()].sort())
  for (const [id, expected] of model.rows) {
    const actual = projectRow(store.rows.get(id)!)
    const expectedRow = normalizeModelRow(expected)
    const { failure: actualFailure, ...actualRest } = actual
    const { failure: expectedFailure, ...expectedRest } = expectedRow
    expect(actualRest, `${label}: ${id}`).toEqual(expectedRest)
    if (expectedFailure === null) { expect(actualFailure, `${label}: ${id} failure`).toBeNull(); continue }
    expect(actualFailure, `${label}: ${id} failure`).not.toBeNull()
    const { message, ...fields } = actualFailure!
    const { message: expectedMessage, ...expectedFields } = expectedFailure
    expect(fields, `${label}: ${id} failure fields`).toEqual(expectedFields)
    if (expectedMessage !== undefined) expect(message, `${label}: ${id} failure message`).toBe(expectedMessage)
  }
}

function expectCounts(actual: WorkflowDispatchResult, expected: ModelCounts, label: string): void {
  expect({ ...actual }, `${label}: dispatch result`).toEqual({ ...expected })
}

/** Generator coverage, accumulated by the model-equivalence property and asserted right after it. */
const coverage = { outcomes: {} as Record<string, number>, failureCodes: new Set<string>(), statuses: new Set<string>(), resumedBySignal: 0 }

describe("workflow dispatcher — model-based differential", () => {
  it("single worker: rows, outcomes, step invocations and timeline match the reference model under random interleavings", async () => {
    await forAllAsync("workflow dispatcher model equivalence", generateCase, async (value) => {
      const clock = new ManualClock()
      const store = new MemoryWorkflowStore(clock)
      const world: World = buildWorld(value.world, clock, store)
      const model = new ModelDispatcher(value.world, clock.current, SAMPLES)
      let sampleIndex = 0
      for (const [index, op] of value.ops.entries()) {
        const label = `op #${index} ${op.t}`
        switch (op.t) {
          case "start": {
            if (store.rows.has(op.id)) break
            const vars = op.poison ? { poison: true } : { k1: 1 }
            await store.start({ id: op.id, workflowType: op.type, workflowVersion: op.version, executionScope: { kind: "tenant", tenantId: "t1" }, initialStep: "a", variables: vars })
            model.start(op.id, op.type, op.version, vars)
            break
          }
          case "advance": {
            await clock.jumpTo(clock.current + op.ms)
            model.time += op.ms
            break
          }
          case "signal": {
            await store.deliverSignal({ id: op.sid, instanceId: op.id, name: op.name, payload: {} })
            model.signal(op.id, op.name, op.sid)
            break
          }
          case "wake": {
            // Deliver the signal an instance is actually waiting for (chosen from the model's view).
            const waiting = [...model.rows.values()].filter((row) => row.status === "waiting" && row.wakeAt === null && row.signal !== null).sort((left, right) => (left.id < right.id ? -1 : 1))
            if (waiting.length === 0) break
            const target = waiting[op.pick % waiting.length]!
            const delivery = await store.deliverSignal({ id: op.sid, instanceId: target.id, name: target.signal!, payload: {} })
            expect(delivery, `${label}: delivery`).toEqual({ delivered: true, duplicate: false })
            model.signal(target.id, target.signal!, op.sid)
            break
          }
          case "cancel": {
            const accepted = await store.cancel(op.id)
            expect(accepted, `${label}: cancel acceptance`).toBe(model.cancel(op.id))
            break
          }
          case "burst": break
          case "dispatch": {
            const result = await drive(dispatchWorkflows({
              store, registry: world.registry, workerId: op.worker, claimLimit: op.limit, leaseDurationMs: LEASE_MS, stepTimeoutMs: STEP_TIMEOUT_MS, cancellationGraceMs: value.world.graceMs, clock,
              ...(op.parallel ? { concurrency: op.limit } : {}), random: op.parallel ? () => 0.5 : () => SAMPLES[sampleIndex++ % SAMPLES.length]!,
            }), clock)
            const expected = model.dispatch(op.limit, op.parallel)
            expectCounts(result, expected, label)
            for (const [outcome, count] of Object.entries(result)) coverage.outcomes[outcome] = (coverage.outcomes[outcome] ?? 0) + count
            expect(clock.current, `${label}: clock after dispatch`).toBe(model.time)
            // Parallel claims interleave their log entries by completion order; compare per instance.
            const perInstance = (log: typeof world.log): Record<string, unknown[]> => log.reduce<Record<string, unknown[]>>((acc, entry) => { (acc[entry.id] ??= []).push(entry); return acc }, {})
            expect(perInstance(world.log), `${label}: step invocations`).toEqual(perInstance(model.log))
            break
          }
        }
        expectRowsMatch(store, model, label)
        for (const row of store.rows.values()) { coverage.statuses.add(row.status); if (row.failure) coverage.failureCodes.add(row.failure.code) }
      }
      for (const entry of world.log) if (entry.signalId !== null) coverage.resumedBySignal++
    }, { runs: 300, shrink: shrinkCase, describe: describeCase })
  })

  it("concurrent dispatchers racing on one store claim disjoint batches and end in the model's state", async () => {
    await forAllAsync("workflow dispatcher concurrent claims", generateBurstCase, async (value) => {
      const clock = new ManualClock()
      const store = new MemoryWorkflowStore(clock)
      const world: World = buildWorld(value.world, clock, store)
      const model = new ModelDispatcher(value.world, clock.current, [0.5])
      for (const [index, op] of value.ops.entries()) {
        const label = `op #${index} ${op.t}`
        switch (op.t) {
          case "start": {
            if (store.rows.has(op.id)) break
            const vars = op.poison ? { poison: true } : { k1: 1 }
            await store.start({ id: op.id, workflowType: op.type, workflowVersion: op.version, executionScope: { kind: "tenant", tenantId: "t1" }, initialStep: "a", variables: vars })
            model.start(op.id, op.type, op.version, vars)
            break
          }
          case "advance": await clock.jumpTo(clock.current + op.ms); model.time += op.ms; break
          case "signal": await store.deliverSignal({ id: op.sid, instanceId: op.id, name: op.name, payload: {} }); model.signal(op.id, op.name, op.sid); break
          case "cancel": expect(await store.cancel(op.id), `${label}: cancel acceptance`).toBe(model.cancel(op.id)); break
          case "wake": {
            const waiting = [...model.rows.values()].filter((row) => row.status === "waiting" && row.wakeAt === null && row.signal !== null).sort((left, right) => (left.id < right.id ? -1 : 1))
            if (waiting.length === 0) break
            const target = waiting[op.pick % waiting.length]!
            await store.deliverSignal({ id: op.sid, instanceId: target.id, name: target.signal!, payload: {} })
            model.signal(target.id, target.signal!, op.sid)
            break
          }
          case "dispatch":
          case "burst": {
            const limits = op.t === "burst" ? op.limits : [op.limit]
            const concurrency = op.t === "burst" ? op.concurrency : [1]
            // All dispatchers are started before any step runs: their atomic claims partition the due rows.
            const running = limits.map((limit, position) => dispatchWorkflows({
              store, registry: world.registry, workerId: `w${position + 1}`, claimLimit: limit, concurrency: concurrency[position]!, leaseDurationMs: LEASE_MS, stepTimeoutMs: STEP_TIMEOUT_MS,
              cancellationGraceMs: value.world.graceMs, clock, random: () => 0.5,
            }))
            const results = await drive(Promise.all(running), clock)
            const batches = limits.map((limit) => model.claimBatch(limit))
            results.forEach((result, position) => {
              expect(result.claimed, `${label}: dispatcher ${position} claimed`).toBe(batches[position]!.length)
            })
            const expected = batches.map((batch) => model.runBatch(batch))
            results.forEach((result, position) => expectCounts(result, expected[position]!, `${label}: dispatcher ${position}`))
            const key = (entry: { id: string; step: string; phase: string; attempt: number }): string => `${entry.id}/${entry.attempt}/${entry.phase}/${entry.step}`
            expect(world.log.map(key).sort(), `${label}: step invocations`).toEqual(model.log.map(key).sort())
            expect(world.log.map((entry) => `${key(entry)}|${entry.vars}|${entry.signalId}|${entry.defVersion}`).sort(), `${label}: invocation detail`).toEqual(model.log.map((entry) => `${key(entry)}|${entry.vars}|${entry.signalId}|${entry.defVersion}`).sort())
            break
          }
        }
        expectRowsMatch(store, model, label)
        for (const claim of store.claims) expect(store.commits.filter((commit) => commit.claimToken === claim.claimToken && commit.accepted).length, `${label}: claim ${claim.claimToken} commits at most once`).toBeLessThanOrEqual(1)
      }
    }, { runs: 200, shrink: shrinkCase, describe: describeCase })
  })

  it("the generator reaches every dispatcher outcome, status and failure path (guards against a vacuous model)", () => {
    if (process.env.DIFFERENTIAL_RUN) return
    for (const outcome of ["claimed", "advanced", "compensated", "retried", "deferred", "stalled", "leaseLost", "failed"]) expect(coverage.outcomes[outcome] ?? 0, `outcome ${outcome}`).toBeGreaterThan(0)
    for (const status of ["pending", "waiting", "compensating", "succeeded", "failed", "cancelled", "compensation_failed"]) expect(coverage.statuses.has(status), `status ${status}`).toBe(true)
    const missing = ["STEP_FAILED", "RETRY_EXHAUSTED", "TIMEOUT", "STEP_NOT_DEFINED", "INVALID_STEP_RESULT", "DECODE_FAILED", "CANCELLED", "STEP_ERROR"].filter((code) => !coverage.failureCodes.has(code))
    expect(missing, "failure codes never produced").toEqual([])
    expect(coverage.resumedBySignal).toBeGreaterThan(0)
  })
})
