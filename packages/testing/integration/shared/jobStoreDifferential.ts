import { appendFileSync } from "node:fs"
import { expect, it } from "vitest"
import type { JobExecutionScope, JobStore, StoredJob, JobTransitionResult } from "@xonava/core/execution"
import { forAllAsync, scaledRuns } from "../../../core/src/__tests__/differential/harness.js"
import { TIMING_SCALE } from "../../../core/src/__tests__/timing.js"
import {
  BOGUS_TOKEN, HOUR, RefStore, T0, canonicalJson, describeOps, executionScopeOf, generateOps, requesterOf, shrinkOps,
  type EnqueueOutcome, type EnqueueSpec, type Op, type RefConfig, type RefJob, type TransitionOutcome, type ViewReq,
} from "./jobStoreDifferentialModel.js"

export { T0, HOUR }

/** Database-normalised view of a jobs row (raw SQL, independent of the adapter's own decoding). */
export interface RawJobRow {
  id: string
  status: string
  attempts: number
  maxAttempts: number
  priority: number
  runAt: number
  nextAttemptAt: number | null
  leaseOwner: string | null
  claimToken: string | null
  leaseExpiresAt: number | null
  lastError: string | null
  resultPayload: unknown
  startedAt: number | null
  completedAt: number | null
  partitionKey: string | null
  correlationId: string | null
  idempotencyKey: string | null
  tenantId: string | null
  /** The raw scope_key column: the platform/system key, NULL for the framework defaults and tenant rows. */
  scopeKey: string | null
  scope: string
  jobType: string
  jobVersion: number
  payload: unknown
  metadata: unknown
}

export interface RawExecutionRow { id: string; jobId: string; attempt: number; workerId: string; status: string }

export interface JobStoreDifferentialDriver {
  /** Property-name suffix, e.g. "postgres/best_effort". */
  label: string
  store: JobStore
  /** Deletes every job and execution row. */
  reset(): Promise<void>
  /** Rewrites the job's lease so it expired one hour ago on the DATABASE clock. */
  expireLease(jobId: string): Promise<void>
  dump(): Promise<RawJobRow[]>
  /** Rewrites the job row as an older release wrote it: scope_key NULL (no platform/system key). */
  clearScopeKey(jobId: string): Promise<void>
  executions(ids: string[]): Promise<RawExecutionRow[]>
  /** Every execution-history row of the given jobs. */
  executionsFor(jobIds: string[]): Promise<RawExecutionRow[]>
  /** lastError text this adapter writes when a claim sweep dead-letters an expired final attempt. */
  expiredFinalAttemptError: string
  /**
   * D1 reads a claimed row back in a separate statement after the claim UPDATE. A concurrent cancel can land in between,
   * leaving the claim's return value without a job whose attempt it consumed (the job ends cancelled either way).
   */
  claimReadbackMayLoseToCancel?: boolean
  /** Partition heads prefer a lease-lapsed running job (MySQL's unique active-partition index). */
  zombieFirst?: boolean
  /** "required": a terminal/retry transition leaves its transition token in claim_token. */
  historyRequired: boolean
  /** Base run count of the sequential lifecycle property at scale 1. */
  lifecycleRuns?: number
  /** Base run counts of the concurrency properties at scale 1. */
  concurrencyRuns?: number
  dispatcherRuns?: number
  /**
   * Slow transports (Miniflare D1 costs ~20 ms per statement) use short sequences and compare the full table only
   * once at the end of a sequence instead of after every step.
   */
  light?: boolean
  /**
   * Lease length (ms) of the real-time lease test. Only the lapse is waited for (polled, never slept for a fixed time),
   * so this is a lower bound that needs no margin for scheduling delays; slow transports use a longer one.
   */
  leaseTickMs?: number
}

/** Coverage counters, printed when JOB_STORE_DIFFERENTIAL_STATS is set. */
const COVERAGE = new Map<string, number>()
export function coverage(key: string): void { COVERAGE.set(key, (COVERAGE.get(key) ?? 0) + 1) }
export function printCoverage(label: string): void {
  const file = process.env.JOB_STORE_DIFFERENTIAL_STATS
  if (file) appendFileSync(file, `${label} coverage ${JSON.stringify(Object.fromEntries([...COVERAGE].sort()))}\n`)
}

/** Generous per-test budget: a failing property shrinks. It grows with DIFFERENTIAL_SCALE like the case counts do, and with XONAVA_TIMING_SCALE. */
export const PROPERTY_TIMEOUT_MS = Math.ceil(300_000 * Math.max(1, scaledRuns(100) / 100) * TIMING_SCALE)

function sleepMs(ms: number): Promise<void> { return new Promise((resolve) => { setTimeout(resolve, ms) }) }

/**
 * Polls until the job's lease expiry is `marginMs` in the past on this machine's clock (never a fixed sleep), so it
 * cannot return early however slow the machine is. A generous deadline only guards against a stuck run.
 */
async function waitForLeaseToLapse(driver: JobStoreDifferentialDriver, jobId: string, marginMs: number): Promise<void> {
  const deadline = Date.now() + 60_000
  for (;;) {
    const lease = (await driver.store.getById({ id: jobId, requester: requesterOf("sys") }))?.leaseExpiresAt
    if (!lease || Date.now() > lease.getTime() + marginMs) return
    if (Date.now() > deadline) throw new Error(`the lease of ${jobId} did not lapse within 60 s`)
    await sleepMs(25)
  }
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === "string") { try { return JSON.parse(value) } catch { return value } }
  return value
}

function sameJson(left: unknown, right: unknown): boolean { return canonicalJson(parseJson(left)) === canonicalJson(parseJson(right)) }

function errorName(error: unknown): string { return error instanceof Error ? error.name : String(error) }

function viewKey(view: ViewReq): ViewReq { return view }

