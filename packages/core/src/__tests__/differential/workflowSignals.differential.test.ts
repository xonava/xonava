import { describe, expect, it, vi } from "vitest"
import { forAllAsync, scaledRuns, type Rng } from "./harness"
import { drive, flush, ManualClock, MemoryWorkflowStore, signalLedgerViolations } from "./workflowFixtures"
import { buildWorld, generateSignalWorld, LEASE_MS, STEP_TIMEOUT_MS, stableJson, type Behavior, type StepSpec, type World, type WorldSpec } from "./workflowWorld"
import { ModelDispatcher, type ModelRow } from "./workflowModel"
import { dispatchWorkflows, type WorkflowDispatchOptions } from "../../workflow/workflowDispatcher"
import type { WorkflowFence, WorkflowStore } from "../../workflow/store"
import { isWorkflowSignalWait, oldestPendingWorkflowSignal, resumeWorkflowFromBufferedSignal } from "../../workflow/workflowStateMachine"
import type { WorkflowInstance } from "../../workflow/types"

/**
 * Signal buffering (docs/spec/workflow.md, "Signals"): receipts are durable, each is consumed at most once, a delivery to a waiting
 * instance and the commit of a `wait` both consume the OLDEST pending receipt of the awaited name atomically, and the resumed step
 * receives exactly the receipt that resumed it. The properties check the in-memory reference store against an independent model, and
 * the structural invariants (signalLedgerViolations) under concurrent dispatchers, interleaved deliveries, and lease loss.
 */

vi.setConfig({ testTimeout: 60_000 * Math.max(1, scaledRuns(100) / 100) })

const SCOPE = { kind: "tenant", tenantId: "t1" } as const
const IDS = ["i0", "i1", "i2"] as const
const TERMINAL = ["succeeded", "failed", "cancelled", "compensation_failed"]

function emptyStep(): StepSpec { return { retry: undefined, compensationRetry: undefined, idempotent: undefined, hasCompensate: true, exec: [{ k: "complete" }], comp: [{ k: "complete" }] } }

/** One step `a` whose invocations run `script` in order (the last entry repeats); b..d are trivial. */
function scriptedWorld(script: Behavior[], extra: Partial<WorldSpec> = {}): WorldSpec {
  return { graceMs: 20, steps: { a: { ...emptyStep(), exec: script }, b: emptyStep(), c: emptyStep(), d: emptyStep() }, v2: null, ...extra }
}

function startInstance(store: MemoryWorkflowStore, id: string): Promise<WorkflowInstance> {
  return store.start({ id, workflowType: "order", workflowVersion: 1, executionScope: SCOPE, initialStep: "a", variables: {} })
}

function dispatchOptions(world: World, store: WorkflowStore, clock: ManualClock, extra: Partial<WorkflowDispatchOptions> = {}): WorkflowDispatchOptions {
  return { store, registry: world.registry, workerId: "w1", claimLimit: 4, leaseDurationMs: LEASE_MS, stepTimeoutMs: STEP_TIMEOUT_MS, cancellationGraceMs: 20, clock, random: () => 0.5, ...extra }
}

function expectNoViolations(store: MemoryWorkflowStore, label: string): void {
  expect(signalLedgerViolations(store.ledger()), `${label}: signal ledger`).toEqual([])
  expect(store.consumptions.length, `${label}: every consumption recorded once`).toBe(store.consumed.size)
}

/** Generator coverage, accumulated across runs and asserted by the guard test below. */
const coverage = { viaCommit: 0, viaDeliver: 0, leftPending: 0, duplicates: 0, afterTerminal: 0, compensating: 0, resumedWithSignal: 0, interleavedCommit: 0, interleavedDeliver: 0, zombies: 0 }

// ---------------------------------------------------------------------------
// 1. Model equivalence

type Op =
  | { t: "start"; id: string }
  | { t: "advance"; ms: number }
  | { t: "signal"; id: string; name: string; sid: string }
  | { t: "cancel"; id: string }
  | { t: "dispatch"; limit: number; worker: string; parallel: boolean }

interface SignalCase { world: WorldSpec; ops: Op[] }

function generateOp(rng: Rng, serial: number): Op {
  const roll = rng.int(100)
  if (roll < 10) return { t: "start", id: rng.pick(IDS) }
  if (roll < 24) return { t: "advance", ms: rng.pick([0, 1, 40, 300, 1_200, 5_000]) }
  if (roll < 62) return { t: "signal", id: rng.bool(0.05) ? "ghost" : rng.pick(IDS), name: rng.pick(["go", "go", "stop", "other"]), sid: rng.bool(0.15) ? `dup-${rng.int(3)}` : `sig-${serial}` }
  if (roll < 66) return { t: "cancel", id: rng.pick(IDS) }
  return { t: "dispatch", limit: 1 + rng.int(3), worker: rng.pick(["w1", "w2"]), parallel: rng.bool(0.3) }
}

function generateSignalCase(rng: Rng): SignalCase {
  return { world: generateSignalWorld(rng), ops: Array.from({ length: 8 + rng.int(40) }, (_, index) => generateOp(rng, index)) }
}

