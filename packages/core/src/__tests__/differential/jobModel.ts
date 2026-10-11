import { dispatchDueJobs, type DispatchResult } from "../../execution/dispatcher"
import { createJobRegistry, type JobRegistry } from "../../execution/jobRegistry"
import {
  CancelledJobError, PermanentJobError, RetryableJobError, decodeStoredJobMaxAttempts, encodeStoredJobMaxAttempts,
  type CancelJobArgs, type ClaimDueJobsArgs, type CompleteJobArgs, type EnqueueJobArgs, type ExecutionClock, type FailJobArgs,
  type FindPendingArgs, type GetByCorrelationIdArgs, type GetByIdempotencyKeyArgs, type GetJobByIdArgs, type JobDefinition,
  type JobExecution, type JobResult, type JobStore, type JobTransitionResult, type ReleaseJobArgs, type RenewLeaseArgs,
  type RetryJobArgs, type StoredJob,
} from "../../execution/types"
import { createRng } from "./harness"

/**
 * Model-based harness for the job dispatcher.
 *
 * - {@link VirtualTime}: a deterministic clock whose timers only fire when the driver advances time.
 * - {@link JobStoreModel}: an in-memory JobStore that follows the contract of execution/types.ts and the
 *   reference adapter semantics (attempt counted at claim, fenced mutations, strict lease boundaries,
 *   dead-lettering of an expired final attempt, release giving the attempt back).
 * - {@link runScenario}: drives several dispatcher workers through a random operation sequence and checks
 *   the dispatcher against an independent oracle (allowed transitions per scripted handler behaviour, an
 *   iterative backoff reference, deferral-window bookkeeping, and store-side legality).
 */

export const EPOCH = Date.UTC(2030, 0, 1)
const DAY_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------------------------------
// Virtual time

interface Timer { at: number; seq: number; owner: string; callback: () => void }

export class VirtualTime {
  now = EPOCH
  readonly dead = new Set<string>()
  private sequence = 0
  private readonly timers = new Map<number, Timer>()

  schedule(owner: string, ms: number, callback: () => void): number {
    const id = ++this.sequence
    this.timers.set(id, { at: this.now + Math.max(0, ms), seq: id, owner, callback })
    return id
  }

  cancel(id: number): void { this.timers.delete(id) }

  /** Earliest pending timer of a live owner. */
  nextAt(): number | undefined {
    let best: number | undefined
    for (const timer of this.timers.values()) if (!this.dead.has(timer.owner) && (best === undefined || timer.at < best)) best = timer.at
    return best
  }

  /** Let promise continuations run (deterministic: microtasks only). */
  async settle(ticks = 60): Promise<void> {
    for (let index = 0; index < ticks; index++) await Promise.resolve()
  }

  /** Fires every timer due at or before `target` in (time, creation) order, then sets the clock to `target`. */
  async advanceTo(target: number): Promise<void> {
    for (;;) {
      let next: [number, Timer] | undefined
      for (const entry of this.timers) {
        const timer = entry[1]
        if (this.dead.has(timer.owner)) { this.timers.delete(entry[0]); continue }
        if (timer.at > target) continue
        if (!next || timer.at < next[1].at || (timer.at === next[1].at && timer.seq < next[1].seq)) next = entry
      }
      if (!next) break
      this.timers.delete(next[0])
      this.now = Math.max(this.now, next[1].at)
      next[1].callback()
      await this.settle()
    }
    this.now = Math.max(this.now, target)
    await this.settle()
  }
}

// ---------------------------------------------------------------------------------------------------
// Job catalogue

export type JobTypeName = "A" | "B" | "C" | "T" | "W" | "G"
export type ErrKind =
  | "error" | "retryable" | "permanent" | "cancelled" | "string" | "null" | "undefined" | "number"
  | "kindPermanent" | "kindCancelled" | "kindBogus" | "noError"
export type Behavior =
  | { k: "ok"; ms: number; data?: "bigint" | "circular" }
  | { k: "fail"; ms: number; via: "result" | "throw"; err: ErrKind; /** Error text far beyond any text column. */ huge?: boolean }
  | { k: "coop"; cleanupMs: number; via: "result" | "throw"; err: ErrKind }
  | { k: "effect"; pre: number; post: number }
  /** execute() throws synchronously instead of returning a promise. */
  | { k: "syncThrow"; err: ErrKind }
  /** execute() resolves to something that is not a JobResult. */
  | { k: "badResult"; shape: "undefined" | "empty" | "null" }
export type PayloadKind = "ok" | "notJson" | "array" | "reject"
export type FailureClass = "retryable" | "permanent" | "cancelled"

export const FAILURE_CLASS: Record<ErrKind, FailureClass> = {
  error: "retryable", retryable: "retryable", permanent: "permanent", cancelled: "cancelled", string: "retryable", null: "retryable",
  undefined: "retryable", number: "retryable", kindPermanent: "permanent", kindCancelled: "cancelled", kindBogus: "retryable", noError: "retryable",
}

export interface JobSpec {
  type: JobTypeName
  version: number
  scope: "system" | "tenant"
  maxAttempts?: number
  runAfterMs: number
  priority: number
  payload: PayloadKind
  script: Behavior[]
}

export interface WorkerSpec {
  /** Which definitions this worker has registered. */
  has: { A: boolean; B: boolean; C: boolean; T: boolean }
  /** W versions registered on this worker. */
  w: "none" | "v1" | "v2" | "both"
  /** Whether the registry can upcast W@1 payloads to W@2. */
  upcaster: boolean
  /** Constant offset between this worker's clock and the store clock. */
  skew: number
}

export type SimOp =
  | { k: "enqueue"; job: number }
  | { k: "tick"; w: number }
  | { k: "advance"; ms: number }
  | { k: "jump"; ms: number }
  | { k: "crash"; w: number }
  | { k: "skew"; w: number; skew: number }
  | { k: "cancel"; job: number }

export interface JobScenario {
  seed: number
  leaseMs: number
  claimLimit: number
  capMs: number
  hasRelease: boolean
  timeoutPolicy: { timeoutMs?: number; graceMs: number } | null
  maxLatencyMs: number
  faultPerMille: number
  workers: WorkerSpec[]
  jobs: JobSpec[]
  ops: SimOp[]
}

interface DefShape { maxAttempts: number; delayMs: number; mult: number; timeoutMs?: number; scope: "system" | "tenant" }

export function definitionShape(type: Exclude<JobTypeName, "G">, leaseMs: number): DefShape {
  switch (type) {
    case "A": return { maxAttempts: 3, delayMs: 100, mult: 2, scope: "system" }
    case "B": return { maxAttempts: 1, delayMs: 0, mult: 1, timeoutMs: leaseMs * 2, scope: "system" }
    case "C": return { maxAttempts: 5, delayMs: 50, mult: 1.5, timeoutMs: Math.max(1, Math.floor(leaseMs / 2)), scope: "system" }
    case "T": return { maxAttempts: 2, delayMs: 20, mult: 3, scope: "tenant" }
    case "W": return { maxAttempts: 4, delayMs: 10, mult: 2, scope: "system" }
  }
}

