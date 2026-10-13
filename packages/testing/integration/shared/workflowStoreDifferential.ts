import { appendFileSync } from "node:fs"
import { expect, it } from "vitest"
import {
  applyWorkflowStep, completeCompensation, createWorkflowFailure, failCompensation, failWorkflowStep, markWorkflowAttemptStalled, releaseWorkflowClaim, scheduleWorkflowRetry,
  type WorkflowClaim, type WorkflowFence, type WorkflowInstance, type WorkflowSignal, type WorkflowStepResult, type WorkflowStore,
} from "core/workflow"
import { forAllAsync, scaledRuns, type Rng } from "../../../core/src/__tests__/differential/harness.js"
import { ManualClock, MemoryWorkflowStore, signalLedgerViolations } from "../../../core/src/__tests__/differential/workflowFixtures.js"

/**
 * Store-contract differential for the SQL workflow stores (docs/spec/workflow.md, "Signals" and the transition table).
 *
 * A random sequence of WorkflowStore operations (start, claimDue by several workers with limits and leases, assertLease, renewLease,
 * commit of every transition kind produced by core's pure state-machine functions with correct and stale fences, deliverSignal with
 * duplicates / unknown / terminal instances, cancel, lookups) runs against the real store and, in lock step, against core's
 * MemoryWorkflowStore, which is the reference. After every operation (or every few operations on slow transports, see `light`) the
 * return values, every instance and the whole signal ledger (receipt id, instance, name, delivery order, consumed flag, consumed
 * revision) are compared, and `signalLedgerViolations` is evaluated on the database rows.
 *
 * Time. The SQL stores read the DATABASE clock for leases and timers, the reference reads a manual clock. The two are made to agree
 * by construction instead of by sleeping: every wake time is either far in the past (2020) or far in the future (2100) so it is
 * unambiguously due / not due on both clocks; leases are 30-60 s (live on both for the whole run); an `expire` operation rewrites a
 * lease on BOTH sides to a fixed instant in 2020, and a `due` operation rewrites a timer to a fixed instant in 2020. Lease expiry
 * values that the stores compute themselves are compared by class (none / live / expired), everything else exactly.
 *
 * Claim order. The stores order claims by `updated_at`, the reference by id; the order is not specified. The comparison checks that
 * the real claim is a duplicate-free subset of the instances that are due, of size min(limit, due), and then has the reference claim
 * exactly that set.
 */

export interface DbReceipt {
  readonly id: string
  readonly instanceId: string
  readonly name: string
  readonly seq: number
  readonly consumed: boolean
  readonly consumedRevision: number | null
}

export interface WorkflowStoreDriver {
  /** Property-name suffix, e.g. "postgres". */
  readonly label: string
  /** The store under test. */
  readonly store: WorkflowStore
  /** A second store handle for concurrent work (separate connections where the database has them). */
  openStore(): WorkflowStore
  /** Deletes every workflow and receipt. */
  reset(): Promise<void>
  /** Rewrites the lease of a leased instance to `at` (a past instant), on the database. */
  setLeaseExpiry(instanceId: string, at: Date): Promise<void>
  /** Rewrites the timer of an instance that has one to `at`, on the database. */
  setWakeAt(instanceId: string, at: Date): Promise<void>
  /** Every receipt in delivery (seq) order, read straight from the database. */
  receipts(): Promise<DbReceipt[]>
  /** Base run count of the sequential property at scale 1. */
  readonly lifecycleRuns?: number
  /** Maximum operations of a case (slow transports use fewer). */
  readonly maxOps?: number
  /** Slow transports compare only the touched instance after most operations and everything every 4th one and at the end. */
  readonly light?: boolean
  /** Base run count of the concurrency properties at scale 1. */
  readonly concurrencyRuns?: number
}

export const PROPERTY_TIMEOUT_MS = 300_000
export const SCOPE = { kind: "tenant", tenantId: "t1" } as const

// ---------------------------------------------------------------------------------------------------------------------
// Coverage

const COVERAGE = new Map<string, number>()
export function coverage(key: string): void { COVERAGE.set(key, (COVERAGE.get(key) ?? 0) + 1) }
export function printCoverage(label: string): void {
  const file = process.env.WORKFLOW_STORE_DIFFERENTIAL_STATS
  if (file) appendFileSync(file, `${label} coverage ${JSON.stringify(Object.fromEntries([...COVERAGE].sort()))}\n`)
}
export function coverageCount(prefix: string): number { return [...COVERAGE].filter(([key]) => key.startsWith(prefix)).reduce((sum, [, value]) => sum + value, 0) }

// ---------------------------------------------------------------------------------------------------------------------
// Canonical views

const EXPIRED_LEASE = new Date(Date.UTC(2020, 0, 2))
const DUE_AT = new Date(Date.UTC(2020, 0, 3))
const PAST = new Date(Date.UTC(2020, 0, 1))
const FUTURE = new Date(Date.UTC(2100, 0, 1))
/** The `now` handed to core's pure functions: it ends up in failure records, which the stores must round-trip. */
const NOW0 = new Date(Date.UTC(2026, 5, 1, 12, 30, 15, 123))