/** Normalised observable state shared by the StoredJob and raw-row comparisons. */
interface ObservedState {
  status: string
  attempts: number
  priority: number
  runAt: number
  nextAttemptAt: number | null
  leaseOwner: string | null
  claimToken: string | null
  leaseExpiresAt: number | null
  lastError: string | null
  resultPayload: unknown
  startedAt: number | null
  completed: boolean
  partitionKey: string | null
  correlationId: string | null
  idempotencyKey: string | null
  tenantId: string | null
  /** The raw scope_key column: the platform/system key, NULL for the framework defaults and tenant rows. */
  scopeKey: string | null
  scope: string
  jobType: string
  jobVersion: number
  payload: unknown
  metadata: unknown
}

/** The persisted form of a stored job's platform/system key (NULL for the defaults and tenant scopes), derived from its decoded scope. */
function scopeKeyOf(scope: StoredJob["executionScope"]): string | null {
  if (scope.kind === "platform") return scope.platformKey === "default" ? null : scope.platformKey
  if (scope.kind === "system") return scope.systemKey === "framework" ? null : scope.systemKey
  return null
}

function fromStored(job: StoredJob): ObservedState & { maxAttempts: number | undefined } {
  return {
    status: job.status, attempts: job.currentAttempt, priority: job.priority, runAt: job.runAt.getTime(),
    nextAttemptAt: job.nextAttemptAt?.getTime() ?? null, leaseOwner: job.leaseOwner, claimToken: job.claimToken,
    leaseExpiresAt: job.leaseExpiresAt?.getTime() ?? null, lastError: job.lastError, resultPayload: job.resultPayload,
    startedAt: job.startedAt?.getTime() ?? null, completed: job.completedAt !== null, partitionKey: job.partitionKey,
    correlationId: job.correlationId, idempotencyKey: job.idempotencyKey, tenantId: job.tenantId, scopeKey: scopeKeyOf(job.executionScope), scope: job.scope,
    jobType: job.jobType, jobVersion: job.jobVersion, payload: job.payload, metadata: job.metadata, maxAttempts: job.maxAttempts,
  }
}

const SENTINEL_MAX = 2_147_483_647

function fromRaw(row: RawJobRow): ObservedState & { maxAttempts: number | undefined } {
  return {
    status: row.status, attempts: row.attempts, priority: row.priority, runAt: row.runAt, nextAttemptAt: row.nextAttemptAt,
    leaseOwner: row.leaseOwner, claimToken: row.claimToken, leaseExpiresAt: row.leaseExpiresAt, lastError: row.lastError,
    resultPayload: row.resultPayload, startedAt: row.startedAt, completed: row.completedAt !== null, partitionKey: row.partitionKey,
    correlationId: row.correlationId, idempotencyKey: row.idempotencyKey, tenantId: row.tenantId, scopeKey: row.scopeKey, scope: row.scope,
    jobType: row.jobType, jobVersion: row.jobVersion, payload: row.payload, metadata: row.metadata,
    maxAttempts: row.maxAttempts === SENTINEL_MAX ? undefined : row.maxAttempts,
  }
}

export class LifecycleRunner {
  model: RefStore
  readonly realIdBySlot: string[] = []
  readonly slotByRealId = new Map<string, number>()
  readonly realTokenBySym = new Map<string, string>()
  readonly symByRealToken = new Map<string, string>()
  readonly transitions: { token: string; jobId: string; status: string; attempt: number }[] = []
  private lastEnqueueAt = 0
  /** Last observed lease expiry per slot: a renewal may never move it backwards. */
  private readonly leaseSeen = new Map<number, number>()
  private now = Date.now()
  notes: string[] = []

  constructor(readonly driver: JobStoreDifferentialDriver) {
    this.model = new RefStore({ expiredFinalAttemptError: driver.expiredFinalAttemptError, zombieFirst: driver.zombieFirst === true } satisfies RefConfig)
    this.model.onEvent = coverage
  }

  realId(slot: number | undefined): string { return slot === undefined ? "no-such-job-id" : this.realIdBySlot[slot]! }
  realToken(sym: string): string { return sym === BOGUS_TOKEN ? BOGUS_TOKEN : this.realTokenBySym.get(sym) ?? `unknown-${sym}` }