function* shrinkCase(value: SignalCase): Iterable<SignalCase> {
  for (let index = 0; index < value.ops.length; index++) yield { ...value, ops: value.ops.filter((_, position) => position !== index) }
}

function projectRow(row: WorkflowInstance): unknown {
  return {
    status: row.status, step: row.currentStep, attempt: row.stepAttempt, stack: row.compensationStack, signal: row.waitingSignal, resume: row.resumeSignalId ?? null, wakeAt: row.wakeAt?.getTime() ?? null,
    outcome: row.outcome, revision: row.revision, vars: JSON.parse(stableJson(row.variables)), leased: row.leaseOwner !== null, leaseExpiresAt: row.leaseExpiresAt?.getTime() ?? null, failureCode: row.failure?.code ?? null,
  }
}

function projectModel(row: ModelRow): unknown {
  return {
    status: row.status, step: row.step, attempt: row.attempt, stack: row.stack, signal: row.signal, resume: row.resume, wakeAt: row.wakeAt, outcome: row.outcome, revision: row.revision,
    vars: JSON.parse(stableJson(row.vars)), leased: row.leased, leaseExpiresAt: row.leaseExpiresAt, failureCode: row.failure?.code ?? null,
  }
}

describe("workflow signal buffering — model equivalence", () => {
  it("rows, receipts, consumption order and resumed signals match the reference model under random signal-heavy interleavings", async () => {
    await forAllAsync("workflow signal buffering model equivalence", generateSignalCase, async (value) => {
      const clock = new ManualClock()
      const store = new MemoryWorkflowStore(clock)
      const world: World = buildWorld(value.world, clock, store)
      const model = new ModelDispatcher(value.world, clock.current, [0.5])
      for (const [index, op] of value.ops.entries()) {
        const label = `op #${index} ${op.t}`
        switch (op.t) {
          case "start": {
            if (store.rows.has(op.id)) break
            await startInstance(store, op.id)
            model.start(op.id, "order", 1, {})
            break
          }
          case "advance": await clock.jumpTo(clock.current + op.ms); model.time += op.ms; break
          case "signal": {
            const row = model.rows.get(op.id)
            const known = model.receipts.some((receipt) => receipt.id === op.sid)
            const expected = !row ? { delivered: false, duplicate: false } : known ? { delivered: false, duplicate: true } : ["succeeded", "failed", "cancelled", "compensation_failed"].includes(row.status) ? { delivered: false, duplicate: false } : { delivered: true, duplicate: false }
            const before = store.receipts.length
            expect(await store.deliverSignal({ id: op.sid, instanceId: op.id, name: op.name, payload: { n: index } }), `${label}: delivery result`).toEqual(expected)
            expect(store.receipts.length - before, `${label}: stored receipts`).toBe(expected.delivered ? 1 : 0)
            if (expected.duplicate) coverage.duplicates++
            if (row && !expected.delivered && !expected.duplicate) coverage.afterTerminal++
            if (row?.status === "compensating") coverage.compensating++
            model.signal(op.id, op.name, op.sid)
            break
          }
          case "cancel": expect(await store.cancel(op.id), `${label}: cancel`).toBe(model.cancel(op.id)); break
          case "dispatch": {
            const result = await drive(dispatchWorkflows(dispatchOptions(world, store, clock, { workerId: op.worker, claimLimit: op.limit, ...(op.parallel ? { concurrency: op.limit } : {}) })), clock)
            const expected = model.dispatch(op.limit, op.parallel)
            expect({ ...result }, `${label}: dispatch result`).toEqual({ ...expected })
            expect(clock.current, `${label}: clock`).toBe(model.time)
            const perInstance = (log: typeof world.log): Record<string, unknown[]> => log.reduce<Record<string, unknown[]>>((acc, entry) => { (acc[entry.id] ??= []).push(entry); return acc }, {})
            expect(perInstance(world.log), `${label}: step invocations (including the receipt each resumed step saw)`).toEqual(perInstance(model.log))
            break
          }
        }
        expect([...store.rows.keys()].sort(), `${label}: instances`).toEqual([...model.rows.keys()].sort())
        for (const [id, expectedRow] of model.rows) expect(projectRow(store.rows.get(id)!), `${label}: ${id}`).toEqual(projectModel(expectedRow))
        expect(store.receipts.map((receipt) => receipt.id), `${label}: receipts in delivery order`).toEqual(model.receipts.map((receipt) => receipt.id))
        expect([...store.consumed.keys()].sort(), `${label}: consumed receipts`).toEqual(model.receipts.filter((receipt) => receipt.consumed).map((receipt) => receipt.id).sort())
        expectNoViolations(store, label)
      }
      // The resumed step saw exactly the receipt that resumed it: a claim's resume id is the latest consumption of that instance before the claim.
      for (const claim of store.claims) {
        if (claim.resumeSignalId === null) continue
        const earlier = store.consumptions.slice(0, claim.consumedBefore).filter((record) => record.instanceId === claim.instanceId)
        expect(claim.resumeSignalId, `claim ${claim.claimToken}: resume receipt`).toBe(earlier.at(-1)?.signalId)
      }
      for (const entry of world.log) if (entry.signalId !== null) {
        coverage.resumedWithSignal++
        expect(store.receipts.find((receipt) => receipt.id === entry.signalId)?.instanceId, "a step only sees receipts of its own instance").toBe(entry.id)
        expect(store.consumed.has(entry.signalId), "a step only sees consumed receipts").toBe(true)
      }
      for (const record of store.consumptions) coverage[record.via === "commit" ? "viaCommit" : "viaDeliver"]++
      coverage.leftPending += store.receipts.filter((receipt) => !store.consumed.has(receipt.id)).length
    }, { runs: 300, shrink: shrinkCase, describe: (value) => JSON.stringify(value) })
  })
})

