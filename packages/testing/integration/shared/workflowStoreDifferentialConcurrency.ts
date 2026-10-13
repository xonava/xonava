import { expect, it } from "vitest"
import {
  createWorkflowRegistry, defineWorkflow, dispatchWorkflows,
  type WorkflowDispatchResult, type WorkflowFence, type WorkflowInstance, type WorkflowStepContext, type WorkflowStepDefinition, type WorkflowStepResult, type WorkflowStore,
} from "core/workflow"
import { forAllAsync, type Rng } from "../../../core/src/__tests__/differential/harness.js"
import { drive, ManualClock, MemoryWorkflowStore, signalLedgerViolations } from "../../../core/src/__tests__/differential/workflowFixtures.js"
import { canonical, coverage, coverageCount, PROPERTY_TIMEOUT_MS, SCOPE, type WorkflowStoreDriver } from "./workflowStoreDifferential.js"

/**
 * Real concurrency against the real workflow store: several dispatchers (core's `dispatchWorkflows`, the production claim -> step -> fenced
 * commit loop) run scripted chains of steps while other connections deliver signals, some of them racing the very commit of the wait they
 * satisfy, some duplicated concurrently, some for names nobody waits for, some for instances that do not exist or already finished.
 *
 * The expected behaviour is not hand-written. Everything a chain does is a deterministic function of what each step is handed, so the
 * per-instance outcome does not depend on the interleaving. The same scripts are therefore replayed once, sequentially, through core's
 * dispatcher on the in-memory reference store with a manual clock, after delivering the receipts the real store ended up holding in their
 * delivery (seq) order, and the real run must agree with that replay on:
 *   - the final instance (status, outcome, step, variables, compensation stack, waiting signal, resume receipt, failure, attempt counter);
 *   - the ordered log of step and compensation invocations of every instance (so no step effect ran twice for one committed attempt, and
 *     every resumed step saw exactly the receipt that resumed it, never an older or later receipt of the same name);
 *   - the set of consumed receipts (each at most once, oldest first, none lost) and the pending ones;
 *   - the dispatch counters (advanced / retried / compensated / failed / ... summed over all rounds).
 * On top of that the real run is checked on its own: the ledger invariants hold on the database rows, every delivery result agrees with what
 * the database stored (a delivered receipt is stored exactly once, a duplicate or dropped one never), and an idle dispatch after the run
 * claims nothing.
 */

const STEP_COUNT = 3
/** Dispatch leases and the settle deadline are far longer than any run needs, so a loaded machine cannot lapse a live lease or end the wait early. */
const LEASE_MS = 60_000
const SETTLE_DEADLINE_MS = 90_000
const SLEEP_MS = 12

interface StepScript { wait: "go" | "stop" | null; sleep: boolean; flaky: number; comp: boolean; fail: boolean }
interface Delivery { inst: number; name: string; delay: number; dupes: number; ghost: boolean }
interface ChainCase { scripts: StepScript[][]; workers: { limit: number; concurrency: number }[]; deliverers: number; deliveries: Delivery[] }

interface Invocation { id: string; step: string; phase: "execute" | "compensate"; attempt: number; signalId: string | null; waited: boolean; slept: boolean }

const retry = { maxAttempts: 5, initialDelayMs: 2, backoffMultiplier: 1, maxDelayMs: 2, jitter: "none" } as const