/** Independent, iterative backoff reference (the production code uses a closed form in log space). */
export function referenceBackoffMs(delayMs: number, mult: number, maxDelayMs: number | undefined, attempt: number): number {
  const cap = maxDelayMs ?? Math.max(DAY_MS, delayMs)
  let delay = Math.min(delayMs, cap)
  for (let step = 1; step < attempt; step++) {
    delay = Math.min(delay * mult, cap)
  }
  return delay
}

export function jobMaxAttempts(spec: JobSpec, leaseMs: number): number | undefined {
  if (spec.maxAttempts !== undefined) return spec.maxAttempts
  return spec.type === "G" ? undefined : definitionShape(spec.type, leaseMs).maxAttempts
}

function errorValue(err: ErrKind, huge = false): unknown {
  const text = (base: string): string => (huge ? `${base} ${"\u20AC".repeat(30_000)}` : base)
  switch (err) {
    case "error": return new Error(text("boom"))
    case "retryable": return new RetryableJobError(text("retry me"))
    case "permanent": return new PermanentJobError(text("never"))
    case "cancelled": return new CancelledJobError("stop")
    case "string": return "string failure"
    case "null": return null
    case "undefined": return undefined
    case "number": return 42
    case "kindPermanent": return { kind: "permanent", message: "plain permanent" }
    case "kindCancelled": return { kind: "cancelled", message: "plain cancelled" }
    case "kindBogus": return { kind: "weird", message: "plain bogus" }
    case "noError": return undefined
  }
}

// ---------------------------------------------------------------------------------------------------
// Store

type Terminal = "succeeded" | "failed" | "dead_letter" | "cancelled"
const TERMINAL: ReadonlySet<string> = new Set<Terminal>(["succeeded", "failed", "dead_letter", "cancelled"])

interface Row {
  id: string
  spec: JobSpec
  payload: string
  status: StoredJob["status"]
  attempts: number
  storedMax: number
  runAt: number
  nextAttemptAt: number | null
  leaseOwner: string | null
  claimToken: string | null
  leaseExpiresAt: number | null
  lastError: string | null
  createdAt: number
}

export type StoreOp = "enqueue" | "claim" | "renew" | "succeed" | "retry" | "fail" | "release" | "cancel" | "expire"
export interface StoreLogEntry {
  t: number
  op: StoreOp
  jobId: string
  worker: string | null
  token: string | null
  attempt: number | null
  applied: boolean
  /** Status the row had after the call. */
  status: string
  attemptsAfter: number
  /** The calling worker's own clock when it made the call. */
  workerNow: number | null
  nextAttemptAt: number | null
  error: string | null
  failStatus: string | null
  /** Lease expiry installed by this call (claim / renew). */
  leaseUntil: number | null
}

interface ClaimRecord { jobId: string; worker: string; token: string; attempt: number; t: number; workerNow: number; liveUntil: number; index: number }

export class JobStoreModel {
  readonly rows = new Map<string, Row>()
  readonly log: StoreLogEntry[] = []
  readonly claims = new Map<string, ClaimRecord>()
  private tokenSeq = 0
  private idSeq = 0

  constructor(private readonly time: VirtualTime, readonly hasRelease: boolean) {}

  insert(spec: JobSpec, payload: string): Row {
    const id = `job-${++this.idSeq}`
    const row: Row = {
      id, spec, payload, status: "pending", attempts: 0, storedMax: encodeStoredJobMaxAttempts(spec.maxAttempts),
      runAt: this.time.now + spec.runAfterMs, nextAttemptAt: null, leaseOwner: null, claimToken: null, leaseExpiresAt: null,
      lastError: null, createdAt: this.time.now,
    }
    this.rows.set(id, row)
    this.record("enqueue", row, null, null, null, true, null)
    return row
  }

  private record(op: StoreOp, row: Row, worker: string | null, token: string | null, attempt: number | null, applied: boolean, workerNow: number | null, extra: Partial<StoreLogEntry> = {}): void {
    this.log.push({
      t: this.time.now, op, jobId: row.id, worker, token, attempt, applied, status: row.status, attemptsAfter: row.attempts, workerNow,
      nextAttemptAt: null, error: null, failStatus: null, leaseUntil: null, ...extra,
    })
  }

  private toStored(row: Row): StoredJob {
    const tenant = row.spec.scope === "tenant"
    return {
      id: row.id, jobType: row.spec.type, jobVersion: row.spec.version, tenantId: tenant ? "t1" : null,
      executionScope: tenant ? { kind: "tenant", tenantId: "t1" } : { kind: "system", systemKey: "framework" },
      scope: row.spec.scope, payload: row.payload, status: row.status, priority: row.spec.priority,
      attemptsCompleted: Math.max(0, row.attempts - 1), currentAttempt: row.attempts,
      maxAttempts: decodeStoredJobMaxAttempts(row.storedMax), runAt: new Date(row.runAt),
      nextAttemptAt: row.nextAttemptAt === null ? null : new Date(row.nextAttemptAt),
      leaseOwner: row.leaseOwner, leaseExpiresAt: row.leaseExpiresAt === null ? null : new Date(row.leaseExpiresAt),
      claimToken: row.claimToken, idempotencyKey: null, fingerprint: `fp-${row.id}`, correlationId: null, lastError: row.lastError,
      resultPayload: null, metadata: null, partitionKey: null, createdAt: new Date(row.createdAt), startedAt: null, completedAt: null,
    }
  }

  private leaseLive(row: Row, worker: string, token: string): boolean {
    return row.status === "running" && row.leaseOwner === worker && row.claimToken === token && row.leaseExpiresAt !== null && row.leaseExpiresAt > this.time.now
  }

  private clearLease(row: Row): void { row.leaseOwner = null; row.claimToken = null; row.leaseExpiresAt = null }

  claim(args: { limit: number; worker: string; leaseMs: number; dueBefore: number; workerNow: number }): StoredJob[] {
    const now = this.time.now
    for (const row of this.rows.values()) {
      if (row.status === "running" && row.leaseExpiresAt !== null && row.leaseExpiresAt < now && row.attempts >= row.storedMax) {
        row.status = "dead_letter"; row.lastError = "LEASE_EXPIRED_ON_FINAL_ATTEMPT"; this.clearLease(row)
        this.record("expire", row, null, null, null, true, null, { error: row.lastError })
      }
    }
    const due = [...this.rows.values()].filter((row) => {
      if ((row.status === "pending" || row.status === "retrying") && row.attempts < row.storedMax) return (row.nextAttemptAt ?? row.runAt) <= args.dueBefore
      return row.status === "running" && row.attempts < row.storedMax && row.leaseExpiresAt !== null && row.leaseExpiresAt < now
    })
    due.sort((left, right) => left.spec.priority - right.spec.priority || left.runAt - right.runAt || (left.id < right.id ? -1 : 1))
    const out: StoredJob[] = []
    for (const row of due.slice(0, Math.max(0, args.limit))) {
      row.status = "running"; row.leaseOwner = args.worker; row.claimToken = `tok-${++this.tokenSeq}`
      row.leaseExpiresAt = now + args.leaseMs; row.attempts += 1; row.nextAttemptAt = null
      const claim: ClaimRecord = { jobId: row.id, worker: args.worker, token: row.claimToken, attempt: row.attempts, t: now, workerNow: args.workerNow, liveUntil: row.leaseExpiresAt, index: this.log.length }
      this.claims.set(row.claimToken, claim)
      this.record("claim", row, args.worker, row.claimToken, row.attempts, true, args.workerNow, { leaseUntil: row.leaseExpiresAt })
      out.push(this.toStored(row))
    }
    return out
  }