// ---------------------------------------------------------------------------
// 2. Store-level delivery contract against an independent oracle

type StoreOp =
  | { t: "state"; id: string; kind: "pending" | "waiting" | "retryTimer" | "sleeping" | "cancelled" | "compensating" | "succeeded" }
  | { t: "deliver"; id: string; name: string; sid: string }

interface DeliveryCase { ops: StoreOp[] }

function generateDeliveryCase(rng: Rng): DeliveryCase {
  return {
    ops: Array.from({ length: 6 + rng.int(40) }, (_, serial): StoreOp => rng.bool(0.3)
      ? { t: "state", id: rng.pick(["x", "y"]), kind: rng.pick(["pending", "waiting", "waiting", "retryTimer", "sleeping", "cancelled", "compensating", "succeeded"] as const) }
      : { t: "deliver", id: rng.pick(["x", "y", "ghost"]), name: rng.pick(["go", "stop"]), sid: rng.bool(0.2) ? `dup-${rng.int(3)}` : `sig-${serial}` }),
  }
}

describe("workflow signal buffering — delivery contract", () => {
  it("deliverSignal is idempotent by id, ignores unknown and terminal instances, buffers while not waiting, and consumes the oldest pending receipt only when waiting for that name", async () => {
    await forAllAsync("workflow signal delivery contract", generateDeliveryCase, async (value) => {
      const clock = new ManualClock()
      const store = new MemoryWorkflowStore(clock)
      for (const id of ["x", "y"]) await startInstance(store, id)
      // Independent oracle: per-instance receipt list with consumed flags, and the instance's wait state.
      const oracle = new Map<string, { receipts: { id: string; name: string; consumed: boolean }[]; wait: string | null; terminal: boolean; resume: string | null }>(
        ["x", "y"].map((id) => [id, { receipts: [], wait: null, terminal: false, resume: null }]))
      const seen = new Set<string>()
      for (const [index, op] of value.ops.entries()) {
        const label = `op #${index} ${JSON.stringify(op)}`
        if (op.t === "state") {
          const row = store.rows.get(op.id)!
          const o = oracle.get(op.id)!
          if (o.terminal) continue
          const base = { ...row, leaseOwner: null, claimToken: null, leaseExpiresAt: null }
          switch (op.kind) {
            case "pending": store.rows.set(op.id, { ...base, status: "pending", waitingSignal: null, wakeAt: null, resumeSignalId: null }); o.wait = null; o.resume = null; break
            case "waiting": {
              // A real `wait` commit: it parks the instance, unless a receipt of that name is already buffered (then the oldest is consumed at once).
              const leased = { ...base, status: "pending" as const, waitingSignal: null, wakeAt: null, resumeSignalId: null, leaseOwner: "w", claimToken: "t", leaseExpiresAt: new Date(clock.current + 1_000) }
              store.rows.set(op.id, leased)
              const accepted = await store.commit({ instanceId: op.id, workerId: "w", claimToken: "t", revision: leased.revision }, { ...leased, status: "waiting", waitingSignal: "go", leaseOwner: null, claimToken: null, leaseExpiresAt: null })
              expect(accepted, "the wait commit is accepted").toBe(true)
              const oldest = o.receipts.find((receipt) => receipt.name === "go" && !receipt.consumed)
              if (oldest) {
                oldest.consumed = true
                o.wait = null
                o.resume = oldest.id
                expect(store.rows.get(op.id), `${label}: wait commit consumed the oldest buffered receipt`).toMatchObject({ status: "pending", waitingSignal: "go", resumeSignalId: oldest.id, stepAttempt: 0, wakeAt: null, revision: leased.revision + 1, leaseOwner: null })
                coverage.viaCommit++
              } else {
                o.wait = "go"
                o.resume = null
                expect(store.rows.get(op.id), `${label}: parked`).toMatchObject({ status: "waiting", waitingSignal: "go", resumeSignalId: null })
              }
              break
            }
            // A resumed step waiting out a retry backoff still records its signal name, but is not waiting for a signal.
            case "retryTimer": store.rows.set(op.id, { ...base, status: "waiting", waitingSignal: "go", wakeAt: new Date(clock.current + 1_000), resumeSignalId: null }); o.wait = null; break
            case "sleeping": store.rows.set(op.id, { ...base, status: "waiting", waitingSignal: null, wakeAt: new Date(clock.current + 1_000), resumeSignalId: null }); o.wait = null; break
            // Cancelling a compensating instance is a no-op: it keeps undoing its work.
            // (An instance with a compensation stack compensates first, and so is not terminal yet.)
            case "cancelled": if (await store.cancel(op.id)) { o.terminal = store.rows.get(op.id)!.status === "cancelled"; o.wait = null } break
            case "compensating": store.rows.set(op.id, { ...base, status: "compensating", compensationStack: ["undo"], waitingSignal: null, wakeAt: null, resumeSignalId: null }); o.wait = null; break
            case "succeeded": store.rows.set(op.id, { ...base, status: "succeeded", outcome: "succeeded", waitingSignal: null, wakeAt: null, resumeSignalId: null }); o.terminal = true; o.wait = null; break
          }
          continue
        }
        const o = oracle.get(op.id)
        const before = store.receipts.length
        const revisionBefore = store.rows.get(op.id)?.revision
        const result = await store.deliverSignal({ id: op.sid, instanceId: op.id, name: op.name, payload: {} })
        if (!o) { expect(result, label).toEqual({ delivered: false, duplicate: false }); expect(store.receipts.length, label).toBe(before); continue }
        if (seen.has(op.sid)) {
          expect(result, `${label}: duplicate id`).toEqual({ delivered: false, duplicate: true })
          expect(store.receipts.length, `${label}: nothing stored`).toBe(before)
          expect(store.rows.get(op.id)!.revision, `${label}: no effect`).toBe(revisionBefore)
          continue
        }
        if (o.terminal) {
          expect(result, `${label}: terminal instance`).toEqual({ delivered: false, duplicate: false })
          expect(store.receipts.length, `${label}: nothing stored for a terminal instance`).toBe(before)
          continue
        }
        seen.add(op.sid)
        expect(result, `${label}: stored`).toEqual({ delivered: true, duplicate: false })
        o.receipts.push({ id: op.sid, name: op.name, consumed: false })
        if (o.wait === op.name) {
          const oldest = o.receipts.find((receipt) => receipt.name === op.name && !receipt.consumed)!
          oldest.consumed = true
          o.wait = null
          o.resume = oldest.id
          expect(store.rows.get(op.id), `${label}: woken by the oldest pending receipt`).toMatchObject({ status: "pending", waitingSignal: op.name, resumeSignalId: oldest.id, stepAttempt: 0, wakeAt: null, revision: revisionBefore! + 1 })
          coverage.viaDeliver++
        } else {
          expect(store.rows.get(op.id)!.revision, `${label}: buffered without touching the instance`).toBe(revisionBefore)
          if (store.rows.get(op.id)!.status === "compensating") coverage.compensating++
        }
        expect(store.pending(op.id).map((receipt) => receipt.id), `${label}: pending receipts`).toEqual(o.receipts.filter((receipt) => !receipt.consumed).map((receipt) => receipt.id))
        expect((await store.getSignalById(op.id, op.sid))?.name, `${label}: lookup by id`).toBe(op.name)
      }
      expectNoViolations(store, "end")
      for (const [id, o] of oracle) {
        expect(store.pending(id).map((receipt) => receipt.id), `${id}: pending at the end (terminal instances retain theirs)`).toEqual(o.receipts.filter((receipt) => !receipt.consumed).map((receipt) => receipt.id))
        if (o.terminal) coverage.leftPending += o.receipts.filter((receipt) => !receipt.consumed).length
      }
    }, { runs: 300, describe: (value) => JSON.stringify(value) })
  })
})