  /** Differences between the reference job and an observed state. */
  diff(ref: RefJob, observed: ObservedState & { maxAttempts: number | undefined }, source: string): string[] {
    const out: string[] = []
    const check = (field: string, expected: unknown, actual: unknown): void => {
      if (expected !== actual) out.push(`${source}.${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
    check("status", ref.status, observed.status)
    check("attempts", ref.attempts, observed.attempts)
    check("maxAttempts", ref.spec.maxAttempts, observed.maxAttempts)
    check("priority", ref.spec.priority, observed.priority)
    check("runAt", ref.spec.runAt, observed.runAt)
    check("nextAttemptAt", ref.nextAttemptAt, observed.nextAttemptAt)
    check("leaseOwner", ref.leaseOwner, observed.leaseOwner)
    check("lastError", ref.lastError, observed.lastError)
    check("startedAt", ref.startedAt, observed.startedAt)
    check("completed", ref.completed, observed.completed)
    check("partitionKey", ref.spec.partition ?? null, observed.partitionKey)
    check("correlationId", ref.spec.corr ?? null, observed.correlationId)
    check("idempotencyKey", ref.spec.idem ?? null, observed.idempotencyKey)
    check("tenantId", ref.tenantId, observed.tenantId)
    check("scope", ref.scope, observed.scope)
    check("scopeKey", ref.scopeKey, observed.scopeKey)
    check("jobType", ref.spec.jobType, observed.jobType)
    check("jobVersion", ref.spec.version, observed.jobVersion)
    if (!sameJson(observed.payload, ref.spec.payload)) out.push(`${source}.payload: expected ${canonicalJson(ref.spec.payload)}, got ${JSON.stringify(observed.payload)}`)
    if (!sameJson(observed.metadata, ref.spec.metadata ?? null)) out.push(`${source}.metadata: expected ${canonicalJson(ref.spec.metadata ?? null)}, got ${JSON.stringify(observed.metadata)}`)
    if (!sameJson(observed.resultPayload, ref.result)) out.push(`${source}.resultPayload: expected ${canonicalJson(ref.result)}, got ${JSON.stringify(observed.resultPayload)}`)
    if (ref.status === "running") {
      check("claimToken", ref.token === null ? null : this.realToken(ref.token), observed.claimToken)
      if (observed.leaseExpiresAt === null) out.push(`${source}.leaseExpiresAt: running job has no lease expiry`)
      else check("leaseLive", ref.leaseLive, observed.leaseExpiresAt > this.now)
    } else {
      check("leaseExpiresAt", null, observed.leaseExpiresAt)
      // required history leaves the transition token in claim_token; it must never be a claim token ever issued.
      if (this.driver.historyRequired) {
        if (observed.claimToken !== null && this.symByRealToken.has(observed.claimToken)) out.push(`${source}.claimToken: non-running job still carries claim token ${observed.claimToken}`)
      } else check("claimToken", null, observed.claimToken)
    }
    return out
  }

  fail(index: number, op: Op, problems: string[]): never {
    throw new Error(`step ${index} ${JSON.stringify(op, (_k, v: unknown) => (typeof v === "number" && Number.isNaN(v) ? "NaN" : v))}\n  ${problems.join("\n  ")}`)
  }

  private compareStored(index: number, op: Op, slot: number, real: StoredJob | null, source: string): void {
    if (real === null) this.fail(index, op, [`${source}: expected job slot ${slot}, got null`])
    const mapped = this.slotByRealId.get(real.id)
    if (mapped !== slot) this.fail(index, op, [`${source}: expected slot ${slot}, got id of slot ${mapped}`])
    const problems = this.diff(this.model.jobs[slot]!, fromStored(real), source)
    const execScope = JSON.stringify(real.executionScope)
    const wantScope = JSON.stringify(executionScopeOf(this.model.jobs[slot]!.spec.scope))
    if (execScope !== wantScope) problems.push(`${source}.executionScope: expected ${wantScope}, got ${execScope}`)
    if (real.attemptsCompleted !== Math.max(0, real.currentAttempt - 1)) problems.push(`${source}.attemptsCompleted inconsistent with currentAttempt`)
    if (problems.length > 0) this.fail(index, op, problems)
  }

  /** Differences between a reference state and the current table contents. */
  async dumpProblems(model: RefStore): Promise<string[]> {
    this.now = Date.now()
    const rows = await this.driver.dump()
    const byId = new Map(rows.map((row) => [row.id, row]))
    const problems: string[] = []
    if (rows.length !== model.jobs.length) problems.push(`row count: expected ${model.jobs.length}, got ${rows.length}`)
    for (const ref of model.jobs) {
      const row = byId.get(this.realIdBySlot[ref.slot]!)
      if (!row) { problems.push(`slot ${ref.slot}: row missing`); continue }
      problems.push(...this.diff(ref, fromRaw(row), `row[${ref.slot}]`))
    }
    return problems
  }

  private async compareDump(index: number, op: Op): Promise<void> {
    this.now = Date.now()
    const rows = await this.driver.dump()
    const byId = new Map(rows.map((row) => [row.id, row]))
    const problems: string[] = []
    if (rows.length !== this.model.jobs.length) problems.push(`row count: expected ${this.model.jobs.length}, got ${rows.length}`)
    for (const ref of this.model.jobs) {
      const row = byId.get(this.realIdBySlot[ref.slot]!)
      if (!row) { problems.push(`slot ${ref.slot}: row missing`); continue }
      problems.push(...this.diff(ref, fromRaw(row), `row[${ref.slot}]`))
    }
    if (problems.length > 0) this.fail(index, op, problems)
  }

  private compareTransition(index: number, op: Op, expected: TransitionOutcome, actual: JobTransitionResult, expectToken: boolean): void {
    const problems: string[] = []
    coverage(`${op.k}:${expected.applied ? "applied" : (expected.reason ?? "rejected")}`)
    if (expected.applied !== actual.applied) problems.push(`applied: expected ${expected.applied}, got ${actual.applied}`)
    else if (!expected.applied && expected.reason !== actual.reason) problems.push(`reason: expected ${expected.reason}, got ${actual.reason}`)
    if (actual.historyError !== undefined) problems.push(`historyError: ${actual.historyError}`)
    if (actual.applied && expectToken && (typeof actual.transitionToken !== "string" || actual.transitionToken.length === 0)) problems.push("applied transition carries no transitionToken")
    if (problems.length > 0) this.fail(index, op, problems)
  }

  private async spinForFreshMillisecond(): Promise<void> {
    while (Date.now() < this.lastEnqueueAt + 2) await sleepMs(1)
    this.lastEnqueueAt = Date.now()
  }

  async step(index: number, op: Op): Promise<void> {
    const { model, driver } = this
    const { store } = driver
    this.now = Date.now()
    const touched: number[] = []
    let renewedSlot: number | undefined
    switch (op.k) {
      case "enqueue": {
        const spec = op.spec
        const expected: EnqueueOutcome = model.enqueue(spec)
        await this.spinForFreshMillisecond()
        let real: StoredJob | undefined
        let thrown: unknown
        try {
          real = await store.enqueue({
            requester: requesterOf(spec.req),
            job: {
              executionScope: executionScopeOf(spec.scope), jobType: spec.jobType, jobVersion: spec.version, payload: spec.payload,
              runAt: new Date(spec.runAt), priority: spec.priority,
              ...(spec.maxAttempts !== undefined ? { maxAttempts: spec.maxAttempts } : {}),
              ...(spec.idem !== undefined ? { idempotencyKey: spec.idem } : {}),
              ...(spec.corr !== undefined ? { correlationId: spec.corr } : {}),
              ...(spec.partition !== undefined ? { partitionKey: spec.partition } : {}),
              ...(spec.metadata !== undefined ? { metadata: spec.metadata } : {}),
            },
          })
        } catch (error) { thrown = error }
        if (expected.kind === "err") {
          if (real) this.fail(index, op, [`enqueue: expected ${expected.name}, got job ${real.id}`])
          coverage(`enqueue:${expected.name}`)
          if (errorName(thrown) !== expected.name) this.fail(index, op, [`enqueue: expected ${expected.name}, got ${errorName(thrown)}: ${String((thrown as Error)?.message)}`])
          break
        }
        if (!real) this.fail(index, op, [`enqueue: expected a job, threw ${errorName(thrown)}: ${String((thrown as Error)?.message)}`])
        coverage(`enqueue:${expected.created ? "created" : "replayed"}`)
        if (expected.created) {
          if (this.slotByRealId.has(real.id)) this.fail(index, op, ["enqueue: returned an id that already belongs to another job"])
          this.realIdBySlot[expected.slot] = real.id
          this.slotByRealId.set(real.id, expected.slot)
        }
        this.compareStored(index, op, expected.slot, real, "enqueue")
        touched.push(expected.slot)
        break
      }
      case "claim": {
        const worker = `w${op.w + 1}`
        const expectedSlots = model.claim(op.view, worker, op.limit, model.vnow)
        const before = Date.now()
        const jobs = await store.claimDue({ limit: op.limit, workerId: worker, leaseDurationMs: HOUR, requester: requesterOf(op.view), now: new Date(model.vnow) })
        const after = Date.now()
        const got = jobs.map((job) => this.slotByRealId.get(job.id) ?? -1)
        coverage(`claim:${Math.min(got.length, 3)}`)
        const problems: string[] = []
        if ([...got].sort((a, b) => a - b).join(",") !== [...expectedSlots].sort((a, b) => a - b).join(",")) {
          problems.push(`claimed slots: expected [${expectedSlots.join(",")}], got [${got.join(",")}]`)
        } else if (got.join(",") !== expectedSlots.join(",")) {
          this.notes.push(`claimDue returned [${got.join(",")}] but priority order is [${expectedSlots.join(",")}]`)
        }
        for (const job of jobs) {
          const slot = this.slotByRealId.get(job.id)
          if (slot === undefined) continue
          const ref = model.jobs[slot]!
          if (typeof job.claimToken !== "string" || job.claimToken.length === 0) { problems.push(`slot ${slot}: claimed job has no claim token`); continue }
          if (this.symByRealToken.has(job.claimToken)) problems.push(`slot ${slot}: claim token ${job.claimToken} was issued before`)
          this.realTokenBySym.set(ref.token!, job.claimToken)
          this.symByRealToken.set(job.claimToken, ref.token!)
          const expiry = job.leaseExpiresAt?.getTime()
          if (expiry === undefined || expiry < before + HOUR - 5_000 || expiry > after + HOUR + 5_000) problems.push(`slot ${slot}: leaseExpiresAt ${String(expiry)} is not now()+lease`)
          else this.leaseSeen.set(slot, expiry)
          touched.push(slot)
        }
        if (problems.length > 0) this.fail(index, op, problems)
        for (const job of jobs) this.compareStored(index, op, this.slotByRealId.get(job.id)!, job, "claim")
        break
      }
      case "renew": {
        const { slot, worker, token } = model.resolve(op.fence)
        const expected = model.renew(slot, worker, token, op.extendMs)
        const actual = await store.renewLease({ jobId: this.realId(slot), workerId: worker, claimToken: this.realToken(token), extendByMs: op.extendMs })
        coverage(`renew:${expected}`)
        if (expected !== actual) this.fail(index, op, [`renewLease: expected ${expected}, got ${actual}`])
        if (slot !== undefined) { touched.push(slot); if (actual) renewedSlot = slot }
        break
      }
      case "succeed": {
        const { slot, worker, token, attempt } = model.resolve(op.fence)
        const expected = model.succeed(slot, worker, token, attempt, op.result)
        const actual = await store.markSucceeded({ jobId: this.realId(slot), workerId: worker, claimToken: this.realToken(token), attempt, ...(op.result ? { result: op.result } : {}) })
        this.compareTransition(index, op, expected, actual, true)
        if (actual.applied && actual.transitionToken) this.transitions.push({ token: actual.transitionToken, jobId: this.realId(slot), status: "succeeded", attempt })
        if (slot !== undefined) touched.push(slot)
        break
      }
      case "retry": {
        const { slot, worker, token, attempt } = model.resolve(op.fence)
        const next = model.vnow + op.delta
        const expected = model.retry(slot, worker, token, attempt, next, op.error)
        const actual = await store.markRetrying({ jobId: this.realId(slot), workerId: worker, claimToken: this.realToken(token), attempt, nextAttemptAt: new Date(next), error: op.error })
        this.compareTransition(index, op, expected, actual, true)
        if (actual.applied && actual.transitionToken) this.transitions.push({ token: actual.transitionToken, jobId: this.realId(slot), status: "retrying", attempt })
        if (slot !== undefined) touched.push(slot)
        break
      }
      case "fail": {
        const { slot, worker, token, attempt } = model.resolve(op.fence)
        const expected = model.fail(slot, worker, token, attempt, op.status, op.error)
        const actual = await store.markFailed({ jobId: this.realId(slot), workerId: worker, claimToken: this.realToken(token), attempt, error: op.error, status: op.status })
        this.compareTransition(index, op, expected, actual, true)
        if (actual.applied && actual.transitionToken) this.transitions.push({ token: actual.transitionToken, jobId: this.realId(slot), status: op.status, attempt })
        if (slot !== undefined) touched.push(slot)
        break
      }
      case "release": {
        const { slot, worker, token } = model.resolve(op.fence)
        const next = model.vnow + op.delta
        const expected = model.release(slot, worker, token, next, op.reason)
        const actual = await store.release!({ jobId: this.realId(slot), workerId: worker, claimToken: this.realToken(token), nextAttemptAt: new Date(next), reason: op.reason })
        this.compareTransition(index, op, expected, actual, false)
        if (slot !== undefined) touched.push(slot)
        break
      }
      case "cancel": {
        const slot = model.slotOf(op.job)
        const attemptsBefore = slot === undefined ? 0 : model.jobs[slot]!.attempts
        const statusBefore = slot === undefined ? "none" : model.jobs[slot]!.status
        const expected = model.cancel(slot, op.view, op.reason)
        coverage(`cancel-from:${statusBefore}:${expected.applied}`)
        const actual = await store.cancel({ jobId: this.realId(slot), requester: requesterOf(op.view), ...(op.reason !== undefined ? { reason: op.reason } : {}) })
        this.compareTransition(index, op, expected, actual, true)
        if (actual.applied && actual.transitionToken && slot !== undefined) this.transitions.push({ token: actual.transitionToken, jobId: this.realId(slot), status: "cancelled", attempt: attemptsBefore })
        if (slot !== undefined) touched.push(slot)
        break
      }
      case "expire": {
        const slot = model.slotOf(op.job)
        if (slot !== undefined && model.jobs[slot]!.status === "running") {
          model.expire(slot)
          await driver.expireLease(this.realId(slot))
          touched.push(slot)
        }
        break
      }
      case "advance": model.vnow += op.ms; break
      case "getById": {
        const slot = model.slotOf(op.job)
        const expected = model.byId(slot, op.view)
        const real = await store.getById({ id: this.realId(slot), requester: requesterOf(viewKey(op.view)) })
        if (expected === null) { if (real !== null) this.fail(index, op, [`getById: expected null, got ${real.id}`]) } else this.compareStored(index, op, expected.slot, real, "getById")
        break
      }
      case "getByIdem": {
        const expected = model.byIdempotencyKey(op.key, op.view)
        const real = await store.getByIdempotencyKey({ key: op.key, requester: requesterOf(op.view) })
        if (expected === null) { if (real !== null) this.fail(index, op, [`getByIdempotencyKey: expected null, got ${real.id}`]) } else this.compareStored(index, op, expected.slot, real, "getByIdempotencyKey")
        break
      }
      case "getByCorr": {
        const expected = model.byCorrelation(op.corr, op.view)
        const real = await store.getByCorrelationId({ correlationId: op.corr, requester: requesterOf(op.view) })
        const got = real.map((job) => this.slotByRealId.get(job.id) ?? -1)
        if (got.join(",") !== expected.map((job) => job.slot).join(",")) this.fail(index, op, [`getByCorrelationId: expected [${expected.map((job) => job.slot).join(",")}], got [${got.join(",")}]`])
        real.forEach((job, position) => { this.compareStored(index, op, expected[position]!.slot, job, "getByCorrelationId") })
        break
      }
      case "prior": {
        const expected = model.latestPrior(op.schedule, op.before, op.view)
        const real = await store.getLatestPriorScheduleExecution({ scheduleId: op.schedule, beforeOccurrence: new Date(op.before), requester: requesterOf(op.view) })
        if (expected === null) { if (real !== null) this.fail(index, op, [`getLatestPriorScheduleExecution: expected null, got ${real.id}`]) } else this.compareStored(index, op, expected.slot, real, "getLatestPriorScheduleExecution")
        break
      }
      case "pending": {
        const expected = model.pending(op.view, op.jobType, op.limit)
        const real = await store.findPending({ requester: requesterOf(op.view), ...(op.jobType !== undefined ? { jobType: op.jobType } : {}), ...(op.limit !== undefined ? { limit: op.limit } : {}) })
        const got = real.map((job) => this.slotByRealId.get(job.id) ?? -1)
        if (got.join(",") !== expected.map((job) => job.slot).join(",")) this.fail(index, op, [`findPending: expected [${expected.map((job) => job.slot).join(",")}], got [${got.join(",")}]`])
        break
      }
    }
    if (this.driver.light) return
    for (const slot of new Set(touched)) {
      const real = await store.getById({ id: this.realId(slot), requester: requesterOf(model.jobs[slot]!.scope === "tenant" ? (model.jobs[slot]!.tenantId === "t1" ? "t1" : "t2") : model.jobs[slot]!.scope === "platform" ? "plat" : "sys") })
      this.compareStored(index, op, slot, real, "getById(after)")
      const expiry = real?.leaseExpiresAt?.getTime()
      if (expiry !== undefined) {
        const seen = this.leaseSeen.get(slot)
        if (slot === renewedSlot && seen !== undefined && expiry < seen) this.fail(index, op, [`renewLease moved the lease expiry backwards by ${seen - expiry}ms`])
        this.leaseSeen.set(slot, expiry)
      }
    }
    if (op.k !== "advance" && op.k !== "getById" && op.k !== "getByIdem" && op.k !== "getByCorr" && op.k !== "prior" && op.k !== "pending") await this.compareDump(index, op)
  }

  async finish(lastIndex: number, lastOp: Op | undefined): Promise<void> {
    if (this.driver.light && lastOp) await this.compareDump(lastIndex, lastOp)
    if (this.transitions.length === 0) return
    const rows = await this.driver.executions(this.transitions.map((entry) => entry.token))
    const byId = new Map(rows.map((row) => [row.id, row]))
    for (const entry of this.transitions) {
      const row = byId.get(entry.token)
      if (!row) throw new Error(`execution history row ${entry.token} for ${entry.jobId} (${entry.status}) is missing`)
      if (row.jobId !== entry.jobId || row.status !== entry.status || row.attempt !== entry.attempt) {
        throw new Error(`execution history row ${entry.token}: expected job ${entry.jobId} ${entry.status}@${entry.attempt}, got ${row.jobId} ${row.status}@${row.attempt}`)
      }
    }
  }
}

export async function runLifecycleSequence(driver: JobStoreDifferentialDriver, ops: Op[]): Promise<void> {
  await driver.reset()
  const runner = new LifecycleRunner(driver)
  for (let index = 0; index < ops.length; index++) await runner.step(index, ops[index]!)
  await runner.finish(ops.length - 1, ops[ops.length - 1])
}

/** Registers the sequential store-contract differential for a driver. */
export function defineLifecycleDifferential(driver: JobStoreDifferentialDriver): void {
  it(`lifecycle sequences match the reference store (${driver.label})`, async () => {
    await forAllAsync(`job store lifecycle differential (${driver.label})`, (rng) => generateOps(rng, driver.light ? { min: 9, max: 15, dense: true } : undefined), (ops) => runLifecycleSequence(driver, ops), {
      runs: driver.lifecycleRuns ?? 60, shrink: shrinkOps, describe: describeOps, maxShrinkSteps: 150,
    })
  }, PROPERTY_TIMEOUT_MS)
}


const SYSTEM = requesterOf("sys")

async function enqueueClaimed(driver: JobStoreDifferentialDriver, worker: string, overrides: { maxAttempts?: number; partitionKey?: string } = {}): Promise<StoredJob> {
  await driver.store.enqueue({
    requester: SYSTEM,
    job: { executionScope: executionScopeOf("system"), jobType: "regression", jobVersion: 1, payload: {}, runAt: new Date(T0), ...overrides },
  })
  const [claimed] = await driver.store.claimDue({ limit: 1, workerId: worker, leaseDurationMs: HOUR, requester: SYSTEM, now: new Date(T0 + 1) })
  if (!claimed) throw new Error("expected the regression job to be claimable")
  return claimed
}

/**
 * Deterministic regressions for defects the lifecycle differential found. Each one fails against the store without the fix.
 */
export function defineLifecycleRegressions(driver: JobStoreDifferentialDriver): void {
  it(`a failed job is terminal: cancel is rejected and does not overwrite it (${driver.label})`, async () => {
    await driver.reset()
    const claimed = await enqueueClaimed(driver, "w1")
    expect(await driver.store.markFailed({ jobId: claimed.id, workerId: "w1", claimToken: claimed.claimToken!, attempt: 1, error: "permanent", status: "failed" })).toMatchObject({ applied: true })
    expect(await driver.store.cancel({ jobId: claimed.id, requester: SYSTEM, reason: "operator" })).toEqual({ applied: false, reason: "INVALID_STATE" })
    expect(await driver.store.getById({ id: claimed.id, requester: SYSTEM })).toMatchObject({ status: "failed", lastError: "permanent" })
  })

  it(`a partition whose crashed (lease-expired) job is out-ranked by a queued job still makes progress (${driver.label})`, async () => {
    await driver.reset()
    const { store } = driver
    const enqueue = (runAt: number, partitionKey: string) => store.enqueue({
      requester: SYSTEM, job: { executionScope: executionScopeOf("system"), jobType: "regression", jobVersion: 1, payload: {}, runAt: new Date(runAt), partitionKey },
    })
    const crashed = await enqueue(T0 + 3_000, "orders")
    const [first] = await store.claimDue({ limit: 1, workerId: "w1", leaseDurationMs: HOUR, requester: SYSTEM, now: new Date(T0 + 3_000) })
    expect(first?.id).toBe(crashed.id)
    // A later arrival that sorts ahead of the crashed job (earlier runAt) in the same partition.
    const queued = await enqueue(T0 + 2_000, "orders")
    await driver.expireLease(crashed.id)
    // The crashed job still has status 'running' (its lease merely lapsed). One of the two must be claimable at limit 1.
    const claimed = await store.claimDue({ limit: 1, workerId: "w2", leaseDurationMs: HOUR, requester: SYSTEM, now: new Date(T0 + 3_000) })
    expect(claimed).toHaveLength(1)
    const winner = claimed[0]!
    expect([crashed.id, queued.id]).toContain(winner.id)
    // Only one job of the partition runs at a time, and the other becomes claimable once the first finishes.
    expect(await store.claimDue({ limit: 5, workerId: "w3", leaseDurationMs: HOUR, requester: SYSTEM, now: new Date(T0 + 3_000) })).toEqual([])
    expect(await store.markSucceeded({ jobId: winner.id, workerId: "w2", claimToken: winner.claimToken!, attempt: winner.currentAttempt })).toMatchObject({ applied: true })
    const rest = await store.claimDue({ limit: 5, workerId: "w3", leaseDurationMs: HOUR, requester: SYSTEM, now: new Date(T0 + 3_000) })
    expect(rest.map((job) => job.id)).toEqual([winner.id === crashed.id ? queued.id : crashed.id])
  })

  it(`a partition key is scoped to its tenant: another tenant's running job does not block it (${driver.label})`, async () => {
    await driver.reset()
    const { store } = driver
    const enqueue = (tenantId: "t1" | "t2") => store.enqueue({
      requester: requesterOf(tenantId),
      job: { executionScope: executionScopeOf(tenantId), jobType: "regression", jobVersion: 1, payload: {}, runAt: new Date(T0), partitionKey: "shared-partition-name" },
    })
    const one = await enqueue("t1")
    const two = await enqueue("t2")
    const claimedOne = await store.claimDue({ limit: 1, workerId: "w1", leaseDurationMs: HOUR, requester: requesterOf("t1"), now: new Date(T0 + 1) })
    expect(claimedOne.map((job) => job.id)).toEqual([one.id])
    const claimedTwo = await store.claimDue({ limit: 1, workerId: "w2", leaseDurationMs: HOUR, requester: requesterOf("t2"), now: new Date(T0 + 1) })
    expect(claimedTwo.map((job) => job.id)).toEqual([two.id])
  })

  it(`platform and system keys round-trip exactly and scope the partition: other keys neither block nor merge (${driver.label})`, async () => {
    await driver.reset()
    const { store } = driver
    const PLATFORM = requesterOf("plat")
    const enqueue = (requester: typeof PLATFORM | typeof SYSTEM, executionScope: JobExecutionScope, runAt: number) => store.enqueue({
      requester, job: { executionScope, jobType: "regression", jobVersion: 1, payload: {}, runAt: new Date(runAt), partitionKey: "shared-partition-name" },
    })
    const platformDefault = await enqueue(PLATFORM, { kind: "platform", platformKey: "default" }, T0)
    const platformA = await enqueue(PLATFORM, { kind: "platform", platformKey: "tenantless-a" }, T0 + 1)
    const platformB = await enqueue(PLATFORM, { kind: "platform", platformKey: "tenantless-b" }, T0 + 2)
    const platformASecond = await enqueue(PLATFORM, { kind: "platform", platformKey: "tenantless-a" }, T0 + 3)
    expect(platformA.executionScope).toEqual({ kind: "platform", platformKey: "tenantless-a" })
    expect(platformDefault.executionScope).toEqual({ kind: "platform", platformKey: "default" })
    // Three distinct keys share a partition name but are three partitions; the second job of key A waits behind the first.
    const claimed = await store.claimDue({ limit: 10, workerId: "w1", leaseDurationMs: HOUR, requester: PLATFORM, now: new Date(T0 + 10) })
    expect(claimed.map((job) => job.id).sort()).toEqual([platformDefault.id, platformA.id, platformB.id].sort())
    expect(Object.fromEntries(claimed.map((job) => [job.id, job.executionScope]))).toEqual({
      [platformDefault.id]: { kind: "platform", platformKey: "default" },
      [platformA.id]: { kind: "platform", platformKey: "tenantless-a" },
      [platformB.id]: { kind: "platform", platformKey: "tenantless-b" },
    })
    expect(await store.claimDue({ limit: 10, workerId: "w2", leaseDurationMs: HOUR, requester: PLATFORM, now: new Date(T0 + 10) })).toEqual([])
    const doneA = claimed.find((job) => job.id === platformA.id)!
    expect(await store.markSucceeded({ jobId: doneA.id, workerId: "w1", claimToken: doneA.claimToken!, attempt: doneA.currentAttempt })).toMatchObject({ applied: true })
    const next = await store.claimDue({ limit: 10, workerId: "w2", leaseDurationMs: HOUR, requester: PLATFORM, now: new Date(T0 + 10) })
    expect(next.map((job) => job.id)).toEqual([platformASecond.id])
    expect(next[0]!.executionScope).toEqual({ kind: "platform", platformKey: "tenantless-a" })
    // The same holds for system keys, and a read by id decodes the exact key as well.
    const systemDefault = await enqueue(SYSTEM, { kind: "system", systemKey: "framework" }, T0)
    const systemProbe = await enqueue(SYSTEM, { kind: "system", systemKey: "probe" }, T0 + 1)
    const systemClaimed = await store.claimDue({ limit: 10, workerId: "w3", leaseDurationMs: HOUR, requester: SYSTEM, now: new Date(T0 + 10) })
    expect(systemClaimed.map((job) => job.id).sort()).toEqual([systemDefault.id, systemProbe.id].sort())
    expect((await store.getById({ id: systemProbe.id, requester: SYSTEM }))?.executionScope).toEqual({ kind: "system", systemKey: "probe" })
  })

  it(`rows written before the scope-key column (scope_key NULL) decode to the framework default keys (${driver.label})`, async () => {
    await driver.reset()
    const { store } = driver
    const platform = await store.enqueue({ requester: requesterOf("plat"), job: { executionScope: { kind: "platform", platformKey: "tenantless-a" }, jobType: "regression", jobVersion: 1, payload: {}, runAt: new Date(T0) } })
    const system = await store.enqueue({ requester: SYSTEM, job: { executionScope: { kind: "system", systemKey: "probe" }, jobType: "regression", jobVersion: 1, payload: {}, runAt: new Date(T0) } })
    expect(platform.executionScope).toEqual({ kind: "platform", platformKey: "tenantless-a" })
    expect(system.executionScope).toEqual({ kind: "system", systemKey: "probe" })
    await driver.clearScopeKey(platform.id)
    await driver.clearScopeKey(system.id)
    expect((await store.getById({ id: platform.id, requester: requesterOf("plat") }))?.executionScope).toEqual({ kind: "platform", platformKey: "default" })
    expect((await store.getById({ id: system.id, requester: SYSTEM }))?.executionScope).toEqual({ kind: "system", systemKey: "framework" })
    const claimed = await store.claimDue({ limit: 5, workerId: "w1", leaseDurationMs: HOUR, requester: SYSTEM, now: new Date(T0 + 1) })
    expect(claimed.map((job) => job.executionScope)).toEqual([{ kind: "system", systemKey: "framework" }])
  })

  it(`a busy partition does not starve other jobs behind it at claim limit 1 (${driver.label})`, async () => {
    await driver.reset()
    const { store } = driver
    const enqueue = (runAt: number, partitionKey?: string) => store.enqueue({
      requester: SYSTEM,
      job: { executionScope: executionScopeOf("system"), jobType: "regression", jobVersion: 1, payload: {}, runAt: new Date(runAt), ...(partitionKey !== undefined ? { partitionKey } : {}) },
    })
    const running = await enqueue(T0, "busy")
    const waiting = await enqueue(T0 + 1, "busy")
    const free = await enqueue(T0 + 2)
    const [claimed] = await store.claimDue({ limit: 1, workerId: "w1", leaseDurationMs: HOUR, requester: SYSTEM, now: new Date(T0 + 10) })
    expect(claimed?.id).toBe(running.id)
    // 'waiting' is ahead of 'free' but blocked by the running sibling; it must not occupy the single claim slot.
    const next = await store.claimDue({ limit: 1, workerId: "w2", leaseDurationMs: HOUR, requester: SYSTEM, now: new Date(T0 + 10) })
    expect(next.map((job) => job.id)).toEqual([free.id])
    expect(waiting.id).not.toBe(free.id)
  })

  it(`claimDue with a non-positive or non-integral limit claims nothing (${driver.label})`, async () => {
    const { store } = driver
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await driver.reset()
      for (let index = 0; index < 3; index++) {
        await store.enqueue({ requester: SYSTEM, job: { executionScope: executionScopeOf("system"), jobType: "regression", jobVersion: 1, payload: {}, runAt: new Date(T0 + index) } })
      }
      await expect(store.claimDue({ limit, workerId: "w1", leaseDurationMs: HOUR, requester: SYSTEM, now: new Date(T0 + 100) }), `limit ${limit}`).resolves.toEqual([])
      expect((await store.findPending({ requester: SYSTEM })).length, `limit ${limit} must leave every job pending`).toBe(3)
    }
  })