function buildRegistry(log: Invocation[], nowMs: () => number) {
  const steps: Record<string, WorkflowStepDefinition> = {}
  for (let index = 0; index < STEP_COUNT; index++) {
    const name = `p${index}`
    const scripts = (context: WorkflowStepContext): StepScript => (context.variables.s as StepScript[])[index]!
    steps[name] = {
      name, datasource: "primary", retry, compensationRetry: retry, idempotent: false,
      execute: async (context): Promise<WorkflowStepResult> => {
        const vars = context.variables
        const cfg = scripts(context)
        const slept = vars[`slept${index}`] === 1
        const waited = vars[`waited${index}`] === 1
        log.push({ id: context.instanceId, step: name, phase: "execute", attempt: context.attempt, signalId: context.signal?.id ?? null, waited, slept })
        if (cfg.sleep && !slept) return { kind: "sleep", wakeAt: new Date(nowMs() + SLEEP_MS), variables: { [`slept${index}`]: 1 } }
        if (cfg.wait !== null && !waited) return { kind: "wait", signal: cfg.wait, variables: { [`waited${index}`]: 1 } }
        if (context.attempt <= cfg.flaky) return { kind: "retry", error: "flaky" }
        if (cfg.fail) return { kind: "fail", error: "scripted failure" }
        const variables = { [`done${index}`]: 1 }
        if (index === (vars.s as StepScript[]).length - 1) return { kind: "complete", variables }
        return { kind: "next", step: `p${index + 1}`, variables, ...(cfg.comp ? { compensation: name } : {}) }
      },
      compensate: async (context) => { log.push({ id: context.instanceId, step: name, phase: "compensate", attempt: context.attempt, signalId: null, waited: false, slept: false }) },
    }
  }
  const registry = createWorkflowRegistry()
  registry.register(defineWorkflow({ type: "chain", version: 1, initialStep: "p0", steps, decodeVariables: (value) => value as Record<string, unknown> }))
  return registry
}

function generateChainCase(light: boolean) {
  return (rng: Rng): ChainCase => {
    const instances = light ? 1 + (rng.bool(0.3) ? 1 : 0) : 1 + rng.int(4)
    const length = light ? 2 : STEP_COUNT
    const scripts = Array.from({ length: instances }, () => Array.from({ length }, (_, index): StepScript => ({
      wait: rng.bool(0.6) ? rng.pick(["go", "go", "stop"] as const) : null, sleep: rng.bool(0.15), flaky: rng.pick([0, 0, 0, 1, 2]), comp: rng.bool(0.5), fail: rng.bool(index === length - 1 ? 0.15 : 0.1),
    })))
    const deliveries: Delivery[] = []
    for (const [inst, script] of scripts.entries()) {
      const needed = { go: 0, stop: 0 }
      for (const step of script) { if (step.wait) needed[step.wait]++; if (step.fail) break }
      for (const name of ["go", "stop"] as const) {
        const count = Math.max(0, needed[name] + rng.pick([-1, 0, 0, 0, 1, 2]))
        for (let n = 0; n < count; n++) deliveries.push({ inst, name, delay: rng.int(light ? 30 : 14), dupes: rng.bool(0.2) ? 1 : 0, ghost: false })
      }
      for (let n = rng.int(3); n > 0; n--) deliveries.push({ inst, name: "other", delay: rng.int(light ? 30 : 14), dupes: 0, ghost: false })
    }
    if (rng.bool(0.3)) deliveries.push({ inst: 0, name: "go", delay: rng.int(light ? 30 : 14), dupes: 0, ghost: true })
    return {
      scripts,
      workers: Array.from({ length: light ? 2 : 2 + rng.int(2) }, () => { const limit = 1 + rng.int(3); return { limit, concurrency: 1 + rng.int(limit) } }),
      deliverers: light ? 2 : 2 + rng.int(2),
      deliveries: rng.shuffle(deliveries),
    }
  }
}

function* shrinkChain(value: ChainCase): Iterable<ChainCase> {
  for (let index = 0; index < value.deliveries.length; index++) yield { ...value, deliveries: value.deliveries.filter((_, position) => position !== index) }
  if (value.scripts.length > 1) for (let index = 0; index < value.scripts.length; index++) {
    yield { ...value, scripts: value.scripts.filter((_, position) => position !== index), deliveries: value.deliveries.filter((delivery) => delivery.inst !== index).map((delivery) => (delivery.inst > index ? { ...delivery, inst: delivery.inst - 1 } : delivery)) }
  }
  if (value.workers.length > 1) yield { ...value, workers: value.workers.slice(1) }
  if (value.deliverers > 1) yield { ...value, deliverers: value.deliverers - 1 }
  for (const [inst, script] of value.scripts.entries()) for (const [index, step] of script.entries()) {
    for (const simpler of [{ ...step, sleep: false }, { ...step, flaky: 0 }, { ...step, fail: false }, { ...step, comp: false }].filter((candidate) => JSON.stringify(candidate) !== JSON.stringify(step))) {
      yield { ...value, scripts: value.scripts.map((item, position) => (position === inst ? item.map((entry, at) => (at === index ? simpler : entry)) : item)) }
    }
  }
}