// ---------------------------------------------------------------------------
// 3. FIFO across successive waits and concurrent interleavings

const waitScript = (names: readonly string[]): Behavior[] => [...names.map((sig): Behavior => ({ k: "wait", sig })), { k: "complete" }]

/**
 * After quiescence, the waits of `script` have consumed receipts greedily in delivery order per name. Returns the receipts each wait
 * consumed (in wait order) and the position reached.
 */
function scriptedOutcome(store: MemoryWorkflowStore, id: string, script: readonly string[]): { consumedBy: string[]; position: number } {
  const byName = new Map<string, string[]>()
  for (const receipt of store.receipts.filter((candidate) => candidate.instanceId === id)) byName.set(receipt.name, [...(byName.get(receipt.name) ?? []), receipt.id])
  const used = new Map<string, number>()
  const consumedBy: string[] = []
  for (const name of script) {
    const index = used.get(name) ?? 0
    const receipt = byName.get(name)?.[index]
    if (receipt === undefined) break
    used.set(name, index + 1)
    consumedBy.push(receipt)
  }
  return { consumedBy, position: consumedBy.length }
}

function expectScriptedFinal(store: MemoryWorkflowStore, world: World, id: string, script: readonly string[], label: string): void {
  const { consumedBy, position } = scriptedOutcome(store, id, script)
  const row = store.rows.get(id)!
  if (position === script.length) expect(row, `${label}: ${id} finished`).toMatchObject({ status: "succeeded", resumeSignalId: null })
  else expect(row, `${label}: ${id} parked on the first unsatisfied wait`).toMatchObject({ status: "waiting", waitingSignal: script[position]!, resumeSignalId: null, wakeAt: null })
  expect(store.consumptions.filter((record) => record.instanceId === id).map((record) => record.signalId), `${label}: ${id} consumption order`).toEqual(consumedBy)
  expect(world.log.filter((entry) => entry.id === id).map((entry) => entry.signalId), `${label}: ${id} each resumed step saw exactly the receipt that resumed it`).toEqual([null, ...consumedBy])
  // Everything not consumed stays pending, in delivery order.
  expect(store.pending(id).map((receipt) => receipt.id), `${label}: ${id} pending`).toEqual(store.receipts.filter((receipt) => receipt.instanceId === id && !consumedBy.includes(receipt.id)).map((receipt) => receipt.id))
}