  it(`renewLease never shortens the lease (${driver.label})`, async () => {
    await driver.reset()
    const claimed = await enqueueClaimed(driver, "w1")
    const before = (await driver.store.getById({ id: claimed.id, requester: SYSTEM }))!.leaseExpiresAt!.getTime()
    expect(await driver.store.renewLease({ jobId: claimed.id, workerId: "w1", claimToken: claimed.claimToken!, extendByMs: 1_000 })).toBe(true)
    const shorter = (await driver.store.getById({ id: claimed.id, requester: SYSTEM }))!.leaseExpiresAt!.getTime()
    expect(shorter).toBeGreaterThanOrEqual(before)
    expect(await driver.store.renewLease({ jobId: claimed.id, workerId: "w1", claimToken: claimed.claimToken!, extendByMs: 2 * HOUR })).toBe(true)
    const longer = (await driver.store.getById({ id: claimed.id, requester: SYSTEM }))!.leaseExpiresAt!.getTime()
    expect(longer).toBeGreaterThan(before + HOUR / 2)
  })

  it(`failure text containing a NUL character is recorded, not rejected (${driver.label})`, async () => {
    await driver.reset()
    const claimed = await enqueueClaimed(driver, "w1", { maxAttempts: 3 })
    const result = await driver.store.markRetrying({ jobId: claimed.id, workerId: "w1", claimToken: claimed.claimToken!, attempt: 1, nextAttemptAt: new Date(T0), error: "bad\u0000text" })
    expect(result).toMatchObject({ applied: true })
    const stored = await driver.store.getById({ id: claimed.id, requester: SYSTEM })
    expect(stored?.status).toBe("retrying")
    expect(stored?.lastError).toMatch(/^bad.text$/)
  })