  renew(args: RenewLeaseArgs, workerNow: number): boolean {
    const row = this.rows.get(args.jobId)
    if (!row) return false
    if (!Number.isFinite(args.extendByMs) || args.extendByMs <= 0 || !this.leaseLive(row, args.workerId, args.claimToken)) {
      this.record("renew", row, args.workerId, args.claimToken, null, false, workerNow)
      return false
    }
    // Expiry only ever moves forward for a live claim.
    row.leaseExpiresAt = Math.max(row.leaseExpiresAt!, this.time.now + args.extendByMs)
    const claim = this.claims.get(args.claimToken)
    if (claim) claim.liveUntil = row.leaseExpiresAt
    this.record("renew", row, args.workerId, args.claimToken, null, true, workerNow, { leaseUntil: row.leaseExpiresAt })
    return true
  }

  succeed(args: CompleteJobArgs, workerNow: number): JobTransitionResult {
    // The SQL adapters persist the result with JSON.stringify before touching the row.
    if (args.result) JSON.stringify(args.result)
    const row = this.rows.get(args.jobId)
    if (!row) return { applied: false, reason: "LEASE_LOST" }
    const ok = this.leaseLive(row, args.workerId, args.claimToken) && row.attempts === args.attempt
    if (ok) { row.status = "succeeded"; this.clearLease(row) }
    this.record("succeed", row, args.workerId, args.claimToken, args.attempt, ok, workerNow)
    return ok ? { applied: true, transitionToken: `tt-${++this.tokenSeq}` } : { applied: false, reason: "LEASE_LOST" }
  }

  /** MySQL TEXT: a value over 65,535 bytes is rejected (strict mode) instead of being truncated. */
  private assertErrorColumn(error: string): void {
    if (new TextEncoder().encode(error).byteLength > 65_535) throw new Error("Data too long for column 'last_error'")
  }

  retry(args: RetryJobArgs, workerNow: number): JobTransitionResult {
    this.assertErrorColumn(args.error)
    const row = this.rows.get(args.jobId)
    if (!row) return { applied: false, reason: "LEASE_LOST" }
    const ok = this.leaseLive(row, args.workerId, args.claimToken) && row.attempts === args.attempt && row.attempts < row.storedMax
    if (ok) { row.status = "retrying"; row.nextAttemptAt = args.nextAttemptAt.getTime(); row.lastError = args.error; this.clearLease(row) }
    this.record("retry", row, args.workerId, args.claimToken, args.attempt, ok, workerNow, { nextAttemptAt: args.nextAttemptAt.getTime(), error: args.error })
    return ok ? { applied: true, transitionToken: `tt-${++this.tokenSeq}` } : { applied: false, reason: "LEASE_LOST" }
  }

  fail(args: FailJobArgs, workerNow: number): JobTransitionResult {
    this.assertErrorColumn(args.error)
    const row = this.rows.get(args.jobId)
    if (!row) return { applied: false, reason: "LEASE_LOST" }
    const ok = this.leaseLive(row, args.workerId, args.claimToken) && row.attempts === args.attempt
    if (ok) { row.status = args.status; row.lastError = args.error; this.clearLease(row) }
    this.record("fail", row, args.workerId, args.claimToken, args.attempt, ok, workerNow, { error: args.error, failStatus: args.status })
    return ok ? { applied: true, transitionToken: `tt-${++this.tokenSeq}` } : { applied: false, reason: "LEASE_LOST" }
  }

  release(args: ReleaseJobArgs, workerNow: number): JobTransitionResult {
    const row = this.rows.get(args.jobId)
    if (!row) return { applied: false, reason: "LEASE_LOST" }
    const ok = this.leaseLive(row, args.workerId, args.claimToken)
    if (ok) {
      row.status = "retrying"; row.attempts = Math.max(0, row.attempts - 1); row.nextAttemptAt = args.nextAttemptAt.getTime()
      row.lastError = args.reason.slice(0, 512); this.clearLease(row)
    }
    this.record("release", row, args.workerId, args.claimToken, null, ok, workerNow, { nextAttemptAt: args.nextAttemptAt.getTime(), error: args.reason })
    return ok ? { applied: true } : { applied: false, reason: "LEASE_LOST" }
  }

  cancelRow(jobId: string): JobTransitionResult {
    const row = this.rows.get(jobId)
    if (!row || TERMINAL.has(row.status)) return { applied: false, reason: "INVALID_STATE" }
    row.status = "cancelled"; this.clearLease(row)
    this.record("cancel", row, null, null, null, true, null)
    return { applied: true }
  }

  /** The JobStore a single worker sees (latency, faults and crash handling are layered on by the simulation). */
  asJobStore(wrap: <T>(name: string, run: (workerNow: number) => T) => Promise<T>): JobStore {
    const notImplemented = (name: string): never => { throw new Error(`${name} is not used by the dispatcher`) }
    const store: JobStore = {
      enqueue: async (_args: EnqueueJobArgs) => notImplemented("enqueue"),
      getById: async (args: GetJobByIdArgs) => { const row = this.rows.get(args.id); return row ? this.toStored(row) : null },
      getByCorrelationId: async (_args: GetByCorrelationIdArgs) => [],
      getLatestPriorScheduleExecution: async () => null,
      getByIdempotencyKey: async (_args: GetByIdempotencyKeyArgs) => null,
      claimDue: (args: ClaimDueJobsArgs) => wrap("claimDue", (workerNow) => this.claim({ limit: args.limit, worker: args.workerId, leaseMs: args.leaseDurationMs, dueBefore: (args.now ?? new Date(workerNow)).getTime(), workerNow })),
      renewLease: (args) => wrap("renewLease", (workerNow) => this.renew(args, workerNow)),
      markSucceeded: (args) => wrap("markSucceeded", (workerNow) => this.succeed(args, workerNow)),
      markRetrying: (args) => wrap("markRetrying", (workerNow) => this.retry(args, workerNow)),
      markFailed: (args) => wrap("markFailed", (workerNow) => this.fail(args, workerNow)),
      cancel: async (args: CancelJobArgs) => this.cancelRow(args.jobId),
      findPending: async (_args: FindPendingArgs) => [],
    }
    if (this.hasRelease) store.release = (args) => wrap("release", (workerNow) => this.release(args, workerNow))
    return store
  }
}

// ---------------------------------------------------------------------------------------------------
// Simulation

interface WorkerState {
  index: number
  id: string
  owner: string
  spec: WorkerSpec
  skew: number
  alive: boolean
  faults: number
  running: number
  store: JobStore
  registry: JobRegistry
}