interface FifoCase { script: string[]; items: Array<{ t: "deliver"; id: string; name: string; dup: boolean } | { t: "dispatch" } | { t: "advance" }> }

function generateFifo(rng: Rng): FifoCase {
  const script = Array.from({ length: 1 + rng.int(4) }, () => rng.pick(["go", "go", "stop"]))
  return {
    script,
    items: Array.from({ length: 3 + rng.int(14) }, (): FifoCase["items"][number] => {
      const roll = rng.int(100)
      if (roll < 55) return { t: "deliver", id: rng.pick(["i0", "i1"]), name: rng.pick(["go", "go", "stop", "other"]), dup: rng.bool(0.15) }
      if (roll < 90) return { t: "dispatch" }
      return { t: "advance" }
    }),
  }
}

describe("workflow signal buffering — FIFO and no lost signal", () => {
  it("several signals of one name are consumed oldest first across successive waits; other names and surplus signals stay pending", async () => {
    await forAllAsync("workflow signal buffering FIFO across waits", generateFifo, async (value) => {
      const clock = new ManualClock()
      const store = new MemoryWorkflowStore(clock)
      const world = buildWorld(scriptedWorld(waitScript(value.script)), clock, store)
      for (const id of ["i0", "i1"]) await startInstance(store, id)
      let serial = 0
      let last: string | undefined
      for (const item of value.items) {
        if (item.t === "deliver") {
          const sid = item.dup && last !== undefined ? last : `s${serial++}`
          const target = store.rows.get(item.id)!
          const known = store.receipts.some((receipt) => receipt.id === sid)
          const result = await store.deliverSignal({ id: sid, instanceId: item.id, name: item.name, payload: { sid } })
          expect(result, "delivery result").toEqual(known ? { delivered: false, duplicate: true } : TERMINAL.includes(target.status) ? { delivered: false, duplicate: false } : { delivered: true, duplicate: false })
          last = sid
        } else if (item.t === "dispatch") await drive(dispatchWorkflows(dispatchOptions(world, store, clock)), clock)
        else await clock.jumpTo(clock.current + 300)
        expectNoViolations(store, "step")
      }
      // Drain: everything that can run runs.
      for (let round = 0; round < 12; round++) {
        const result = await drive(dispatchWorkflows(dispatchOptions(world, store, clock)), clock)
        if (result.claimed === 0) break
      }
      for (const id of ["i0", "i1"]) expectScriptedFinal(store, world, id, value.script, "drained")
      for (const record of store.consumptions) coverage[record.via === "commit" ? "viaCommit" : "viaDeliver"]++
      coverage.leftPending += store.receipts.filter((receipt) => !store.consumed.has(receipt.id)).length
    }, { runs: 200, describe: (value) => JSON.stringify(value) })
  })

  it("a delivery racing the commit of a wait, across concurrent dispatchers, is neither lost nor consumed twice", async () => {
    interface RaceCase { script: string[]; instances: number; hops: number[]; deliveries: Array<{ id: number; name: string; round: number; start: number; dup: boolean }>; limits: number[]; rounds: number }
    const generate = (rng: Rng): RaceCase => ({
      script: Array.from({ length: 1 + rng.int(4) }, () => rng.pick(["go", "go", "stop"])),
      instances: 1 + rng.int(3),
      hops: Array.from({ length: 24 }, () => rng.int(7)),
      deliveries: Array.from({ length: 1 + rng.int(9) }, () => ({ id: rng.int(3), name: rng.pick(["go", "go", "stop", "other"]), round: rng.int(3), start: rng.int(12), dup: rng.bool(0.1) })),
      limits: Array.from({ length: 1 + rng.int(3) }, () => 1 + rng.int(3)),
      rounds: 1 + rng.int(3),
    })
    await forAllAsync("workflow signal delivery versus wait commit interleavings", generate, async (value) => {
      const clock = new ManualClock()
      const base = new MemoryWorkflowStore(clock)
      const world = buildWorld(scriptedWorld(waitScript(value.script)), clock, base)
      const ids = Array.from({ length: value.instances }, (_, index) => `i${index}`)
      for (const id of ids) await startInstance(base, id)
      // Every store call yields a few microtask turns first, so deliveries land before, between, and after claims and commits of the
      // concurrent dispatchers. Each method itself is atomic, as a database transaction is.
      let hopIndex = 0
      const hop = async (): Promise<void> => { for (let n = value.hops[hopIndex++ % value.hops.length]!; n > 0; n--) await Promise.resolve() }
      const violations: string[] = []
      const audit = (): void => { violations.push(...signalLedgerViolations(base.ledger())) }
      const store: WorkflowStore = {
        start: (input) => base.start(input), get: (id) => base.get(id), assertLease: (fence) => base.assertLease(fence), renewLease: (fence, ms) => base.renewLease(fence, ms), cancel: (id) => base.cancel(id),
        getSignal: (id, name) => base.getSignal(id, name), getSignalById: (id, signalId) => base.getSignalById(id, signalId),
        claimDue: async (args) => { await hop(); const claims = await base.claimDue(args); audit(); return claims },
        commit: async (fence: WorkflowFence, next: WorkflowInstance) => { await hop(); const consumed = base.consumptions.length; const ok = await base.commit(fence, next); if (base.consumptions.length > consumed) coverage.interleavedCommit++; audit(); return ok },
        deliverSignal: async (signal) => { await hop(); const consumed = base.consumptions.length; const result = await base.deliverSignal(signal); if (base.consumptions.length > consumed) coverage.interleavedDeliver++; audit(); return result },
      }
      const results: Array<{ sid: string; delivered: boolean; duplicate: boolean }> = []
      let serial = 0
      for (let round = 0; round < value.rounds; round++) {
        const work: Array<Promise<unknown>> = value.limits.map((limit, position) => dispatchWorkflows(dispatchOptions(world, store, clock, { workerId: `w${position + 1}`, claimLimit: limit, concurrency: limit })))
        for (const delivery of value.deliveries.filter((candidate) => candidate.round === round)) {
          const sid = delivery.dup && serial > 0 ? `s${serial - 1}` : `s${serial++}`
          work.push((async () => {
            for (let n = delivery.start; n > 0; n--) await Promise.resolve()
            const result = await store.deliverSignal({ id: sid, instanceId: ids[delivery.id % ids.length]!, name: delivery.name, payload: {} })
            results.push({ sid, ...result })
          })())
        }
        await drive(Promise.all(work), clock)
      }
      for (let round = 0; round < 15; round++) if ((await drive(dispatchWorkflows(dispatchOptions(world, base, clock)), clock)).claimed === 0) break
      expect(violations, "ledger invariants held after every store call").toEqual([])
      expectNoViolations(base, "end")
      for (const result of results) expect(result.delivered && result.duplicate, "delivered and duplicate are exclusive").toBe(false)
      expect(base.receipts.length, "stored receipts = accepted deliveries").toBe(results.filter((result) => result.delivered).length)
      for (const id of ids) expectScriptedFinal(base, world, id, value.script, "after the race")
      for (const claim of base.claims) expect(base.commits.filter((commit) => commit.claimToken === claim.claimToken && commit.accepted).length, "a claim commits at most once").toBeLessThanOrEqual(1)
      for (const record of base.consumptions.filter((candidate) => candidate.via === "commit")) {
        expect(base.commits.some((commit) => commit.instanceId === record.instanceId && commit.accepted && commit.fenceRevision + 1 === record.revision), "a commit consumption belongs to an accepted fenced commit").toBe(true)
      }
      coverage.leftPending += base.receipts.filter((receipt) => !base.consumed.has(receipt.id)).length
    }, { runs: 250, describe: (value) => JSON.stringify(value) })
  })
})