  it(`claimDue stamps startedAt with the claim instant it was given (${driver.label})`, async () => {
    await driver.reset()
    const claimed = await enqueueClaimed(driver, "w1")
    expect(claimed.startedAt?.getTime()).toBe(T0 + 1)
  })

  it(`leases expire on the database clock, not the caller's now (${driver.label})`, async () => {
    await driver.reset()
    const { store } = driver
    // Nothing here depends on a lease staying live for a short real time (that would flake under load): liveness is
    // checked on an hour-long lease, and lapses are either forced through the database or waited for by polling.
    const tick = driver.leaseTickMs ?? 150
    const job = await store.enqueue({ requester: SYSTEM, job: { executionScope: executionScopeOf("system"), jobType: "regression", jobVersion: 1, payload: {}, runAt: new Date(T0), maxAttempts: 2 } })
    // `now` is an arbitrary instant years in the future: it decides due-ness only, never lease liveness.
    const farFuture = new Date(T0 + 365 * 24 * HOUR)
    const first = (await store.claimDue({ limit: 1, workerId: "w1", leaseDurationMs: HOUR, requester: SYSTEM, now: farFuture }))[0]!
    expect(first.id).toBe(job.id)
    expect(first.currentAttempt).toBe(1)
    // A live lease is neither reclaimable nor stealable, and renewing it moves its expiry past the original one.
    expect(await store.claimDue({ limit: 1, workerId: "w2", leaseDurationMs: HOUR, requester: SYSTEM, now: farFuture })).toEqual([])
    const firstExpiry = (await store.getById({ id: job.id, requester: SYSTEM }))!.leaseExpiresAt!.getTime()
    expect(await store.renewLease({ jobId: job.id, workerId: "w1", claimToken: first.claimToken!, extendByMs: 5 * HOUR })).toBe(true)
    expect((await store.getById({ id: job.id, requester: SYSTEM }))!.leaseExpiresAt!.getTime()).toBeGreaterThan(firstExpiry + 3 * HOUR)
    expect(await store.claimDue({ limit: 1, workerId: "w2", leaseDurationMs: HOUR, requester: SYSTEM, now: farFuture })).toEqual([])
    // Let it lapse: the old holder is fenced out everywhere and a new claim carries a fresh token and the next attempt.
    await driver.expireLease(job.id)
    expect(await store.renewLease({ jobId: job.id, workerId: "w1", claimToken: first.claimToken!, extendByMs: 1_000 })).toBe(false)
    expect(await store.markSucceeded({ jobId: job.id, workerId: "w1", claimToken: first.claimToken!, attempt: 1 })).toEqual({ applied: false, reason: "LEASE_LOST" })
    // The second lease is short and really runs out: the database clock, not the caller's now, decides when.
    const second = (await store.claimDue({ limit: 1, workerId: "w2", leaseDurationMs: tick, requester: SYSTEM, now: farFuture }))[0]!
    expect(second).toMatchObject({ id: job.id, currentAttempt: 2, leaseOwner: "w2" })
    expect(second.claimToken).not.toBe(first.claimToken)
    expect(await store.markSucceeded({ jobId: job.id, workerId: "w1", claimToken: first.claimToken!, attempt: 1 })).toEqual({ applied: false, reason: "LEASE_LOST" })
    expect(await store.markRetrying({ jobId: job.id, workerId: "w2", claimToken: second.claimToken!, attempt: 2, nextAttemptAt: farFuture, error: "x" })).toEqual({ applied: false, reason: "LEASE_LOST" })
    // The final attempt (2 of 2) lapses: nothing can reclaim it, so the next claim dead-letters it instead of leaving it running.
    await waitForLeaseToLapse(driver, job.id, tick)
    expect(await store.claimDue({ limit: 1, workerId: "w3", leaseDurationMs: tick, requester: SYSTEM, now: farFuture })).toEqual([])
    expect(await store.getById({ id: job.id, requester: SYSTEM })).toMatchObject({ status: "dead_letter", lastError: driver.expiredFinalAttemptError, leaseOwner: null, claimToken: null, currentAttempt: 2 })
    expect(await store.markSucceeded({ jobId: job.id, workerId: "w2", claimToken: second.claimToken!, attempt: 2 })).toEqual({ applied: false, reason: "LEASE_LOST" })
  })
}