/** Deeply key-sorted copy: PostgreSQL jsonb and MySQL JSON do not preserve object key order. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([key, item]) => [key, canonical(item)]))
  return value
}

export function projectInstance(instance: WorkflowInstance | null | undefined, nowMs: number): unknown {
  if (!instance) return null
  const failure = instance.failure
  return {
    id: instance.id, workflowType: instance.workflowType, workflowVersion: instance.workflowVersion, executionScope: canonical(instance.executionScope), status: instance.status,
    currentStep: instance.currentStep, variables: canonical(instance.variables), stepAttempt: instance.stepAttempt, compensationStack: [...instance.compensationStack],
    waitingSignal: instance.waitingSignal, resumeSignalId: instance.resumeSignalId ?? null, wakeAt: instance.wakeAt === null ? null : instance.wakeAt.getTime(), outcome: instance.outcome,
    revision: instance.revision,
    // A cancellation stamps the failure with the STORE's clock; every other failure carries the instant the test passed in.
    failure: failure ? { code: failure.code, message: failure.message, step: failure.step, phase: failure.phase, attempt: failure.attempt, ...(failure.code === "CANCELLED" ? {} : { at: failure.at.getTime() }) } : null,
    leaseOwner: instance.leaseOwner, hasClaimToken: instance.claimToken !== null,
    lease: instance.leaseExpiresAt === null ? null : instance.leaseExpiresAt.getTime() > nowMs ? "live" : "expired",
  }
}

function projectSignal(signal: WorkflowSignal | null | undefined): unknown {
  if (!signal) return null
  return { id: signal.id, instanceId: signal.instanceId, name: signal.name, payload: canonical(signal.payload) }
}

// ---------------------------------------------------------------------------------------------------------------------
// The reference store: MemoryWorkflowStore, plus a way to make it claim exactly the instances the real store claimed.

class ReferenceStore extends MemoryWorkflowStore {
  constructor(private readonly manual: ManualClock) { super(manual) }
  /** Ids that a claim with no limit would take right now. */
  async dueIds(): Promise<string[]> {
    const probe = new MemoryWorkflowStore(this.manual)
    for (const [id, row] of this.rows) probe.rows.set(id, row)
    return (await probe.claimDue({ workerId: "probe", limit: 1_000_000, leaseDurationMs: 1 })).map((claim) => claim.instance.id)
  }
  async claimExactly(ids: readonly string[], args: { workerId: string; leaseDurationMs: number }): Promise<readonly WorkflowClaim[]> {
    const chosen = new Set(ids)
    const hidden = [...this.rows].filter(([id]) => !chosen.has(id))
    for (const [id] of hidden) this.rows.delete(id)
    try {
      const claims = await super.claimDue({ ...args, limit: Math.max(1, ids.length) })
      return claims
    } finally { for (const [id, row] of hidden) this.rows.set(id, row) }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Operations

/** Instances per case on fast transports (slow transports use fewer, so each one gets deeper into its life cycle within the statement budget). */
export const INSTANCES = 4
const STEPS = ["a", "b", "c", "d"] as const
const SIGNALS = ["go", "stop", "other"] as const
type Mutation = "ok" | "worker" | "token" | "revLow" | "revHigh"
interface Selector { inst: number; back: number; mutate: Mutation; aim: boolean }
type SignalId = "fresh" | "dupSame" | "dupOther" | "dupLast"

type Op =
  | { t: "start"; inst: number; vars: Record<string, unknown> }
  | { t: "claim"; worker: number; limit: number; lease: number }
  | { t: "assert"; sel: Selector }
  | { t: "renew"; sel: Selector; extend: number }
  | { t: "commit"; sel: Selector; kind: number; vars: Record<string, unknown> | undefined; sig: string; wake: "past" | "future"; step: string; comp: string | undefined; text: string }
  | { t: "signal"; inst: number; name: string; id: SignalId; payload: Record<string, unknown>; aim: boolean }
  | { t: "cancel"; inst: number; aim: boolean }
  | { t: "expire"; inst: number; aim: boolean }
  | { t: "due"; inst: number; aim: boolean }
  | { t: "get"; inst: number | "ghost" }

interface Case { ops: Op[]; instances: number }

function randomValue(rng: Rng, depth: number): unknown {
  const roll = rng.int(depth > 1 ? 7 : 9)
  switch (roll) {
    case 0: return rng.int(1000)
    case 1: return rng.pick(["x", "héllo wörld", "emoji 😀 ok", "quote \" backslash \\ tab \t newline \n", "", "  spaced  ", "{\"nested\":\"json\"}", "o'brien; DROP TABLE workflows;--"])
    case 2: return rng.bool()
    case 3: return null
    case 4: return rng.pick([0.5, -1.25, 1e-7, 123456789012, 2.5e10, -0.001])
    case 5: return "z".repeat(1 + rng.int(300))
    case 6: return rng.int(2) === 0 ? [] : {}
    case 7: return Array.from({ length: rng.int(4) }, () => randomValue(rng, depth + 1))
    default: return Object.fromEntries(Array.from({ length: rng.int(4) }, (_, index) => [rng.pick(["k", "key two", "ünï", "a.b", "z", "m", "0", "$x"]) + index, randomValue(rng, depth + 1)]))
  }
}
function randomObject(rng: Rng, max = 4): Record<string, unknown> {
  return Object.fromEntries(Array.from({ length: rng.int(max + 1) }, (_, index) => [rng.pick(["k", "v", "n", "list", "obj", "ünï", "a b"]) + index, randomValue(rng, 0)]))
}

function selector(rng: Rng, instanceCount: number): Selector {
  return { inst: rng.int(instanceCount), back: rng.pick([0, 0, 0, 0, 1, 2]), mutate: rng.pick(["ok", "ok", "ok", "ok", "ok", "ok", "worker", "token", "revLow", "revHigh"] as const), aim: rng.bool(0.7) }
}
const SIGNAL_NAME_WEIGHTS = ["go", "go", "go", "stop", "stop", "other"] as const

function generateOp(rng: Rng, instanceCount: number): Op {
  const roll = rng.int(100)
  if (roll < 4) return { t: "start", inst: rng.int(instanceCount), vars: randomObject(rng, 2) }
  if (roll < 22) return { t: "claim", worker: rng.int(3), limit: rng.pick([1, 1, 2, 3, 10]), lease: rng.pick([30_000, 60_000]) }
  if (roll < 27) return { t: "assert", sel: selector(rng, instanceCount) }
  if (roll < 32) return { t: "renew", sel: selector(rng, instanceCount), extend: rng.pick([1, 1000, 120_000]) }
  if (roll < 66) {
    return {
      t: "commit", sel: selector(rng, instanceCount), kind: rng.int(1000), vars: rng.bool(0.5) ? randomObject(rng, 3) : undefined, sig: rng.pick(SIGNAL_NAME_WEIGHTS), wake: rng.pick(["past", "future", "future"] as const),
      step: rng.pick(STEPS), comp: rng.bool(0.55) ? rng.pick(STEPS) : undefined,
      text: rng.pick(["boom", "service down: contact ops@example.com or +1 (555) 123-4567", "x".repeat(700), "héllo 😀", "plain failure"]),
    }
  }
  if (roll < 88) return { t: "signal", inst: rng.int(instanceCount + 1), name: rng.pick(SIGNAL_NAME_WEIGHTS), id: rng.pick(["fresh", "fresh", "fresh", "fresh", "dupSame", "dupOther", "dupLast"] as const), payload: randomObject(rng, 3), aim: rng.bool(0.7) }
  if (roll < 90) return { t: "cancel", inst: rng.int(instanceCount), aim: rng.bool(0.7) }
  if (roll < 93) return { t: "expire", inst: rng.int(instanceCount), aim: rng.bool(0.7) }
  if (roll < 97) return { t: "due", inst: rng.int(instanceCount), aim: rng.bool(0.8) }
  return { t: "get", inst: rng.bool(0.2) ? "ghost" : rng.int(instanceCount) }
}

/**
 * A short saga (forward steps that register compensations, a failure, then the compensation steps), so compensation transitions are reached.
 * Slow transports run a single instance through one compensation.
 */
function sagaPrefix(rng: Rng, light: boolean): Op[] {
  const ops: Op[] = []
  const commit = (inst: number, kind: number, comp?: string): Op => ({ t: "commit", sel: { inst, back: 0, mutate: "ok", aim: true }, kind, vars: undefined, sig: "go", wake: "future", step: rng.pick(STEPS), comp, text: "saga failure" })
  const rounds = light ? ([[0, "a"], [10, undefined], [5, undefined]] as const) : ([[0, "a"], [0, "b"], [10, undefined], [5, undefined], [5, undefined], [5, undefined]] as const)
  for (const [kind, comp] of rounds) {
    for (const inst of light ? [0] : [0, 1]) ops.push({ t: "claim", worker: inst, limit: 10, lease: 60_000 }, commit(inst, kind, comp))
    // A receipt delivered while the instance compensates is buffered (the instance is not woken, its revision is untouched).
    if (kind === 10 && !light) ops.push({ t: "signal", inst: 2, name: rng.pick(["go", "stop"]), id: "fresh", payload: { while: "compensating" }, aim: true })
  }
  return ops
}

/** Two signals that arrive while the step is still running, then the wait for them: the commit must consume the OLDEST buffered receipt and leave the other pending. Then a claim of the resumed step. */
function earlyPrefix(rng: Rng): Op[] {
  const name = rng.pick(["go", "stop"])
  return [
    { t: "claim", worker: 0, limit: 10, lease: 60_000 },
    { t: "signal", inst: 1, name, id: "fresh", payload: { early: true }, aim: true },
    { t: "signal", inst: 1, name, id: "fresh", payload: { early: "second" }, aim: true },
    { t: "commit", sel: { inst: 1, back: 0, mutate: "ok", aim: true }, kind: 3, vars: undefined, sig: name, wake: "future", step: "a", comp: undefined, text: "x" },
    // Half the time the resumed instance is cancelled before it runs again: cancellation clears the resume receipt (receipts stay).
    rng.bool(0.5) ? { t: "cancel", inst: 1, aim: true } : { t: "claim", worker: 1, limit: 10, lease: 60_000 },
  ]
}

/** A wait, then a delivery of the awaited name: the delivery consumes the receipt and wakes the instance. */
function wakePrefix(rng: Rng): Op[] {
  const name = rng.pick(["go", "stop"])
  return [
    { t: "claim", worker: 0, limit: 10, lease: 60_000 },
    { t: "commit", sel: { inst: 0, back: 0, mutate: "ok", aim: true }, kind: 3, vars: undefined, sig: name, wake: "future", step: "a", comp: undefined, text: "x" },
    { t: "signal", inst: 0, name, id: "fresh", payload: { wake: true }, aim: true },
  ]
}

function generateCase(maxOps: number, instanceCount: number): (rng: Rng) => Case {
  return (rng) => {
    const length = Math.max(6, Math.floor(maxOps / 2) + rng.int(Math.floor(maxOps / 2) + 1))
    // Start every instance up front most of the time; the generator's own start ops cover late starts.
    const ops: Op[] = rng.bool(0.9) ? Array.from({ length: instanceCount }, (_, inst): Op => ({ t: "start", inst, vars: randomObject(rng, 2) })) : []
    if (ops.length > 0 && rng.bool(0.8)) ops.push({ t: "claim", worker: rng.int(3), limit: rng.pick([1, 2, 10]), lease: 60_000 })
    if (ops.length > 0) {
      const light = instanceCount < INSTANCES
      // Slow transports get a single scripted prefix per case (their budget is a few dozen statements); fast ones may combine them.
      if (light) { const pick = rng.int(5); ops.push(...(pick === 0 ? sagaPrefix(rng, true) : pick === 1 ? earlyPrefix(rng) : pick === 2 ? wakePrefix(rng) : [])) } else {
        if (rng.bool(0.4)) ops.push(...sagaPrefix(rng, false))
        if (rng.bool(0.4)) ops.push(...earlyPrefix(rng))
        if (rng.bool(0.3)) ops.push(...wakePrefix(rng))
      }
    }
    while (ops.length < length) ops.push(generateOp(rng, instanceCount))
    return { ops, instances: instanceCount }
  }
}

function* shrinkCase(value: Case): Iterable<Case> {
  for (let size = Math.floor(value.ops.length / 2); size >= 1; size = Math.floor(size / 2)) {
    for (let start = 0; start + size <= value.ops.length; start += size) yield { ...value, ops: [...value.ops.slice(0, start), ...value.ops.slice(start + size)] }
    if (size === 1) break
  }
  for (const [index, op] of value.ops.entries()) {
    if (op.t === "commit" && (op.vars !== undefined || op.comp !== undefined)) yield { ...value, ops: value.ops.map((item, position) => (position === index ? { ...op, vars: undefined, comp: undefined } : item)) }
    if (op.t === "claim" && op.limit !== 1) yield { ...value, ops: value.ops.map((item, position) => (position === index ? { ...op, limit: 1 } : item)) }
  }
}

const describeCase = (value: Case): string => JSON.stringify(value)

// ---------------------------------------------------------------------------------------------------------------------
// Transitions from core's pure functions

const FORWARD_KINDS = ["next", "next", "next", "wait", "wait", "wait", "sleep", "sleep", "complete", "retry", "fail", "scheduleRetry", "stalled", "failStep", "release"] as const
const COMPENSATION_KINDS = ["retry", "fail", "scheduleRetry", "stalled", "failStep", "completeStep", "completeStep", "completeStep", "completeStep", "release"] as const

/** The transition a dispatcher could ask `base` (a claimed instance) to commit, or undefined when the drawn kind does not apply. */
function buildTransition(base: WorkflowInstance, op: Extract<Op, { t: "commit" }>): { kind: string; next: WorkflowInstance } | undefined {
  const compensating = base.status === "compensating"
  const kinds = compensating ? COMPENSATION_KINDS : FORWARD_KINDS
  const kind = kinds[op.kind % kinds.length]!
  const wakeAt = op.wake === "past" ? PAST : FUTURE
  const vars = op.vars === undefined ? {} : { variables: op.vars }
  const failureOf = (code: string) => createWorkflowFailure({ code, message: op.text, step: compensating ? base.compensationStack.at(-1) ?? base.currentStep : base.currentStep, phase: compensating ? "compensate" : "execute", attempt: base.stepAttempt, at: NOW0 })
  try {
    switch (kind) {
      case "next": return { kind, next: applyWorkflowStep(base, { kind: "next", step: op.step, ...(op.comp !== undefined ? { compensation: op.comp } : {}), ...vars } as WorkflowStepResult, NOW0) }
      case "wait": return { kind, next: applyWorkflowStep(base, { kind: "wait", signal: op.sig, ...vars }, NOW0) }
      case "sleep": return { kind, next: applyWorkflowStep(base, { kind: "sleep", wakeAt, ...vars }, NOW0) }
      case "complete": return { kind, next: applyWorkflowStep(base, { kind: "complete", ...vars }, NOW0) }
      case "retry": return { kind, next: applyWorkflowStep(base, { kind: "retry", error: op.text }, NOW0) }
      case "fail": return { kind, next: applyWorkflowStep(base, { kind: "fail", error: op.text }, NOW0) }
      case "scheduleRetry": return { kind, next: scheduleWorkflowRetry(base, wakeAt, NOW0) }
      case "stalled": return { kind, next: markWorkflowAttemptStalled(base, failureOf("TIMEOUT"), wakeAt, NOW0) }
      case "failStep": return { kind, next: compensating ? failCompensation(base, failureOf("STEP_FAILED"), NOW0) : failWorkflowStep(base, failureOf("STEP_FAILED"), NOW0) }
      case "completeStep": return { kind, next: completeCompensation(base, NOW0) }
      case "release": return { kind, next: releaseWorkflowClaim(base, NOW0) }
    }
  } catch { return undefined }
  return undefined
}

// ---------------------------------------------------------------------------------------------------------------------
// The runner

interface ClaimRecord { readonly inst: number; readonly instance: WorkflowInstance; readonly workerId: string; readonly realToken: string; readonly refToken: string }

let caseCounter = 0

class Runner {
  readonly clock = new ManualClock()
  readonly ref = new ReferenceStore(this.clock)
  readonly claims: ClaimRecord[] = []
  readonly ids: string[]
  readonly started = new Set<number>()
  readonly signalIds: Array<{ id: string; inst: number }> = []
  #signalCounter = 0
  #lastSignalId: string | undefined
  private opIndex = 0

  constructor(private readonly driver: WorkflowStoreDriver, private readonly instanceCount: number) {
    const tag = `wf${Date.now().toString(36)}${++caseCounter}`
    this.ids = Array.from({ length: this.instanceCount }, (_, index) => `${tag}-i${index}`)
    this.tag = tag
  }
  readonly tag: string

  private get store(): WorkflowStore { return this.driver.store }
  private label(op: Op): string { return `op #${this.opIndex} ${JSON.stringify(op)}` }
  private tick(): number { const now = Date.now(); this.clock.current = now; return now }

  /** Instances whose reference row satisfies `test`; an aimed operation is redirected to one of them (when any) so the generator reaches deep states. */
  private aimed(inst: number, aim: boolean, test: (row: WorkflowInstance) => boolean): number {
    if (!aim) return inst
    const pool = this.ids.map((id, index) => ({ row: this.ref.rows.get(id), index })).filter((entry) => entry.row !== undefined && test(entry.row)).map((entry) => entry.index)
    return pool.length === 0 ? inst : pool[inst % pool.length]!
  }
  private leased = (row: WorkflowInstance): boolean => row.leaseOwner !== null && row.leaseExpiresAt !== null && row.leaseExpiresAt.getTime() > this.clock.current

  private fenceFor(selector: Selector): { record: ClaimRecord; real: WorkflowFence; ref: WorkflowFence } | undefined {
    const sel = selector.mutate === "ok" && selector.back === 0 ? { ...selector, inst: this.aimed(selector.inst, selector.aim, this.leased) } : selector
    let mine = this.claims.filter((claim) => claim.inst === sel.inst)
    if (mine.length === 0) {
      // Nothing was ever claimed for the drawn instance: use one that was, so most fenced operations exercise a store.
      const claimed = [...new Set(this.claims.map((claim) => claim.inst))]
      if (claimed.length === 0) return undefined
      mine = this.claims.filter((claim) => claim.inst === claimed[sel.inst % claimed.length])
    }
    const record = mine[Math.max(0, mine.length - 1 - sel.back)]!
    const mutate = (fence: WorkflowFence): WorkflowFence => {
      switch (sel.mutate) {
        case "worker": return { ...fence, workerId: `${fence.workerId}-other` }
        case "token": return { ...fence, claimToken: `${fence.claimToken}-x` }
        case "revLow": return { ...fence, revision: fence.revision - 1 }
        case "revHigh": return { ...fence, revision: fence.revision + 1 }
        default: return fence
      }
    }
    const base = { instanceId: this.ids[record.inst]!, workerId: record.workerId, revision: record.instance.revision }
    return { record, real: mutate({ ...base, claimToken: record.realToken }), ref: mutate({ ...base, claimToken: record.refToken }) }
  }

  async run(op: Op): Promise<void> {
    const nowMs = this.tick()
    const label = this.label(op)
    const touched = new Set<number>()
    switch (op.t) {
      case "start": {
        if (this.started.has(op.inst)) { coverage("start:skipped"); break }
        this.started.add(op.inst)
        const input = { id: this.ids[op.inst]!, workflowType: "wf", workflowVersion: 1, executionScope: SCOPE, initialStep: "a", variables: op.vars }
        const [real, ref] = [await this.store.start(input), await this.ref.start(input)]
        expect(projectInstance(real, nowMs), label).toEqual(projectInstance(ref, nowMs))
        touched.add(op.inst)
        coverage("start")
        break
      }
      case "claim": {
        const args = { workerId: `w${op.worker}`, limit: op.limit, leaseDurationMs: op.lease }
        const due = await this.ref.dueIds()
        const got = await this.store.claimDue({ ...args, now: new Date(nowMs) })
        const gotIds = got.map((claim) => claim.instance.id)
        expect(new Set(gotIds).size, `${label}: duplicate-free claim`).toBe(gotIds.length)
        expect(gotIds.length, `${label}: claim size (due ${due.length})`).toBe(Math.min(op.limit, due.length))
        for (const id of gotIds) expect(due, `${label}: ${id} was due`).toContain(id)
        const reference = await this.ref.claimExactly(gotIds, args)
        for (const claim of got) {
          const peer = reference.find((candidate) => candidate.instance.id === claim.instance.id)
          expect(peer, `${label}: reference claimed ${claim.instance.id}`).toBeDefined()
          expect(claim.workerId, label).toBe(peer!.workerId)
          expect(claim.claimToken, `${label}: claim token is the row's token`).toBe(claim.instance.claimToken)
          expect(projectInstance(claim.instance, nowMs), label).toEqual(projectInstance(peer!.instance, nowMs))
          const inst = this.ids.indexOf(claim.instance.id)
          this.claims.push({ inst, instance: claim.instance, workerId: claim.workerId, realToken: claim.claimToken, refToken: peer!.claimToken })
          touched.add(inst)
          coverage(`claim:from:${peer!.instance.resumeSignalId ? "resumed" : "plain"}`)
        }
        coverage(`claim:size:${Math.min(gotIds.length, 3)}${due.length > gotIds.length ? ":limited" : ""}`)
        break
      }
      case "assert":
      case "renew": {
        const fence = this.fenceFor(op.sel)
        if (!fence) { coverage(`${op.t}:no-claim`); break }
        const inst = fence.record.inst
        touched.add(inst)
        const before = await this.store.get(this.ids[inst]!)
        const [real, ref] = op.t === "assert"
          ? [await this.store.assertLease(fence.real), await this.ref.assertLease(fence.ref)]
          : [await this.store.renewLease(fence.real, op.extend), await this.ref.renewLease(fence.ref, op.extend)]
        expect(real, label).toBe(ref)
        if (op.t === "renew" && real) {
          // Renewal only ever extends.
          const after = await this.store.get(this.ids[inst]!)
          expect(after!.leaseExpiresAt!.getTime(), `${label}: lease never shrinks`).toBeGreaterThanOrEqual(before!.leaseExpiresAt!.getTime())
        }
        coverage(`${op.t}:${op.sel.mutate}:${real}`)
        break
      }
      case "commit": {
        const fence = this.fenceFor(op.sel)
        if (!fence) { coverage("commit:no-claim"); break }
        touched.add(fence.record.inst)
        const built = buildTransition(fence.record.instance, op)
        if (!built) { coverage("commit:inapplicable"); break }
        const id = this.ids[fence.record.inst]!
        const pendingBefore = this.ref.pending(id).length
        const [real, ref] = [await this.store.commit(fence.real, built.next), await this.ref.commit(fence.ref, built.next)]
        expect(real, label).toBe(ref)
        coverage(`commit:${built.kind}:${op.sel.mutate === "ok" ? "fence-ok" : "fence-bad"}:${real}`)
        if (real && pendingBefore > this.ref.pending(id).length) coverage("commit:consumed-buffered")
        break
      }
      case "signal": {
        // Aimed signals go to a live instance (one that waits for a signal, else any that is not finished); half of them carry the awaited name.
        const waiting = (row: WorkflowInstance): boolean => row.status === "waiting" && row.wakeAt === null && row.waitingSignal !== null
        const inst = op.inst >= this.instanceCount ? op.inst : this.aimed(op.inst, op.aim, (row) => (op.inst % 3 === 1 ? this.leased(row) : op.inst % 3 === 2 ? row.status === "compensating" : waiting(row)))
        const target = this.ref.rows.get(this.ids[inst] ?? "")
        const name = op.aim && target && waiting(target) && op.inst % 2 === 0 ? target.waitingSignal! : op.name
        const instanceId = inst < this.instanceCount ? this.ids[inst]! : `${this.tag}-ghost`
        let id: string
        const existing = this.signalIds
        switch (op.id) {
          case "dupSame": id = existing.filter((entry) => entry.inst === inst).at(-1)?.id ?? this.freshSignalId(); break
          case "dupOther": id = existing.filter((entry) => entry.inst !== inst).at(-1)?.id ?? this.freshSignalId(); break
          case "dupLast": id = this.#lastSignalId ?? this.freshSignalId(); break
          default: id = this.freshSignalId()
        }
        if (!existing.some((entry) => entry.id === id)) existing.push({ id, inst: inst })
        this.#lastSignalId = id
        const signal = { id, instanceId, name: name, payload: op.payload }
        const statusBefore = this.ref.rows.get(instanceId)?.status ?? "unknown"
        const pendingBefore = this.ref.consumptions.length
        const [real, ref] = [await this.store.deliverSignal(signal), await this.ref.deliverSignal(signal)]
        expect(real, label).toEqual(ref)
        if (inst < this.instanceCount) touched.add(inst)
        if (this.driver.light && inst < this.instanceCount) {
          expect(projectSignal(await this.store.getSignalById!(instanceId, id)), `${label}: getSignalById`).toEqual(projectSignal(await this.ref.getSignalById(instanceId, id)))
          expect(projectSignal(await this.store.getSignal!(instanceId, name)), `${label}: getSignal`).toEqual(projectSignal(await this.ref.getSignal(instanceId, name)))
        }
        coverage(`signal:${statusBefore}:${ref.delivered ? "delivered" : ref.duplicate ? "duplicate" : "dropped"}${this.ref.consumptions.length > pendingBefore ? ":woke" : ""}`)
        break
      }
      case "cancel": {
        // Aimed cancels target an instance with something to compensate, or one that was just resumed by a signal (its resume receipt must be cleared).
        const live = (row: WorkflowInstance): boolean => !["compensating", "succeeded", "failed", "cancelled", "compensation_failed"].includes(row.status)
        const inst = this.aimed(op.inst, op.aim, (row) => live(row) && (op.inst % 2 === 0 ? row.compensationStack.length > 0 : row.resumeSignalId != null))
        const id = this.ids[inst]!
        const [real, ref] = [await this.store.cancel(id), await this.ref.cancel(id)]
        expect(real, label).toBe(ref)
        touched.add(inst)
        coverage(`cancel:${real}`)
        break
      }
      case "expire": {
        const inst = this.aimed(op.inst, op.aim, this.leased)
        const id = this.ids[inst]!
        await this.driver.setLeaseExpiry(id, EXPIRED_LEASE)
        const row = this.ref.rows.get(id)
        if (row && row.leaseOwner !== null) this.ref.rows.set(id, { ...row, leaseExpiresAt: EXPIRED_LEASE })
        touched.add(inst)
        coverage(`expire:${row?.leaseOwner !== null && row !== undefined}`)
        break
      }
      case "due": {
        const inst = this.aimed(op.inst, op.aim, (row) => row.wakeAt !== null)
        const id = this.ids[inst]!
        await this.driver.setWakeAt(id, DUE_AT)
        const row = this.ref.rows.get(id)
        if (row && row.wakeAt !== null) this.ref.rows.set(id, { ...row, wakeAt: DUE_AT })
        touched.add(inst)
        coverage(`due:${row?.wakeAt != null}`)
        break
      }
      case "get": {
        const id = op.inst === "ghost" ? `${this.tag}-ghost` : this.ids[op.inst]!
        expect(projectInstance(await this.store.get(id), nowMs), label).toEqual(projectInstance(await this.ref.get(id), nowMs))
        if (op.inst !== "ghost") touched.add(op.inst)
        break
      }
    }
    // Fast transports compare everything after every operation. Slow ones (about 28 ms per statement) compare the touched instances, and the
    // ledger only after operations that can change it, and everything only at the end (see `finish`).
    if (this.driver.light) await this.observe(label, touched, { receipts: op.t === "signal" || op.t === "commit", lookups: false })
    else await this.observe(label, "all", { receipts: true, lookups: touched })
    this.opIndex++
  }

  private freshSignalId(): string { return `${this.tag}-s${++this.#signalCounter}` }

  /** Compares instances, the ledger and signal lookups; checks the ledger invariants on the database rows. */
  async observe(label: string, which: "all" | ReadonlySet<number>, scope: { receipts: boolean; lookups: boolean | ReadonlySet<number> }): Promise<void> {
    const nowMs = this.tick()
    const instances = which === "all" ? this.ids.map((_, index) => index) : [...which]
    const rows: WorkflowInstance[] = []
    for (const inst of instances) {
      const id = this.ids[inst]!
      const row = await this.store.get(id)
      expect(projectInstance(row, nowMs), `${label}: ${id}`).toEqual(projectInstance(await this.ref.get(id), nowMs))
      if (row) rows.push(row)
    }
    if (!scope.receipts) return
    const mine = new Set(this.ids)
    const all = (await this.driver.receipts()).filter((receipt) => mine.has(receipt.instanceId))
    const expected = this.ref.receipts.map((receipt) => ({ id: receipt.id, instanceId: receipt.instanceId, name: receipt.name, consumed: this.ref.consumed.has(receipt.id), consumedRevision: this.ref.consumed.get(receipt.id)?.revision ?? null }))
    expect(all.map(({ id, instanceId, name, consumed, consumedRevision }) => ({ id, instanceId, name, consumed, consumedRevision })), `${label}: receipt ledger`).toEqual(expected)
    const seqs = all.map((receipt) => receipt.seq)
    expect(seqs, `${label}: seq is strictly increasing`).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size, `${label}: seq is unique`).toBe(seqs.length)
    const compared = new Set(instances.map((inst) => this.ids[inst]!))
    const receipts = all.filter((receipt) => compared.has(receipt.instanceId))
    expect(signalLedgerViolations({ receipts, consumed: new Set(receipts.filter((receipt) => receipt.consumed).map((receipt) => receipt.id)), rows }), `${label}: ledger invariants (database)`).toEqual([])
    expect(signalLedgerViolations(this.ref.ledger()), `${label}: ledger invariants (reference)`).toEqual([])
    if (scope.lookups) for (const inst of instances) if (scope.lookups === true || scope.lookups.has(inst)) await this.lookups(label, inst)
  }

  /** getSignal / getSignalById for one instance: its receipts, a receipt of another instance, an unknown id, and every name. */
  private async lookups(label: string, inst: number): Promise<void> {
    const id = this.ids[inst]!
    const probes = new Set<string>([`${this.tag}-missing`])
    for (const receipt of this.ref.receipts) if (receipt.instanceId === id) probes.add(receipt.id)
    const foreign = this.ref.receipts.find((receipt) => receipt.instanceId !== id)
    if (foreign) probes.add(foreign.id)
    for (const probe of probes) expect(projectSignal(await this.store.getSignalById!(id, probe)), `${label}: getSignalById ${id} ${probe}`).toEqual(projectSignal(await this.ref.getSignalById(id, probe)))
    for (const name of SIGNALS) expect(projectSignal(await this.store.getSignal!(id, name)), `${label}: getSignal ${id} ${name}`).toEqual(projectSignal(await this.ref.getSignal(id, name)))
    // A receipt is stamped with a plausible delivery time (the database clock, within a day of the test clock).
    const latest = await this.store.getSignal!(id, "go")
    if (latest) expect(Math.abs(latest.deliveredAt.getTime() - Date.now()), `${label}: deliveredAt is recent`).toBeLessThan(24 * 3_600_000)
  }

  async finish(): Promise<void> { await this.observe("final", "all", { receipts: true, lookups: true }) }
}