// ---------------------------------------------------------------------------
// 4. Crash and lease loss around delivery and commit

const ZOMBIE_LEASE_MS = 100

describe("workflow signal buffering — crash and lease loss", () => {
  it("a worker that loses its lease between a delivery and its commit consumes nothing; the takeover consumes each receipt exactly once", async () => {
    interface ZombieCase { pre: number; during: number; pauseMs: number; w2First: boolean; after: number; extraWaits: number }
    const generate = (rng: Rng): ZombieCase => ({ pre: rng.int(3), during: rng.int(3), pauseMs: rng.pick([0, 33, 99, 100, 101, 250, 5_000]), w2First: rng.bool(), after: rng.int(3), extraWaits: rng.int(3) })
    await forAllAsync("workflow signal lease loss between delivery and commit", generate, async (value) => {
      // Invocation 0 blocks at the gate and then waits for "go"; later invocations wait again `extraWaits` times and finish.
      const script: Behavior[] = [{ k: "gate", then: { k: "wait", sig: "go" } }, ...Array.from({ length: value.extraWaits }, (): Behavior => ({ k: "wait", sig: "go" })), { k: "complete" }]
      const clock = new ManualClock()
      const store = new MemoryWorkflowStore(clock)
      const world = buildWorld(scriptedWorld(script, { leaseMs: ZOMBIE_LEASE_MS, timeoutMs: 10_000 }), clock, store)
      await startInstance(store, "z")
      let serial = 0
      const deliver = async (count: number): Promise<void> => { for (let n = 0; n < count; n++) await store.deliverSignal({ id: `g${serial++}`, instanceId: "z", name: "go", payload: {} }) }
      const options = (workerId: string): WorkflowDispatchOptions => dispatchOptions(world, store, clock, { workerId, claimLimit: 1, leaseDurationMs: ZOMBIE_LEASE_MS, stepTimeoutMs: 10_000 })
      await deliver(value.pre)
      let release: () => void = () => undefined
      let gated = false
      world.gate = async () => { if (gated) return; gated = true; await new Promise<void>((resolve) => { release = resolve }) }
      const start = clock.current
      const first = dispatchWorkflows(options("w1"))
      await flush()
      expect(world.log.length, "the first worker is inside the step").toBe(1)
      const firstToken = store.claims[0]!.claimToken
      await deliver(value.during)
      expectNoViolations(store, "during the step")
      await clock.jumpTo(start + value.pauseMs)
      await flush()
      const alive = value.pauseMs < ZOMBIE_LEASE_MS
      if (!alive) coverage.zombies++
      if (value.w2First) await drive(dispatchWorkflows(options("w2")), clock)
      release()
      await flush()
      await drive(first, clock)
      if (!value.w2First) await drive(dispatchWorkflows(options("w2")), clock)
      await deliver(value.after)
      expectNoViolations(store, "after the race")
      // Drain with fresh signals: a parked instance must never hold a pending "go" receipt, and every receipt is consumed at most once.
      for (let round = 0; round < 20; round++) {
        const row = store.rows.get("z")!
        if (TERMINAL.includes(row.status)) break
        if (row.status === "waiting" && row.wakeAt === null) {
          expect(store.pending("z", "go"), "nothing pending while parked on go").toEqual([])
          await deliver(1)
        }
        await clock.jumpTo(clock.current + 2 * ZOMBIE_LEASE_MS)
        await drive(dispatchWorkflows(options(round % 2 === 0 ? "w1" : "w2")), clock)
        expectNoViolations(store, `drain ${round}`)
      }
      expect(store.rows.get("z")!.status, "the instance finishes").toBe("succeeded")
      // The dead worker never consumed anything: every commit-consumption belongs to an accepted fenced commit.
      for (const record of store.consumptions.filter((candidate) => candidate.via === "commit")) {
        expect(store.commits.some((commit) => commit.accepted && commit.fenceRevision + 1 === record.revision), "consumed by an accepted commit").toBe(true)
      }
      if (!alive) expect(store.commits.filter((commit) => commit.claimToken === firstToken && commit.accepted).length, "the zombie's commit was rejected").toBe(0)
      // The resumed step saw exactly the receipt that resumed it.
      expect(world.log.length, "every claim ran the step").toBe(store.claims.length)
      store.claims.forEach((claim, index) => {
        expect(world.log[index]!.signalId, `invocation ${index}`).toBe(claim.resumeSignalId)
        if (claim.resumeSignalId !== null) expect(claim.resumeSignalId, `claim ${index} carries the latest consumption`).toBe(store.consumptions.slice(0, claim.consumedBefore).at(-1)?.signalId)
      })
      for (const record of store.consumptions) coverage[record.via === "commit" ? "viaCommit" : "viaDeliver"]++
    }, { runs: 150, describe: (value) => JSON.stringify(value) })
  })
})