const describeChain = (value: ChainCase): string => JSON.stringify(value)
const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

interface FinalView { status: string; outcome: string | null; currentStep: string; variables: unknown; compensationStack: string[]; waitingSignal: string | null; resumeSignalId: string | null; hasTimer: boolean; stepAttempt: number; failure: unknown }
function finalView(row: WorkflowInstance): FinalView {
  return {
    status: row.status, outcome: row.outcome, currentStep: row.currentStep, variables: canonical(row.variables), compensationStack: [...row.compensationStack], waitingSignal: row.waitingSignal, resumeSignalId: row.resumeSignalId ?? null,
    hasTimer: row.wakeAt !== null, stepAttempt: row.stepAttempt, failure: row.failure ? { code: row.failure.code, step: row.failure.step, phase: row.failure.phase, attempt: row.failure.attempt } : null,
  }
}

const settled = (row: WorkflowInstance): boolean => ["succeeded", "failed", "cancelled", "compensation_failed"].includes(row.status) || (row.status === "waiting" && row.wakeAt === null && row.leaseOwner === null)
const ZERO: WorkflowDispatchResult = { claimed: 0, advanced: 0, compensated: 0, retried: 0, deferred: 0, stalled: 0, leaseLost: 0, failed: 0 }
function add(total: WorkflowDispatchResult, part: WorkflowDispatchResult): void { for (const key of Object.keys(total) as Array<keyof WorkflowDispatchResult>) total[key] += part[key] }

let chainCounter = 0

/** Commit and get calls are observed so the run can tell a wait that consumed a buffered receipt at its commit from one woken by a delivery. */
function observed(store: WorkflowStore, onBufferedWait: () => void): WorkflowStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === "commit") {
        return async (fence: WorkflowFence, next: WorkflowInstance) => {
          const accepted = await target.commit(fence, next)
          if (accepted && next.status === "waiting" && next.wakeAt === null && next.waitingSignal !== null) {
            const after = await target.get(fence.instanceId)
            if (after && after.revision === fence.revision + 1 && after.status === "pending") onBufferedWait()
          }
          return accepted
        }
      }
      const value = (target as never)[property as never] as unknown
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}