interface StartRecord { jobId: string; worker: string; attempt: number; token: string; t: number; executionId: string; finished: boolean; finishedAt: number | undefined; returnedSuccess: boolean }
interface Window { worker: string; from: number; to: number; faultsStart: number; faultsEnd: number; overlapped: boolean; result: DispatchResult | undefined; failed: boolean }

export interface SimOutcome {
  violations: string[]
  statuses: Record<string, string>
  starts: number
  dispatches: number
  telemetryEvents: number
  log: readonly StoreLogEntry[]
}

const MAX_DRAIN_STEPS = 4000

export async function runScenario(scenario: JobScenario): Promise<SimOutcome> {
  // A promise the dispatcher rejects with nobody listening is a process-level failure in production (Node >= 15).
  const unhandled: string[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason instanceof Error ? reason.message : String(reason)) }
  process.on("unhandledRejection", onUnhandled)
  try {
    const outcome = await runScenarioInner(scenario)
    // Rejections are reported once the microtask queue has drained, i.e. on the next event-loop turn (no clock involved).
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    if (unhandled.length > 0) outcome.violations.push(`unhandled promise rejection(s): ${unhandled.slice(0, 3).join(" | ")}`)
    return outcome
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
}

async function runScenarioInner(scenario: JobScenario): Promise<SimOutcome> {
  const time = new VirtualTime()
  const rng = createRng(scenario.seed)
  const store = new JobStoreModel(time, scenario.hasRelease)
  const violations: string[] = []
  const complain = (message: string): void => { if (violations.length < 12) violations.push(`t=${time.now - EPOCH} ${message}`) }
  const starts: StartRecord[] = []
  const windows: Window[] = []
  const workers: WorkerState[] = []
  const rowOf = new Map<string, Row>()
  // Telemetry is observational: a sink that throws or rejects must not change any outcome, and it must never see a claim token.
  const telemetryLines: string[] = []
  let telemetryCalls = 0
  const telemetry = {
    emit: (event: unknown): void | Promise<void> => {
      telemetryCalls++
      telemetryLines.push(JSON.stringify(event))
      if (telemetryCalls % 7 === 0) throw new Error("telemetry sink down")
      if (telemetryCalls % 11 === 0) return Promise.reject(new Error("telemetry sink rejected"))
      return undefined
    },
  }
  let faultsEnabled = true
  let maxSkew = 0
  let executionSeq = 0

  const claimFor = (jobId: string, worker: string, attempt: number): ClaimRecord | undefined => {
    let found: ClaimRecord | undefined
    for (const claim of store.claims.values()) if (claim.jobId === jobId && claim.worker === worker && claim.attempt === attempt) found = claim
    return found
  }

  const assertClaimLive = (what: string, jobId: string, token: string): void => {
    const row = store.rows.get(jobId)
    if (!row || row.status !== "running" || row.claimToken !== token || row.leaseExpiresAt === null || row.leaseExpiresAt <= time.now) {
      complain(`${what}: job ${jobId} ran without a live claim ${token} (row ${row?.status}/${row?.claimToken}/${row?.leaseExpiresAt === null ? "-" : (row?.leaseExpiresAt ?? 0) - time.now}ms)`)
    }
  }

  // Handler: scripted behaviour, with the fencing/exclusivity checks that only the handler can observe.
  const execute = (worker: () => WorkerState, shape: DefShape | undefined) => (ctx: JobExecution): Promise<JobResult> => {
    const w = worker()
    const claim = claimFor(ctx.jobId, w.id, ctx.attempt)
    if (!claim) { complain(`handler for ${ctx.jobId} attempt ${ctx.attempt} started without a claim by ${w.id}`); return Promise.resolve({ success: true }) }
    assertClaimLive("handler start", ctx.jobId, claim.token)
    const row = store.rows.get(ctx.jobId)!
    const limit = row.spec.maxAttempts ?? shape?.maxAttempts
    if (limit !== undefined && ctx.attempt > limit) complain(`handler for ${ctx.jobId} started at attempt ${ctx.attempt} > maxAttempts ${limit}`)
    for (const earlier of starts) {
      if (earlier.jobId !== ctx.jobId) continue
      if (earlier.token === claim.token) complain(`claim ${claim.token} executed twice`)
      if (earlier.attempt >= ctx.attempt && earlier.t <= time.now) complain(`job ${ctx.jobId} attempt numbers not increasing across executions (${earlier.attempt} then ${ctx.attempt})`)
      const earlierClaim = store.claims.get(earlier.token)
      if (!earlier.finished && earlierClaim && earlierClaim.liveUntil >= time.now && earlier.token !== claim.token) complain(`two live leases for ${ctx.jobId}: ${earlier.token} (until +${earlierClaim.liveUntil - time.now}) and ${claim.token}`)
    }
    const record: StartRecord = { jobId: ctx.jobId, worker: w.id, attempt: ctx.attempt, token: claim.token, t: time.now, executionId: ctx.executionId, finished: false, finishedAt: undefined, returnedSuccess: false }
    starts.push(record)
    const script = (ctx.payload as { script?: Behavior[] }).script ?? []
    const behavior: Behavior = script[Math.min(ctx.attempt - 1, script.length - 1)] ?? { k: "ok", ms: 0 }
    const sleep = (ms: number): Promise<void> => ctx.clock!.sleep(ms)
    if (behavior.k === "syncThrow") { record.finished = true; record.finishedAt = time.now; throw errorValue(behavior.err) }
    return perform(behavior, ctx, record, claim, sleep)
  }

  const perform = async (behavior: Behavior, ctx: JobExecution, record: StartRecord, claim: ClaimRecord, sleep: (ms: number) => Promise<void>): Promise<JobResult> => {
    const failWith = (via: "result" | "throw", err: ErrKind, huge = false): JobResult => {
      if (err === "noError" && via === "result") return { success: false, data: { errorMessage: "data message" } }
      if (via === "throw") throw errorValue(err, huge)
      return { success: false, error: errorValue(err, huge) as never }
    }
    try {
      switch (behavior.k) {
        case "syncThrow": throw new Error("unreachable")
        case "badResult": return (behavior.shape === "undefined" ? undefined : behavior.shape === "null" ? null : {}) as never
        case "ok": {
          await sleep(behavior.ms)
          if (behavior.data === undefined) { record.returnedSuccess = !ctx.signal?.aborted; return { success: true, data: { attempt: ctx.attempt } } }
          const data: Record<string, unknown> = { attempt: ctx.attempt }
          if (behavior.data === "bigint") data.big = 10n
          else data.self = data
          record.returnedSuccess = !ctx.signal?.aborted
          return { success: true, data }
        }
        case "fail": await sleep(behavior.ms); return failWith(behavior.via, behavior.err, behavior.huge === true)
        case "coop": {
          await new Promise<void>((resolve) => { if (ctx.signal!.aborted) resolve(); else ctx.signal!.addEventListener("abort", () => resolve(), { once: true }) })
          await sleep(behavior.cleanupMs)
          return failWith(behavior.via, behavior.err)
        }
        case "effect": {
          await sleep(behavior.pre)
          await ctx.fencedEffect.execute({
            effectName: "side-effect", idempotencyKey: `${ctx.jobId}:${ctx.attempt}`,
            fn: async () => { assertClaimLive("fenced effect", ctx.jobId, claim.token) },
          })
          await sleep(behavior.post)
          return { success: true }
        }
      }
    } finally { record.finished = true; record.finishedAt = time.now }
  }

  const buildRegistry = (worker: () => WorkerState, spec: WorkerSpec): JobRegistry => {
    const registry = createJobRegistry({
      now: () => new Date(time.now),
      upcasters: spec.upcaster ? [{ type: "W", from: 1, to: 2, upcast: (payload) => ({ ...(payload as object), upgraded: true }) }] : [],
    })
    const decode = (withUpgrade: boolean) => (input: unknown): Record<string, unknown> => {
      const value = input as Record<string, unknown>
      if (value.reject === true) throw new Error("payload rejected by schema")
      if (withUpgrade && value.upgraded !== true) throw new Error("payload is not upgraded")
      return value
    }
    const add = (type: Exclude<JobTypeName, "G">, version: number, withUpgrade = false): void => {
      const shape = definitionShape(type, scenario.leaseMs)
      const definition: JobDefinition = {
        type, version, scope: shape.scope, maxAttempts: shape.maxAttempts, retryDelayMs: shape.delayMs, retryBackoffMultiplier: shape.mult,
        ...(shape.timeoutMs === undefined ? {} : { timeoutMs: shape.timeoutMs }),
        decodePayload: decode(withUpgrade), execute: execute(worker, shape),
        // Lifecycle hooks run after the transition committed; a failing hook must not change the outcome.
        onRetry: async (ctx, error) => {
          if (ctx.transitionToken === undefined) complain(`onRetry for ${ctx.jobId} ran without the transition token`)
          if (!(error instanceof Error)) complain("onRetry received a non-Error")
          if (ctx.attempt % 2 === 0) throw new Error("onRetry hook failed")
        },
        onMaxRetriesExceeded: async (ctx) => {
          if (ctx.transitionToken === undefined) complain(`onMaxRetriesExceeded for ${ctx.jobId} ran without the transition token`)
          if (ctx.attempt % 2 === 1) throw new Error("onMaxRetriesExceeded hook failed")
        },
      }
      registry.register(definition)
    }
    for (const type of ["A", "B", "C", "T"] as const) if (spec.has[type]) add(type, 1)
    if (spec.w === "v1" || spec.w === "both") add("W", 1)
    if (spec.w === "v2" || spec.w === "both") add("W", 2, true)
    return registry
  }

  const addWorker = (spec: WorkerSpec, label: string): WorkerState => {
    const index = workers.length
    const state: WorkerState = { index, id: label, owner: `${label}#${index}`, spec, skew: spec.skew, alive: true, faults: 0, running: 0, store: undefined as never, registry: undefined as never }
    maxSkew = Math.max(maxSkew, Math.abs(spec.skew))
    const never = <T>(): Promise<T> => new Promise<T>(() => undefined)
    const wrap = async <T>(_name: string, run: (workerNow: number) => T): Promise<T> => {
      if (!state.alive) return never<T>()
      const workerNow = Math.trunc(time.now + state.skew)
      let fault: "none" | "before" | "after" = "none"
      if (faultsEnabled && scenario.faultPerMille > 0 && rng.int(1000) < scenario.faultPerMille) fault = rng.bool() ? "before" : "after"
      const latency = scenario.maxLatencyMs > 0 ? rng.int(scenario.maxLatencyMs + 1) : 0
      if (latency > 0) await new Promise<void>((resolve) => { time.schedule(state.owner, latency, resolve) })
      else await Promise.resolve()
      if (!state.alive) return never<T>()
      if (fault === "before") { state.faults++; throw new Error("store unavailable") }
      const out = run(workerNow)
      if (fault === "after") { state.faults++; throw new Error("store acknowledgement lost") }
      return out
    }
    state.store = store.asJobStore(wrap)
    state.registry = buildRegistry(() => state, spec)
    workers.push(state)
    return state
  }

  const clockFor = (w: WorkerState): ExecutionClock => ({
    now: () => new Date(time.now + w.skew),
    sleep: (ms, signal) => new Promise<void>((resolve) => {
      if (signal?.aborted) { resolve(); return }
      const onAbort = (): void => { time.cancel(id); resolve() }
      const id = time.schedule(w.owner, ms, () => { signal?.removeEventListener("abort", onAbort); resolve() })
      signal?.addEventListener("abort", onAbort, { once: true })
    }),
    setTimeout: (callback, ms) => time.schedule(w.owner, ms, callback),
    clearTimeout: (handle) => { time.cancel(handle as number) },
  })

  const pendingDispatch = new Map<WorkerState, Promise<void>>()
  const startDispatch = (w: WorkerState): void => {
    if (!w.alive) return
    const overlapped = w.running > 0
    if (overlapped) for (const earlier of windows) if (earlier.worker === w.id) earlier.overlapped = true
    w.running++
    const window: Window = { worker: w.id, from: store.log.length, to: -1, faultsStart: w.faults, faultsEnd: -1, overlapped, result: undefined, failed: false }
    windows.push(window)
    const call = dispatchDueJobs({
      store: w.store, registry: w.registry, workerId: w.id, leaseDurationMs: scenario.leaseMs, claimLimit: scenario.claimLimit,
      requester: { scope: "system" }, clock: clockFor(w), telemetry, idGenerator: () => `exec-${++executionSeq}`,
      unknownDefinitionMaxDeferralMs: scenario.capMs,
      ...(scenario.timeoutPolicy ? { timeoutPolicy: { mode: "cooperative" as const, cancellationGraceMs: scenario.timeoutPolicy.graceMs, ...(scenario.timeoutPolicy.timeoutMs === undefined ? {} : { timeoutMs: scenario.timeoutPolicy.timeoutMs }) } } : {}),
    }).then((result) => { window.result = result }, (error: unknown) => {
      window.failed = true
      if (w.faults === window.faultsStart) complain(`dispatchDueJobs rejected without any injected fault: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      w.running--
      window.to = store.log.length
      window.faultsEnd = w.faults
      if (pendingDispatch.get(w) === tracked) pendingDispatch.delete(w)
    })
    const tracked = call
    pendingDispatch.set(w, tracked)
  }

  const snapshotStatus = new Map<string, string>()
  const checkRows = (): void => {
    for (const row of store.rows.values()) {
      const prev = snapshotStatus.get(row.id)
      if (prev !== undefined && TERMINAL.has(prev) && prev !== row.status) complain(`terminal state ${prev} of ${row.id} changed to ${row.status}`)
      snapshotStatus.set(row.id, row.status)
      const leased = row.leaseOwner !== null || row.claimToken !== null || row.leaseExpiresAt !== null
      if (row.status === "running" && (row.leaseOwner === null || row.claimToken === null || row.leaseExpiresAt === null)) complain(`running ${row.id} lacks a complete lease`)
      if (row.status !== "running" && leased) complain(`${row.status} ${row.id} still holds lease fields`)
      if (row.attempts < 0) complain(`${row.id} negative attempts`)
      if (row.spec.maxAttempts !== undefined && row.attempts > row.spec.maxAttempts) complain(`${row.id} attempts ${row.attempts} exceed maxAttempts ${row.spec.maxAttempts}`)
    }
  }

  const enqueue = (index: number): void => {
    const spec = scenario.jobs[index]
    if (!spec) return
    const script = JSON.stringify(spec.script)
    let payload: string
    switch (spec.payload) {
      case "notJson": payload = "not json {"; break
      case "array": payload = "[1,2]"; break
      case "reject": payload = `{"script":${script},"reject":true}`; break
      default: payload = spec.version === 2 && spec.type === "W" ? `{"script":${script},"upgraded":true}` : `{"script":${script}}`
    }
    rowOf.set(`op-${index}`, store.insert(spec, payload))
  }

  const baseSpecs = scenario.workers
  for (let index = 0; index < baseSpecs.length; index++) addWorker(baseSpecs[index]!, `w${index + 1}`)

  const stepTo = async (target: number): Promise<void> => { await time.advanceTo(target); checkRows() }

  for (const op of scenario.ops) {
    switch (op.k) {
      case "enqueue": enqueue(op.job); break
      case "tick": { const w = workers[op.w % workers.length]; if (w) startDispatch(w); break }
      case "advance": await stepTo(time.now + op.ms); break
      case "jump": await stepTo(time.now + op.ms); break
      case "crash": { const w = workers[op.w % workers.length]; if (w?.alive) { w.alive = false; time.dead.add(w.owner); pendingDispatch.delete(w) } break }
      case "skew": { const w = workers[op.w % workers.length]; if (w) { w.skew = op.skew; maxSkew = Math.max(maxSkew, Math.abs(op.skew)) } break }
      case "cancel": { const row = rowOf.get(`op-${op.job}`); if (row) store.cancelRow(row.id); break }
    }
    await stepTo(time.now)
  }

  // Drain: faults off, surviving workers keep polling until every job is terminal.
  faultsEnabled = false
  let survivors = workers.filter((w) => w.alive)
  if (survivors.length === 0) survivors = [addWorker({ has: { A: true, B: true, C: true, T: true }, w: "both", upcaster: true, skew: 0 }, "rescuer")]
  let stuck = false
  for (let step = 0; step < MAX_DRAIN_STEPS; step++) {
    const open = [...store.rows.values()].filter((row) => !TERMINAL.has(row.status))
    if (open.length === 0) break
    for (const w of survivors) if (w.running === 0) startDispatch(w)
    await stepTo(time.now)
    const open2 = [...store.rows.values()].filter((row) => !TERMINAL.has(row.status))
    if (open2.length === 0) break
    // Timers fire in order inside advanceTo, so only job availability bounds the step.
    let next = time.now + scenario.leaseMs
    for (const row of open2) {
      const availability = row.status === "running" ? (row.leaseExpiresAt ?? time.now) + 1 : (row.nextAttemptAt ?? row.runAt) - Math.min(0, ...survivors.map((w) => w.skew))
      if (availability > time.now && availability < next) next = availability
    }
    await stepTo(Math.max(time.now + 1, next))
    if (step === MAX_DRAIN_STEPS - 1) stuck = true
  }
  if (stuck) {
    const open = [...store.rows.values()].filter((row) => !TERMINAL.has(row.status))
    complain(`drain did not terminate: ${open.map((row) => `${row.id}:${row.spec.type}:${row.status}:a${row.attempts}`).join(",")}`)
  }
  // Let in-flight dispatches finish so their results can be compared with the store log.
  for (let step = 0; step < 400 && pendingDispatch.size > 0; step++) {
    const timer = time.nextAt()
    await stepTo(timer === undefined ? time.now + scenario.leaseMs : Math.max(timer, time.now))
  }
  if (pendingDispatch.size > 0) complain(`${pendingDispatch.size} dispatch call(s) never returned after the drain`)
  checkRows()

  if (telemetryLines.some((line) => line.includes("tok-"))) complain("a claim token reached the telemetry sink")
  verifyLog({ scenario, store, windows, workers, starts, maxSkew, complain, time })

  const statuses: Record<string, string> = {}
  for (const row of store.rows.values()) statuses[row.id] = row.status
  return { violations, statuses, starts: starts.length, dispatches: windows.length, telemetryEvents: telemetryCalls, log: store.log }
}

// ---------------------------------------------------------------------------------------------------
// Oracle

type Transition = "succeeded" | "retrying" | "dead_letter" | "cancelled" | "release" | "none"
const UNRUNNABLE_MARKER = / \(unrunnable since (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\)$/

function resolveOnWorker(spec: WorkerSpec, job: JobSpec): "exact" | "upcast" | "upcast-missing" | "none" {
  if (job.type === "G") return "none"
  if (job.type !== "W") return spec.has[job.type] ? "exact" : "none"
  const v1 = spec.w === "v1" || spec.w === "both"
  const v2 = spec.w === "v2" || spec.w === "both"
  if (job.version === 1) return v1 ? "exact" : v2 ? (spec.upcaster ? "upcast" : "upcast-missing") : "none"
  return v2 ? "exact" : "none"
}

function behaviorOutcomes(behavior: Behavior, attempt: number, max: number, timeoutMs: number, graceMs: number, latencyMs: number): Set<Transition> {
  const failure = (kind: FailureClass): Transition => (kind === "cancelled" ? "cancelled" : kind === "permanent" ? "dead_letter" : attempt < max ? "retrying" : "dead_letter")
  const timeoutFailure = failure("retryable")
  // `finishesAt` is when the (non-cooperative) handler settles relative to its start.
  const timed = (finishesAt: number, natural: Transition): Set<Transition> => {
    if (finishesAt < timeoutMs) return new Set([natural])
    if (finishesAt === timeoutMs) return new Set([natural, timeoutFailure])
    const late = finishesAt - timeoutMs
    if (late < graceMs) return new Set([timeoutFailure])
    if (late === graceMs) return new Set([timeoutFailure, "none"])
    return new Set(["none"])
  }
  switch (behavior.k) {
    // A result that cannot be persisted as JSON is a permanent failure, never a success or a retry.
    case "ok": return timed(behavior.ms, behavior.data === undefined ? "succeeded" : "dead_letter")
    case "effect": {
      // The fenced effect renews the lease first, and a store round trip takes virtual time; its duration is therefore
      // only bounded, not exact, when the store has latency.
      const outcomes = timed(behavior.pre + behavior.post, "succeeded")
      if (latencyMs > 0) { outcomes.add("succeeded"); outcomes.add(timeoutFailure); outcomes.add("none") }
      return outcomes
    }
    case "fail": return timed(behavior.ms, failure(FAILURE_CLASS[behavior.err]))
    case "syncThrow": return new Set([failure(FAILURE_CLASS[behavior.err])])
    case "badResult": return new Set([timeoutFailure])
    case "coop": {
      if (behavior.cleanupMs < graceMs) return new Set([timeoutFailure])
      return behavior.cleanupMs === graceMs ? new Set([timeoutFailure, "none"]) : new Set(["none"])
    }
  }
}

interface OracleArgs {
  scenario: JobScenario
  store: JobStoreModel
  windows: Window[]
  workers: WorkerState[]
  starts: StartRecord[]
  maxSkew: number
  complain: (message: string) => void
  time: VirtualTime
}

function verifyLog(args: OracleArgs): void {
  const { scenario, store, windows, workers, complain } = args
  // The deferral marker is stamped before the store call, which may be delayed (latency, a failed release followed by the fallback).
  const tolerance = 2 * args.maxSkew + 4 * scenario.maxLatencyMs
  const workerById = new Map(workers.map((w) => [w.id, w]))
  const deferSince = new Map<string, number>()
  const modelStatus = new Map<string, { status: string; attempts: number }>()
  const burnedByFallback = new Set<string>()
  // A transient store error on release legitimately pushes a job onto the degraded markRetrying/dead-letter path.
  const faulted = workers.some((w) => w.faults > 0)

  for (const entry of store.log) {
    const row = store.rows.get(entry.jobId)!
    const spec = row.spec
    const model = modelStatus.get(entry.jobId) ?? { status: "pending", attempts: 0 }
    modelStatus.set(entry.jobId, model)
    if (!entry.applied) continue
    const label = `${entry.op} ${entry.jobId}`

    // Reference state machine: terminal states are sticky, attempts only move as the contract says.
    if (TERMINAL.has(model.status) && entry.op !== "enqueue") complain(`${label} applied to a job already ${model.status}`)
    switch (entry.op) {
      case "claim": model.attempts += 1; model.status = "running"; break
      case "release": model.attempts = Math.max(0, model.attempts - 1); model.status = "retrying"; break
      case "retry": model.status = "retrying"; break
      case "succeed": model.status = "succeeded"; break
      case "fail": model.status = entry.failStatus ?? "dead_letter"; break
      case "cancel": model.status = "cancelled"; break
      case "expire": model.status = "dead_letter"; break
      default: break
    }
    if (entry.attemptsAfter !== model.attempts) complain(`${label}: attempts ${entry.attemptsAfter} but the model expects ${model.attempts}`)

    if (entry.op === "claim") {
      continue
    }
    if (!["retry", "fail", "succeed", "release"].includes(entry.op)) continue

    // Every applied dispatcher transition must be one the scripted behaviour allows.
    const claim = store.claims.get(entry.token!)
    if (!claim || claim.jobId !== entry.jobId || claim.worker !== entry.worker) { complain(`${label}: fenced with a token that was not issued to that worker for that job`); continue }
    if (entry.op !== "release" && entry.attempt !== claim.attempt) complain(`${label}: attempt argument ${entry.attempt} differs from claimed attempt ${claim.attempt}`)
    const w = workerById.get(entry.worker!)
    if (!w) continue
    const kind: Transition = entry.op === "release" ? "release" : entry.op === "succeed" ? "succeeded" : entry.op === "retry" ? "retrying" : entry.failStatus === "cancelled" ? "cancelled" : "dead_letter"
    const marker = entry.error === null ? null : UNRUNNABLE_MARKER.exec(entry.error)
    const defShape = spec.type === "G" ? undefined : definitionShape(spec.type, scenario.leaseMs)
    const max = spec.maxAttempts ?? defShape?.maxAttempts
    const resolution = resolveOnWorker(w.spec, spec)
    const workerNow = entry.workerNow!
    const allowed = new Set<Transition>()
    let expectedRetryDelay: number | undefined

    const unrunnable = resolution === "none" || resolution === "upcast-missing"
    // A definition of the right type but a newer version still gets the scope, attempt and JSON checks before the
    // missing upcaster is noticed.
    const earlyReject = resolution === "upcast-missing" && defShape !== undefined && (defShape.scope !== spec.scope || (max !== undefined && claim.attempt > max) || spec.payload === "notJson" || spec.payload === "array")
    if (earlyReject) allowed.add("dead_letter")
    else if (unrunnable) {
      allowed.add("release"); allowed.add("dead_letter")
      if (!store.hasRelease || faulted) { allowed.add("retrying"); burnedByFallback.add(entry.jobId) }
      const text = entry.error ?? ""
      if (kind === "dead_letter" && !text.startsWith("UNKNOWN_JOB_DEFINITION") && !text.startsWith("Unknown job definition") && !text.startsWith("Missing job payload upcaster") && !text.startsWith("Job payload cannot be downcast")) complain(`${label}: unexpected dead-letter for an unrunnable job: ${entry.error}`)
    } else {
      const shape = defShape!
      const tp = scenario.timeoutPolicy
      const timeoutMs = tp?.timeoutMs ?? shape.timeoutMs ?? scenario.leaseMs
      const graceMs = Math.max(1, tp?.graceMs ?? scenario.leaseMs)
      if (shape.scope !== spec.scope) allowed.add("dead_letter")
      else if (max !== undefined && claim.attempt > max) allowed.add("dead_letter")
      else if (spec.payload !== "ok") allowed.add("dead_letter")
      else {
        const script = spec.script
        const behavior = script[Math.min(claim.attempt - 1, script.length - 1)] ?? { k: "ok" as const, ms: 0 }
        for (const outcome of behaviorOutcomes(behavior, claim.attempt, max!, timeoutMs, graceMs, scenario.maxLatencyMs)) allowed.add(outcome)
        if ((!store.hasRelease || faulted) && burnedByFallback.has(entry.jobId)) allowed.add("dead_letter")
        expectedRetryDelay = referenceBackoffMs(shape.delayMs, shape.mult, undefined, claim.attempt)
      }
    }
    if (!allowed.has(kind)) {
      complain(`${label} (${w.id}, attempt ${claim.attempt}/${max}, ${spec.type}@${spec.version}) applied ${kind} but the model allows {${[...allowed].join(",")}}; error=${entry.error}`)
      continue
    }
    if (kind === "retrying" && expectedRetryDelay !== undefined && !unrunnable) {
      const expected = Math.trunc(workerNow + expectedRetryDelay)
      if (entry.nextAttemptAt !== expected) complain(`${label}: nextAttemptAt is +${(entry.nextAttemptAt ?? 0) - workerNow}ms but backoff reference says +${expectedRetryDelay}ms`)
    }

    // Unknown-definition deferral window.
    if (kind === "release" || (marker && kind === "retrying")) {
      const modelSince = deferSince.get(entry.jobId) ?? workerNow
      const markerSince = marker ? Date.parse(marker[1]!) : Number.NaN
      if (!marker) complain(`${label}: deferral carries no unrunnable-since marker`)
      else {
        if (Math.abs(markerSince - modelSince) > tolerance) complain(`${label}: deferral window starts at ${markerSince - EPOCH} but first deferral was at ${modelSince - EPOCH}`)
        if (workerNow - markerSince > scenario.capMs + tolerance) complain(`${label}: deferred ${workerNow - markerSince}ms after the window opened, beyond the ${scenario.capMs}ms cap`)
      }
      if (!deferSince.has(entry.jobId)) deferSince.set(entry.jobId, marker ? Math.min(markerSince, workerNow) : workerNow)
      if (kind === "release" && entry.nextAttemptAt !== workerNow + scenario.leaseMs) complain(`${label}: release nextAttemptAt +${(entry.nextAttemptAt ?? 0) - workerNow} instead of +${scenario.leaseMs}`)
    } else {
      if (kind === "dead_letter" && (entry.error ?? "").startsWith("UNKNOWN_JOB_DEFINITION")) {
        const since = deferSince.get(entry.jobId)
        const quoted = /of (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/.exec(entry.error ?? "")
        if (since === undefined) complain(`${label}: dead-lettered as unknown without any earlier deferral`)
        else if (workerNow - since <= scenario.capMs - tolerance) complain(`${label}: dead-lettered ${workerNow - since}ms after first deferral, before the ${scenario.capMs}ms cap`)
        if (quoted && since !== undefined && Math.abs(Date.parse(quoted[1]!) - since) > tolerance) complain(`${label}: dead-letter quotes window start ${Date.parse(quoted[1]!) - EPOCH}, first deferral was ${since - EPOCH}`)
      } else if (kind === "dead_letter" && store.hasRelease && !faulted && (entry.error ?? "").startsWith("Unknown job definition") && unrunnable && !earlyReject) {
        complain(`${label}: unknown-definition job dead-lettered by the degraded path although the store supports release`)
      }
      deferSince.delete(entry.jobId)
    }
  }

  // In a calm run (no faults, crashes, clock jumps or slow store) a started handler must never lose its claim, so a handler
  // that is not expected to stall must end in exactly one applied transition, and may never overlap a later claim.
  const calm = scenario.faultPerMille === 0 && scenario.maxLatencyMs <= Math.floor(scenario.leaseMs / 20) && scenario.ops.every((op) => op.k !== "crash" && op.k !== "jump" && op.k !== "skew")
  if (calm) {
    const transitioned = new Map<string, StoreLogEntry>()
    for (const entry of store.log) if (entry.applied && entry.token !== null && ["succeed", "retry", "fail", "release"].includes(entry.op)) transitioned.set(entry.token, entry)
    const cancelledAt = new Map<string, number>()
    for (const entry of store.log) if (entry.op === "cancel" && entry.applied) cancelledAt.set(entry.jobId, entry.t)
    for (const start of args.starts) {
      const row = store.rows.get(start.jobId)!
      const w = workerById.get(start.worker)
      if (!w || w.skew !== 0) continue
      const spec = row.spec
      if (spec.type === "G" || resolveOnWorker(w.spec, spec) !== "exact" && resolveOnWorker(w.spec, spec) !== "upcast") continue
      const shape = definitionShape(spec.type, scenario.leaseMs)
      const tp = scenario.timeoutPolicy
      const behavior = spec.script[Math.min(start.attempt - 1, spec.script.length - 1)] ?? { k: "ok" as const, ms: 0 }
      const outcomes = behaviorOutcomes(behavior, start.attempt, spec.maxAttempts ?? shape.maxAttempts, tp?.timeoutMs ?? shape.timeoutMs ?? scenario.leaseMs, Math.max(1, tp?.graceMs ?? scenario.leaseMs), scenario.maxLatencyMs)
      if (outcomes.has("none")) continue
      const cancelled = cancelledAt.get(start.jobId)
      if (cancelled !== undefined && cancelled >= start.t) continue
      if (start.returnedSuccess) {
        const rerun = args.starts.find((later) => later.jobId === start.jobId && later.t > start.t)
        if (rerun) complain(`job ${start.jobId} ran again (attempt ${rerun.attempt}) after attempt ${start.attempt} returned success`)
      }
      if (!transitioned.has(start.token)) complain(`handler of ${start.jobId} attempt ${start.attempt} on ${start.worker} lost its claim although nothing disturbed it (expected ${[...outcomes].join("/")})`)
      for (const later of args.starts) {
        if (later.jobId === start.jobId && later.t > start.t && (start.finishedAt === undefined || start.finishedAt > later.t)) complain(`handler of ${start.jobId} attempt ${start.attempt} was still running when attempt ${later.attempt} started`)
      }
    }
  }

  // Dispatch results must agree with what the store applied during the call.
  for (const window of windows) {
    if (window.result === undefined || window.overlapped || window.faultsEnd !== window.faultsStart || window.to < 0) continue
    const worker = window.worker
    const mine = store.log.slice(window.from, window.to).filter((entry) => entry.worker === worker)
    // Another dispatch of this worker id could interleave only if it overlapped; those are skipped above.
    const claimed = mine.filter((entry) => entry.op === "claim").length
    const count = (predicate: (entry: StoreLogEntry) => boolean): number => mine.filter((entry) => entry.applied && predicate(entry)).length
    const result = window.result
    const label = `dispatch by ${worker}`
    if (result.claimed !== claimed) complain(`${label}: reported claimed=${result.claimed} but the store issued ${claimed} claims`)
    const succeeded = count((entry) => entry.op === "succeed")
    const retried = count((entry) => entry.op === "retry" || entry.op === "release")
    const dead = count((entry) => entry.op === "fail" && entry.failStatus === "dead_letter")
    const cancelled = count((entry) => entry.op === "fail" && entry.failStatus === "cancelled")
    if (result.succeeded !== succeeded) complain(`${label}: succeeded=${result.succeeded} vs applied ${succeeded}`)
    if (result.retried !== retried) complain(`${label}: retried=${result.retried} vs applied ${retried}`)
    if (result.deadLettered !== dead) complain(`${label}: deadLettered=${result.deadLettered} vs applied ${dead}`)
    if (result.failed !== cancelled) complain(`${label}: failed=${result.failed} vs applied cancellations ${cancelled}`)
    const errorsOf = (action: string): number => result.errors.filter((error) => error.action === action).length
    if (errorsOf("lease_lost") !== result.leaseLost) complain(`${label}: ${errorsOf("lease_lost")} lease_lost errors for leaseLost=${result.leaseLost}`)
    if (errorsOf("stalled") !== result.stalled) complain(`${label}: ${errorsOf("stalled")} stalled errors for stalled=${result.stalled}`)
    if (errorsOf("failed") !== result.failed) complain(`${label}: ${errorsOf("failed")} failed errors for failed=${result.failed}`)
    if (errorsOf("dead_letter") > result.deadLettered || errorsOf("retry") > result.retried) complain(`${label}: more error entries than outcomes`)
    for (const error of result.errors) if (!mine.some((entry) => entry.op === "claim" && entry.jobId === error.jobId)) complain(`${label}: error reported for job ${error.jobId} that this dispatch never claimed`)
    const sum = result.succeeded + result.retried + result.deadLettered + result.failed + result.leaseLost + result.stalled
    if (sum !== result.claimed) complain(`${label}: outcome counters sum to ${sum} for ${result.claimed} claimed jobs`)
  }

  // Liveness: after the drain, nothing is left behind.
  for (const row of store.rows.values()) {
    if (!TERMINAL.has(row.status)) complain(`${row.id} (${row.spec.type}) is ${row.status} after the drain`)
  }
}