describe("workflow signal buffering — compatibility", () => {
  const waitThenComplete = (): WorldSpec => scriptedWorld([{ k: "wait", sig: "go" }, { k: "complete" }])

  async function resumedWith(store: MemoryWorkflowStore, clock: ManualClock, expose: (base: MemoryWorkflowStore) => WorkflowStore): Promise<World> {
    const world = buildWorld(waitThenComplete(), clock, store)
    await startInstance(store, "i0")
    await drive(dispatchWorkflows(dispatchOptions(world, store, clock)), clock)
    expect(store.rows.get("i0")).toMatchObject({ status: "waiting", waitingSignal: "go" })
    await store.deliverSignal({ id: "first", instanceId: "i0", name: "go", payload: {} })
    await store.deliverSignal({ id: "second", instanceId: "i0", name: "go", payload: {} })
    expect(store.rows.get("i0")).toMatchObject({ status: "pending", resumeSignalId: "first" })
    await drive(dispatchWorkflows(dispatchOptions(world, expose(store), clock)), clock)
    return world
  }

  it("a store without getSignalById keeps the legacy behaviour: the resumed step gets the latest receipt of that name", async () => {
    const clock = new ManualClock()
    const store = new MemoryWorkflowStore(clock)
    const world = await resumedWith(store, clock, (base) => ({
      start: (input) => base.start(input), get: (id) => base.get(id), claimDue: (args) => base.claimDue(args), assertLease: (fence) => base.assertLease(fence), renewLease: (fence, ms) => base.renewLease(fence, ms),
      commit: (fence, next) => base.commit(fence, next), deliverSignal: (signal) => base.deliverSignal(signal), cancel: (id) => base.cancel(id), getSignal: (id, name) => base.getSignal(id, name),
    }))
    expect(world.log.at(-1)?.signalId).toBe("second")
  })

  it("a store without any receipt lookup resumes the step without a signal", async () => {
    const clock = new ManualClock()
    const store = new MemoryWorkflowStore(clock)
    const world = await resumedWith(store, clock, (base) => ({
      start: (input) => base.start(input), get: (id) => base.get(id), claimDue: (args) => base.claimDue(args), assertLease: (fence) => base.assertLease(fence), renewLease: (fence, ms) => base.renewLease(fence, ms),
      commit: (fence, next) => base.commit(fence, next), deliverSignal: (signal) => base.deliverSignal(signal), cancel: (id) => base.cancel(id),
    }))
    expect(world.log.at(-1)?.signalId).toBeNull()
  })

  it("an instance persisted without resumeSignalId (resumed before the column existed) falls back to the latest receipt by name", async () => {
    const clock = new ManualClock()
    const store = new MemoryWorkflowStore(clock)
    const world = buildWorld(waitThenComplete(), clock, store)
    await startInstance(store, "i0")
    await drive(dispatchWorkflows(dispatchOptions(world, store, clock)), clock)
    await store.deliverSignal({ id: "first", instanceId: "i0", name: "go", payload: {} })
    const { resumeSignalId: _dropped, ...legacy } = store.rows.get("i0")!
    store.rows.set("i0", legacy)
    await drive(dispatchWorkflows(dispatchOptions(world, store, clock)), clock)
    expect(world.log.at(-1)?.signalId).toBe("first")
  })

  it("a receipt lookup that returns some other receipt is ignored", async () => {
    const clock = new ManualClock()
    const store = new MemoryWorkflowStore(clock)
    const world = await resumedWith(store, clock, (base) => ({
      start: (input) => base.start(input), get: (id) => base.get(id), claimDue: (args) => base.claimDue(args), assertLease: (fence) => base.assertLease(fence), renewLease: (fence, ms) => base.renewLease(fence, ms),
      commit: (fence, next) => base.commit(fence, next), deliverSignal: (signal) => base.deliverSignal(signal), cancel: (id) => base.cancel(id),
      getSignalById: (id) => base.getSignalById(id, "second"),
    }))
    expect(world.log.at(-1)?.signalId).toBeNull()
  })

  it("a delivery to a waiting instance that (through legacy state) already has older pending receipts consumes the OLDEST pending receipt", async () => {
    const clock = new ManualClock()
    const store = new MemoryWorkflowStore(clock)
    await startInstance(store, "i0")
    await store.deliverSignal({ id: "old", instanceId: "i0", name: "go", payload: {} })
    await store.deliverSignal({ id: "older-other-name", instanceId: "i0", name: "stop", payload: {} })
    store.rows.set("i0", { ...store.rows.get("i0")!, status: "waiting", waitingSignal: "go", wakeAt: null })
    expect(await store.deliverSignal({ id: "new", instanceId: "i0", name: "go", payload: {} })).toEqual({ delivered: true, duplicate: false })
    expect(store.rows.get("i0")).toMatchObject({ status: "pending", resumeSignalId: "old" })
    expect(store.pending("i0").map((receipt) => receipt.id)).toEqual(["older-other-name", "new"])
  })

  it("the buffered-signal state shapes are pure and consistent with what the store commits", async () => {
    const clock = new ManualClock()
    const store = new MemoryWorkflowStore(clock)
    const world = buildWorld(waitThenComplete(), clock, store)
    await startInstance(store, "i0")
    await store.deliverSignal({ id: "early", instanceId: "i0", name: "go", payload: { n: 1 } })
    await drive(dispatchWorkflows(dispatchOptions(world, store, clock)), clock)
    const resumed = store.rows.get("i0")!
    const receipt = store.receipts[0]!
    const committed: WorkflowInstance = { ...resumed, status: "waiting", resumeSignalId: null, stepAttempt: 0 }
    const expected = resumeWorkflowFromBufferedSignal(committed, receipt, resumed.updatedAt)
    expect(expected).toMatchObject({ status: "pending", waitingSignal: "go", resumeSignalId: "early", stepAttempt: 0, wakeAt: null, revision: committed.revision })
    expect(() => resumeWorkflowFromBufferedSignal({ ...committed, wakeAt: new Date(clock.current) }, receipt, resumed.updatedAt), "a timer wait is not a signal wait").toThrow()
    expect(() => resumeWorkflowFromBufferedSignal(committed, { ...receipt, name: "stop" }, resumed.updatedAt), "the receipt must match the awaited name").toThrow()
    expect(isWorkflowSignalWait(committed)).toBe(true)
    expect(isWorkflowSignalWait({ ...committed, wakeAt: new Date(clock.current) })).toBe(false)
    expect(oldestPendingWorkflowSignal([{ name: "stop", id: "a" }, { name: "go", id: "b" }, { name: "go", id: "c" }], "go")).toMatchObject({ id: "b" })
  })
})

describe("workflow signal buffering — generator coverage", () => {
  it("the generators exercise buffering, delivery wake-ups, duplicates, terminal and compensating targets, retained receipts, and lease loss (guards against vacuous properties)", () => {
    if (process.env.DIFFERENTIAL_RUN) return
    for (const key of Object.keys(coverage) as Array<keyof typeof coverage>) expect(coverage[key], `coverage: ${key}`).toBeGreaterThan(0)
  })
})