async function runChain(driver: WorkflowStoreDriver, input: ChainCase): Promise<void> {
  const light = driver.light === true
  await driver.reset()
  const tag = `ch${Date.now().toString(36)}${++chainCounter}`
  const ids = input.scripts.map((_, index) => `${tag}-i${index}`)
  const bufferedAtCommit = { count: 0 }
  const log: Invocation[] = []
  const registry = buildRegistry(log, () => Date.now())
  const workerStores = input.workers.map(() => observed(driver.openStore(), () => { bufferedAtCommit.count++ }))
  const deliverStores = Array.from({ length: input.deliverers }, () => driver.openStore())
  const control = driver.store
  for (const [index, script] of input.scripts.entries()) await control.start({ id: ids[index]!, workflowType: "chain", workflowVersion: 1, executionScope: SCOPE, initialStep: "p0", variables: { s: script } })

  const stop = { value: false }
  const totals: WorkflowDispatchResult = { ...ZERO }
  const workers = input.workers.map(async (worker, index) => {
    while (!stop.value) {
      const result = await dispatchWorkflows({ store: workerStores[index]!, registry, workerId: `cw${index}`, claimLimit: worker.limit, concurrency: worker.concurrency, leaseDurationMs: LEASE_MS, stepTimeoutMs: 20_000 })
      add(totals, result)
      if (result.claimed === 0) await delay(light ? 30 : 3)
    }
  })

  // Deliveries: each deliverer sends its share one after the other (with the scripted pause), so deliverers race each other and the workers.
  interface Outcome { id: string; inst: number; name: string; results: Array<{ delivered: boolean; duplicate: boolean }> }
  const outcomes: Outcome[] = []
  const lanes = Array.from({ length: input.deliverers }, () => [] as Array<{ delivery: Delivery; id: string }>)
  input.deliveries.forEach((delivery, index) => lanes[index % input.deliverers]!.push({ delivery, id: `${tag}-sig${index}` }))
  const deliverers = lanes.map(async (lane, laneIndex) => {
    for (const { delivery, id } of lane) {
      await delay(delivery.delay)
      const instanceId = delivery.ghost ? `${tag}-ghost` : ids[delivery.inst]!
      const payload = { n: Number(id.split("sig")[1]), name: delivery.name }
      const sends = Array.from({ length: 1 + delivery.dupes }, (_, copy) => deliverStores[(laneIndex + copy) % deliverStores.length]!.deliverSignal({ id, instanceId, name: delivery.name, payload }))
      outcomes.push({ id, inst: delivery.ghost ? -1 : delivery.inst, name: delivery.name, results: await Promise.all(sends) })
    }
  })

  const deadline = Date.now() + SETTLE_DEADLINE_MS
  let rows: WorkflowInstance[] = []
  try {
    await Promise.all(deliverers)
    for (;;) {
      rows = []
      for (const id of ids) rows.push((await control.get(id))!)
      if (rows.every(settled)) break
      if (Date.now() > deadline) throw new Error(`the chains did not settle in time:\n${JSON.stringify(rows.map(finalView))}`)
      await delay(light ? 100 : 8)
    }
  } finally {
    stop.value = true
    await Promise.all(workers)
  }
  // Nothing may be claimable now, and a further dispatch must not change anything.
  const idle = await dispatchWorkflows({ store: driver.openStore(), registry, workerId: "idle", claimLimit: 10, leaseDurationMs: LEASE_MS })
  expect(idle, "an idle dispatch after the run claims nothing").toEqual(ZERO)

  rows = []
  for (const id of ids) rows.push((await control.get(id))!)
  const mine = new Set(ids)
  const receipts = (await driver.receipts()).filter((receipt) => mine.has(receipt.instanceId))
  expect(signalLedgerViolations({ receipts, consumed: new Set(receipts.filter((receipt) => receipt.consumed).map((receipt) => receipt.id)), rows }), "ledger invariants on the database rows").toEqual([])
  expect(new Set(receipts.map((receipt) => receipt.seq)).size, "seq is unique").toBe(receipts.length)

  // Every delivery result agrees with the database: stored exactly when delivered, never twice, duplicates only for a stored receipt.
  const stored = new Set(receipts.map((receipt) => receipt.id))
  for (const outcome of outcomes) {
    const delivered = outcome.results.filter((result) => result.delivered).length
    const duplicates = outcome.results.filter((result) => result.duplicate).length
    expect(delivered, `${outcome.id}: at most one concurrent copy is stored`).toBeLessThanOrEqual(1)
    expect(stored.has(outcome.id), `${outcome.id}: stored exactly when one copy reported delivered`).toBe(delivered === 1)
    expect(delivered + duplicates, `${outcome.id}: every copy is delivered, a duplicate, or dropped`).toBe(delivered === 1 ? outcome.results.length : duplicates)
    if (delivered === 0) expect(duplicates, `${outcome.id}: a dropped receipt has no duplicates`).toBe(0)
    if (outcome.inst === -1) expect(stored.has(outcome.id), "a receipt for an unknown instance is never stored").toBe(false)
  }

  // ---- sequential replay on the reference store
  const clock = new ManualClock()
  const reference = new MemoryWorkflowStore(clock)
  const referenceLog: Invocation[] = []
  const referenceRegistry = buildRegistry(referenceLog, () => clock.current)
  for (const [index, script] of input.scripts.entries()) await reference.start({ id: ids[index]!, workflowType: "chain", workflowVersion: 1, executionScope: SCOPE, initialStep: "p0", variables: { s: script } })
  const payloads = new Map<string, Record<string, unknown>>()
  for (const outcome of outcomes) payloads.set(outcome.id, { n: Number(outcome.id.split("sig")[1]), name: outcome.name })
  for (const receipt of receipts) await reference.deliverSignal({ id: receipt.id, instanceId: receipt.instanceId, name: receipt.name, payload: payloads.get(receipt.id) ?? {} })
  const referenceTotals: WorkflowDispatchResult = { ...ZERO }
  for (let round = 0; round < 400; round++) {
    const result = await drive(dispatchWorkflows({ store: reference, registry: referenceRegistry, workerId: "ref", claimLimit: 10, leaseDurationMs: LEASE_MS, stepTimeoutMs: 20_000, clock }), clock, { maxTimers: 5000 })
    add(referenceTotals, result)
    if (result.claimed > 0) continue
    const timers = [...reference.rows.values()].filter((row) => row.wakeAt !== null).map((row) => row.wakeAt!.getTime())
    if (timers.length === 0) break
    clock.current = Math.max(clock.current, Math.min(...timers))
  }

  const label = describeChain(input)
  for (const [index, id] of ids.entries()) {
    expect(finalView(rows[index]!), `${id}: final instance matches the sequential replay\n${label}`).toEqual(finalView(reference.rows.get(id)!))
    const realLog = log.filter((entry) => entry.id === id)
    expect(realLog, `${id}: ordered step invocations match the sequential replay (no step effect twice, resumed step sees its consuming receipt)\n${label}`).toEqual(referenceLog.filter((entry) => entry.id === id))
    // A resumed step is handed the receipt that resumed it: a consumed receipt of the awaited name, delivered to this instance.
    for (const entry of realLog) {
      if (entry.signalId === null) continue
      const receipt = receipts.find((candidate) => candidate.id === entry.signalId)
      expect(receipt, `${id}: ${entry.step} was handed a stored receipt`).toBeDefined()
      expect(receipt!.instanceId).toBe(id)
      expect(receipt!.consumed, `${id}: the receipt handed to ${entry.step} is consumed`).toBe(true)
    }
  }
  const view = (list: typeof receipts) => list.map((receipt) => ({ id: receipt.id, instanceId: receipt.instanceId, name: receipt.name, consumed: receipt.consumed }))
  expect(view(receipts), `the consumed / pending split of the ledger matches the sequential replay\n${label}`).toEqual(reference.receipts.map((receipt) => ({ id: receipt.id, instanceId: receipt.instanceId, name: receipt.name, consumed: reference.consumed.has(receipt.id) })))
  expect({ ...totals }, `dispatch counters match the sequential replay\n${label}`).toEqual({ ...referenceTotals })

  // Coverage of the interleavings the run really produced.
  const consumedTotal = receipts.filter((receipt) => receipt.consumed).length
  coverage(`chain:consumed:${Math.min(consumedTotal, 3)}`)
  if (bufferedAtCommit.count > 0) coverage("chain:wait-consumed-buffered-at-commit")
  if (consumedTotal > bufferedAtCommit.count) coverage("chain:wait-woken-by-delivery")
  if (outcomes.some((outcome) => outcome.results.length > 1 && outcome.results.some((result) => result.duplicate))) coverage("chain:concurrent-duplicate-detected")
  if (outcomes.some((outcome) => outcome.results.every((result) => !result.delivered && !result.duplicate))) coverage("chain:dropped-signal")
  if (rows.some((row) => row.status === "waiting")) coverage("chain:left-waiting")
  coverage(`chain:final:${[...new Set(rows.map((row) => row.status))].sort().join("+")}`)
  if (log.some((entry) => entry.phase === "compensate")) coverage("chain:compensated")
  if (totals.retried > 0) coverage("chain:retried")
}

export function defineWorkflowConcurrency(driver: WorkflowStoreDriver): void {
  it(`${driver.label}: concurrent dispatchers and signal deliverers reach the outcome of the sequential replay`, async () => {
    await forAllAsync(`workflow store differential concurrent dispatch (${driver.label})`, generateChainCase(driver.light === true), (value) => runChain(driver, value), {
      runs: driver.concurrencyRuns ?? (driver.light ? 50 : 100), shrink: shrinkChain, describe: describeChain, maxShrinkSteps: 60,
    })
  }, PROPERTY_TIMEOUT_MS)

  it(`${driver.label}: concurrency generator coverage`, () => {
    if (process.env.DIFFERENTIAL_RUN !== undefined && process.env.DIFFERENTIAL_RUN !== "") return
    for (const key of ["chain:wait-consumed-buffered-at-commit", "chain:wait-woken-by-delivery", "chain:dropped-signal", "chain:left-waiting", "chain:compensated", "chain:retried"]) expect(coverageCount(key), `generator reaches ${key}`).toBeGreaterThan(0)
  })
}