export async function runCase(driver: WorkflowStoreDriver, input: Case): Promise<void> {
  await driver.reset()
  const runner = new Runner(driver, input.instances)
  for (const op of input.ops) await runner.run(op)
  await runner.finish()
}

// ---------------------------------------------------------------------------------------------------------------------
// Registration

export function defineStoreContractDifferential(driver: WorkflowStoreDriver): void {
  it(`${driver.label}: real store matches the in-memory reference under random operation sequences`, async () => {
    await forAllAsync(`workflow store differential lifecycle (${driver.label})`, generateCase(driver.maxOps ?? 36, driver.light ? 2 : INSTANCES), (value) => runCase(driver, value), {
      runs: driver.lifecycleRuns ?? 60, shrink: shrinkCase, describe: describeCase, maxShrinkSteps: 120,
    })
  }, PROPERTY_TIMEOUT_MS * Math.max(1, scaledRuns(100) / 100))

  it(`${driver.label}: generator coverage of the lifecycle differential`, () => {
    if (process.env.DIFFERENTIAL_RUN !== undefined && process.env.DIFFERENTIAL_RUN !== "") return
    for (const key of [
      "claim:size:1", "commit:next:fence-ok:true", "commit:wait:fence-ok:true", "commit:consumed-buffered", "commit:fail:fence-ok:true",
      "commit:completeStep:fence-ok:true", "commit:wait:fence-bad:false", "signal:waiting:delivered:woke", "signal:pending:delivered", "signal:unknown:dropped", "cancel:true",
    ]) expect(coverageCount(key), `generator reaches ${key}`).toBeGreaterThan(0)
    // The remaining transition kinds and drop reasons are required of the fast transports only (slow ones run few, short sequences).
    if (!driver.light) {
      for (const key of ["commit:sleep:fence-ok:true", "commit:complete:fence-ok:true", "commit:stalled:fence-ok:true", "commit:scheduleRetry:fence-ok:true", "commit:release:fence-ok:true", "commit:retry:fence-ok:true", "commit:failStep:fence-ok:true", "signal:compensating:delivered", "assert:token:false", "cancel:false", "due:true", "renew:ok:true", "assert:ok:true", "expire:true"]) {
        expect(coverageCount(key), `generator reaches ${key}`).toBeGreaterThan(0)
      }
    }
    // A signal for a finished instance is dropped (whatever way it finished); a duplicate id is recognised.
    expect(coverageCount("signal:succeeded:dropped") + coverageCount("signal:failed:dropped") + coverageCount("signal:cancelled:dropped"), "signals to finished instances are dropped").toBeGreaterThan(0)
  })
}

