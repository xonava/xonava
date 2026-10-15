import type { JobExecutionScope, JobRequester } from "@xonava/core/execution"
import type { Rng } from "../../../core/src/__tests__/differential/harness.js"

/**
 * Reference JobStore for the real-database differential.
 *
 * The reference is written from the JobStore contract (packages/core/src/execution/types.ts, docs/spec/execution.md) and
 * the documented partition rule ("at most one job per non-null partition runs at a time", per scope and tenant), not from
 * any SQL adapter. Time handling:
 *
 *  - Due-ness of pending/retrying jobs is driven by the `now` argument of claimDue, so it uses a virtual clock (`vnow`).
 *  - Lease liveness is decided by the DATABASE clock in every adapter. The reference therefore never lets a lease lapse
 *    on its own: claims use one-hour leases and a lease only "expires" through an explicit `expire` op, which the driver
 *    realises by rewriting lease_expires_at one hour into the database's past. No real waiting is involved.
 */

export const T0 = Date.UTC(2030, 5, 1)
export const HOUR = 3_600_000

export type ReqName = "sys" | "plat" | "platCap" | "t1" | "t2"
export type ViewReq = "sys" | "plat" | "t1" | "t2"
export type ScopeName = "system" | "platform" | "t1" | "t2"
export type FailStatus = "failed" | "dead_letter" | "cancelled"
export type JobStatusName = "pending" | "running" | "succeeded" | "retrying" | "failed" | "dead_letter" | "cancelled"

export function requesterOf(name: ReqName): JobRequester {
  switch (name) {
    case "sys": return { scope: "system" }
    case "plat": return { scope: "platform", actorId: "actor" }
    case "platCap": return { scope: "platform", actorId: "actor", capabilities: ["enqueue:system"] }
    case "t1": return { scope: "tenant", tenantId: "t1", actorId: "actor" }
    case "t2": return { scope: "tenant", tenantId: "t2", actorId: "actor" }
  }
}

export function executionScopeOf(scope: ScopeName): JobExecutionScope {
  switch (scope) {
    case "system": return { kind: "system", systemKey: "framework" }
    case "platform": return { kind: "platform", platformKey: "default" }
    case "t1": return { kind: "tenant", tenantId: "t1" }
    case "t2": return { kind: "tenant", tenantId: "t2" }
  }
}

function scopeParts(scope: ScopeName): { scope: "system" | "platform" | "tenant"; tenantId: string | null } {
  switch (scope) {
    case "system": return { scope: "system", tenantId: null }
    case "platform": return { scope: "platform", tenantId: null }
    case "t1": return { scope: "tenant", tenantId: "t1" }
    case "t2": return { scope: "tenant", tenantId: "t2" }
  }
}

export interface EnqueueSpec {
  req: ReqName
  scope: ScopeName
  jobType: string
  version: number
  payload: Record<string, unknown>
  runAt: number
  maxAttempts?: number
  idem?: string
  corr?: string
  priority: number
  partition?: string
  metadata?: Record<string, unknown>
}

export type TokenChoice = "cur" | "stale" | "bogus"
export type AttemptChoice = "cur" | "minus" | "plus"
export type WhoChoice = "holder" | "other"
export interface Fence { job: number; who: WhoChoice; tok: TokenChoice; att: AttemptChoice }

export type Op =
  | { k: "enqueue"; spec: EnqueueSpec }
  | { k: "claim"; w: number; view: ViewReq; limit: number }
  | { k: "renew"; fence: Fence; extendMs: number }
  | { k: "succeed"; fence: Fence; result?: Record<string, unknown> | undefined }
  | { k: "retry"; fence: Fence; error: string; delta: number }
  | { k: "fail"; fence: Fence; error: string; status: FailStatus }
  | { k: "release"; fence: Fence; reason: string; delta: number }
  | { k: "cancel"; job: number; view: ViewReq; reason?: string }
  | { k: "expire"; job: number }
  | { k: "advance"; ms: number }
  | { k: "getById"; job: number; view: ViewReq }
  | { k: "getByIdem"; key: string; view: ViewReq }
  | { k: "getByCorr"; corr: string; view: ViewReq }
  | { k: "prior"; schedule: string; before: number; view: ViewReq }
  | { k: "pending"; view: ViewReq; jobType?: string; limit?: number }

export const WORKERS = ["w1", "w2", "w3"] as const
export const BOGUS_TOKEN = "bogus-token"

function canon(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canon(record[key])}`).join(",")}}`
}

export function canonicalJson(value: unknown): string { return canon(value) }

export function specFingerprint(spec: EnqueueSpec): string {
  return canon({
    scope: spec.scope, jobType: spec.jobType, version: spec.version, payload: spec.payload, runAt: spec.runAt,
    maxAttempts: spec.maxAttempts ?? null, priority: spec.priority, corr: spec.corr ?? null, partition: spec.partition ?? null, metadata: spec.metadata ?? null,
  })
}

/** Requester x target-scope enqueue matrix of the contract (assertRequesterCanEnqueueScope). */
function requesterMayEnqueue(req: ReqName, scope: ScopeName): boolean {
  switch (req) {
    case "sys": return true
    case "platCap": return true
    case "plat": return scope === "platform"
    case "t1": return scope === "t1"
    case "t2": return scope === "t2"
  }
}

export function viewMatches(view: ViewReq, job: { scope: string; tenantId: string | null }): boolean {
  switch (view) {
    case "sys": return job.scope === "system"
    case "plat": return job.scope === "platform"
    case "t1": return job.scope === "tenant" && job.tenantId === "t1"
    case "t2": return job.scope === "tenant" && job.tenantId === "t2"
  }
}

function idemScopeOfView(view: ViewReq): string {
  return view === "t1" || view === "t2" ? `tenant:${view}` : view === "sys" ? "system" : "platform"
}

export interface RefJob {
  slot: number
  spec: EnqueueSpec
  scope: "system" | "platform" | "tenant"
  tenantId: string | null
  idemScope: string
  status: JobStatusName
  attempts: number
  /** Stored budget; Infinity when the job relies on its definition. */
  storedMax: number
  nextAttemptAt: number | null
  leaseOwner: string | null
  token: string | null
  leaseLive: boolean
  lastError: string | null
  result: Record<string, unknown> | null
  startedAt: number | null
  completed: boolean
  tokenHistory: string[]
  lastOwner: string | null
}

export type EnqueueOutcome = { kind: "ok"; slot: number; created: boolean } | { kind: "err"; name: string }
export interface TransitionOutcome { applied: boolean; reason?: "LEASE_LOST" | "INVALID_STATE" }

const TERMINAL: ReadonlySet<string> = new Set(["succeeded", "failed", "dead_letter", "cancelled"])

export interface RefConfig {
  /** lastError written when a claim sweep dead-letters an expired final attempt (the text is adapter specific). */
  expiredFinalAttemptError: string
  /**
   * A partition's lease-lapsed running job outranks queued siblings as the partition head. The MySQL schema's
   * unique index counts every status='running' row, so a lapsed job must be reclaimed before any sibling can run.
   */
  zombieFirst?: boolean
}

export class RefStore {
  readonly jobs: RefJob[] = []
  vnow = T0 + 3_000
  private tokenSeq = 0

  /** Observability hook for coverage accounting (not part of the contract). */
  onEvent: ((name: string) => void) | undefined

  constructor(readonly config: RefConfig) {}

  private groupKey(job: RefJob): string | null {
    return job.spec.partition === undefined ? null : `${job.spec.partition}|${job.scope}|${job.tenantId ?? ""}`
  }

  enqueue(spec: EnqueueSpec): EnqueueOutcome {
    if (!requesterMayEnqueue(spec.req, spec.scope)) return { kind: "err", name: "TenantScopeViolationError" }
    const parts = scopeParts(spec.scope)
    const idemScope = parts.tenantId ? `tenant:${parts.tenantId}` : parts.scope
    if (spec.idem !== undefined) {
      const existing = this.jobs.find((job) => job.idemScope === idemScope && job.spec.idem === spec.idem)
      if (existing) {
        return specFingerprint(existing.spec) === specFingerprint(spec)
          ? { kind: "ok", slot: existing.slot, created: false }
          : { kind: "err", name: "JobIdempotencyConflictError" }
      }
    }
    const job: RefJob = {
      slot: this.jobs.length, spec, scope: parts.scope, tenantId: parts.tenantId, idemScope, status: "pending", attempts: 0,
      storedMax: spec.maxAttempts ?? Number.POSITIVE_INFINITY, nextAttemptAt: spec.runAt, leaseOwner: null, token: null, leaseLive: false,
      lastError: null, result: null, startedAt: null, completed: false, tokenHistory: [], lastOwner: null,
    }
    this.jobs.push(job)
    return { kind: "ok", slot: job.slot, created: true }
  }

  private visible(view: ViewReq): RefJob[] { return this.jobs.filter((job) => viewMatches(view, job)) }

  private clearLease(job: RefJob): void { job.leaseOwner = null; job.token = null; job.leaseLive = false }

  private order(left: RefJob, right: RefJob): number {
    return left.spec.priority - right.spec.priority || left.spec.runAt - right.spec.runAt || left.slot - right.slot
  }

  private headOrder(left: RefJob, right: RefJob): number {
    if (this.config.zombieFirst) {
      const rank = (job: RefJob): number => (job.status === "running" ? 0 : 1)
      if (rank(left) !== rank(right)) return rank(left) - rank(right)
    }
    return this.order(left, right)
  }

  private isDue(job: RefJob, vnow: number): boolean {
    if ((job.status === "pending" || job.status === "retrying") && job.attempts < job.storedMax) return job.nextAttemptAt !== null && job.nextAttemptAt <= vnow
    return job.status === "running" && job.attempts < job.storedMax && !job.leaseLive
  }

  /** Dead-letters running jobs whose lease expired on the final attempt (only within the requester's scope). */
  sweep(view: ViewReq): void {
    for (const job of this.visible(view)) {
      if (job.status === "running" && !job.leaseLive && job.attempts >= job.storedMax) {
        job.status = "dead_letter"; job.lastError = this.config.expiredFinalAttemptError; this.clearLease(job); job.completed = true
        this.onEvent?.("sweep:dead_letter")
      }
    }
  }

  /** Jobs a claim may take now, best first: due, partition not busy, and the head of their partition. */
  claimable(view: ViewReq, vnow: number): RefJob[] {
    const due = this.visible(view).filter((job) => this.isDue(job, vnow))
    const out: RefJob[] = []
    for (const job of due) {
      const key = this.groupKey(job)
      if (key !== null) {
        const busy = this.jobs.some((other) => other !== job && this.groupKey(other) === key && other.status === "running" && other.leaseLive)
        if (busy) { this.onEvent?.("partition:busy"); continue }
        if (due.some((other) => other !== job && this.groupKey(other) === key && this.headOrder(other, job) < 0)) { this.onEvent?.("partition:behind-head"); continue }
      }
      out.push(job)
    }
    return out.sort((a, b) => this.order(a, b))
  }

  claim(view: ViewReq, worker: string, limit: number, vnow: number, sweep = true): number[] {
    if (sweep) this.sweep(view)
    const chosen = this.claimable(view, vnow).slice(0, Math.max(0, limit))
    for (const job of chosen) this.applyClaim(job, worker, vnow)
    return chosen.map((job) => job.slot)
  }

  /**
   * Claims exactly `slots` if that is a legal outcome of claim(): at most `limit` jobs, each currently claimable (due, its
   * partition free, and the head of its partition). A claim that raced with other operations may deliver fewer jobs
   * than were claimable; it may never deliver one that was not claimable. Returns false when the outcome is illegal.
   */
  claimSubset(view: ViewReq, worker: string, limit: number, vnow: number, slots: readonly number[], sweep = true): boolean {
    if (sweep) this.sweep(view)
    const heads = new Set(this.claimable(view, vnow).map((job) => job.slot))
    if (slots.length > Math.max(0, limit) || slots.some((slot) => !heads.has(slot))) return false
    for (const slot of slots) this.applyClaim(this.jobs[slot]!, worker, vnow)
    return true
  }

  applyClaim(job: RefJob, worker: string, vnow: number): void {
    if (job.status === "running") this.onEvent?.("claim:reclaimed-expired-lease")
    else if (job.attempts > 0) this.onEvent?.("claim:after-retry")
    job.status = "running"; job.leaseOwner = worker; job.token = `tok-${++this.tokenSeq}`; job.leaseLive = true
    job.attempts += 1; job.startedAt = vnow; job.nextAttemptAt = null; job.tokenHistory.push(job.token); job.lastOwner = worker
  }

  private fenced(job: RefJob | undefined, worker: string, token: string): job is RefJob {
    return job !== undefined && job.status === "running" && job.leaseLive && job.leaseOwner === worker && job.token === token
  }

  renew(slot: number | undefined, worker: string, token: string, extendMs: number): boolean {
    if (!Number.isFinite(extendMs) || extendMs <= 0) return false
    const job = slot === undefined ? undefined : this.jobs[slot]
    return this.fenced(job, worker, token)
  }

  succeed(slot: number | undefined, worker: string, token: string, attempt: number, result: Record<string, unknown> | undefined): TransitionOutcome {
    const job = slot === undefined ? undefined : this.jobs[slot]
    if (!this.fenced(job, worker, token) || job.attempts !== attempt) return { applied: false, reason: "LEASE_LOST" }
    job.status = "succeeded"; job.result = result ? result : null; this.clearLease(job); job.completed = true
    return { applied: true }
  }

  retry(slot: number | undefined, worker: string, token: string, attempt: number, nextAttemptAt: number, error: string): TransitionOutcome {
    const job = slot === undefined ? undefined : this.jobs[slot]
    if (!this.fenced(job, worker, token) || job.attempts !== attempt || job.attempts >= job.storedMax) return { applied: false, reason: "LEASE_LOST" }
    job.status = "retrying"; job.nextAttemptAt = nextAttemptAt; job.lastError = error; this.clearLease(job)
    return { applied: true }
  }

  fail(slot: number | undefined, worker: string, token: string, attempt: number, status: FailStatus, error: string): TransitionOutcome {
    const job = slot === undefined ? undefined : this.jobs[slot]
    if (!this.fenced(job, worker, token) || job.attempts !== attempt) return { applied: false, reason: "LEASE_LOST" }
    job.status = status; job.lastError = error; this.clearLease(job); job.completed = true
    return { applied: true }
  }

  release(slot: number | undefined, worker: string, token: string, nextAttemptAt: number, reason: string): TransitionOutcome {
    const job = slot === undefined ? undefined : this.jobs[slot]
    if (!this.fenced(job, worker, token)) return { applied: false, reason: "LEASE_LOST" }
    job.status = "retrying"; job.attempts = Math.max(0, job.attempts - 1); job.nextAttemptAt = nextAttemptAt
    job.lastError = reason.slice(0, 512); this.clearLease(job)
    return { applied: true }
  }

  cancel(slot: number | undefined, view: ViewReq, reason: string | undefined): TransitionOutcome {
    const job = slot === undefined ? undefined : this.jobs[slot]
    if (!job || !viewMatches(view, job) || TERMINAL.has(job.status)) return { applied: false, reason: "INVALID_STATE" }
    job.status = "cancelled"; job.lastError = reason ?? null; this.clearLease(job); job.completed = true
    return { applied: true }
  }

  expire(slot: number | undefined): void {
    const job = slot === undefined ? undefined : this.jobs[slot]
    if (job && job.status === "running") job.leaseLive = false
  }

  byId(slot: number | undefined, view: ViewReq): RefJob | null {
    const job = slot === undefined ? undefined : this.jobs[slot]
    return job && viewMatches(view, job) ? job : null
  }

  byIdempotencyKey(key: string, view: ViewReq): RefJob | null {
    const scope = idemScopeOfView(view)
    return this.visible(view).find((job) => job.idemScope === scope && job.spec.idem === key) ?? null
  }

  byCorrelation(corr: string, view: ViewReq): RefJob[] {
    return this.visible(view).filter((job) => job.spec.corr === corr).sort((a, b) => b.slot - a.slot).slice(0, 5)
  }

  latestPrior(schedule: string, before: number, view: ViewReq): RefJob | null {
    const matches = this.visible(view).filter((job) => job.spec.corr === `sched:${schedule}` && job.spec.runAt < before)
    return matches.sort((a, b) => b.spec.runAt - a.spec.runAt)[0] ?? null
  }

  pending(view: ViewReq, jobType: string | undefined, limit: number | undefined): RefJob[] {
    return this.visible(view)
      .filter((job) => (job.status === "pending" || job.status === "retrying") && (jobType === undefined || job.spec.jobType === jobType))
      .sort((a, b) => a.spec.priority - b.spec.priority || a.slot - b.slot)
      .slice(0, limit ?? 100)
  }

  /** Resolves a fence description to concrete store arguments from the reference's own view of the job. */
  resolve(fence: Fence): { slot: number | undefined; worker: string; token: string; attempt: number } {
    const job = this.jobs.length === 0 ? undefined : this.jobs[fence.job % this.jobs.length]
    if (!job) return { slot: undefined, worker: "w1", token: BOGUS_TOKEN, attempt: 1 }
    const holder = job.leaseOwner ?? job.lastOwner ?? "w1"
    const worker = fence.who === "holder" ? holder : WORKERS.find((candidate) => candidate !== holder)!
    const history = job.tokenHistory
    const current = job.token ?? history[history.length - 1]
    const stale = [...history].reverse().find((token) => token !== job.token)
    const token = fence.tok === "cur" ? (current ?? BOGUS_TOKEN) : fence.tok === "stale" ? (stale ?? BOGUS_TOKEN) : BOGUS_TOKEN
    const attempt = fence.att === "cur" ? job.attempts : fence.att === "minus" ? job.attempts - 1 : job.attempts + 1
    return { slot: job.slot, worker, token, attempt }
  }

  /** Independent copy (state only), used to explore alternative serial orders of concurrent operations. */
  clone(): RefStore {
    const copy = new RefStore(this.config)
    copy.vnow = this.vnow
    copy.tokenSeq = this.tokenSeq
    for (const job of this.jobs) copy.jobs.push(structuredClone(job))
    return copy
  }

  slotOf(index: number): number | undefined { return this.jobs.length === 0 ? undefined : index % this.jobs.length }
}

// ---------------------------------------------------------------------------------------------------------------
// Generators

const VIEWS: readonly ViewReq[] = ["sys", "sys", "plat", "t1", "t1", "t2"]
const SCOPES: readonly ScopeName[] = ["system", "system", "system", "system", "system", "platform", "t1", "t1", "t2"]
const IDEM_KEYS = ["k1", "k2", "k3", "k4"] as const
const CORRS = ["c1", "c2", "sched:s1", "sched:s1", "sched:s2"] as const
const PARTITIONS = ["p1", "p1", "p2"] as const
const ERRORS = ["boom", "", "x".repeat(700), "é€😀 unicode", "line1\nline2 \"quoted\" \\ back", "retry later"] as const
const RESULTS: readonly (Record<string, unknown> | undefined)[] = [undefined, {}, { a: 1, b: { c: [1, 2, 3] } }, { u: "é😀", n: null, t: true }]

function genPayload(rng: Rng): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  const keys = rng.int(4)
  for (let index = 0; index < keys; index++) payload[rng.pick(["a", "b", "key with space", "ünï", "z"])] = rng.pick([1, "s", "é😀", true, null, [1, "x"], { n: 2 }])
  return payload
}

export function generateEnqueueSpec(rng: Rng, ordinal: number, dense = false): EnqueueSpec {
  const scope = dense && rng.bool(0.7) ? "system" : rng.pick(SCOPES)
  const own: ReqName = scope === "t2" ? "t2" : "t1"
  const req: ReqName = rng.bool(0.8)
    ? (scope === "system" ? "sys" : scope === "platform" ? rng.pick(["sys", "plat", "platCap"] as const) : rng.pick(["sys", own, own] as const))
    : rng.pick(["sys", "plat", "platCap", "t1", "t2"] as const)
  const spec: EnqueueSpec = {
    req, scope, jobType: rng.pick(["ta", "ta", "tb"]), version: rng.pick([1, 1, 2]), payload: genPayload(rng),
    // Unique per ordinal so claim and listing orders never depend on tie-breaking the contract does not define.
    runAt: T0 + rng.int(dense ? 4 : 6) * 1000 + ordinal,
    priority: rng.pick([0, 0, 1, 2, -1]),
  }
  if (rng.bool(0.6)) spec.maxAttempts = 1 + rng.int(3)
  if (rng.bool(0.35)) spec.idem = rng.pick(IDEM_KEYS)
  if (rng.bool(0.45)) spec.corr = rng.pick(CORRS)
  if (rng.bool(0.4)) spec.partition = rng.pick(PARTITIONS)
  if (rng.bool(0.2)) spec.metadata = { m: rng.pick([1, "x", { deep: [1] }]) }
  return spec
}

function mutateSpec(rng: Rng, spec: EnqueueSpec): EnqueueSpec {
  switch (rng.int(7)) {
    case 0: return { ...spec, payload: { ...spec.payload, extra: 1 } }
    case 1: return { ...spec, priority: spec.priority + 1 }
    case 2: return { ...spec, runAt: spec.runAt + 1_000_000 }
    case 3: return { ...spec, maxAttempts: (spec.maxAttempts ?? 0) + 1 }
    case 4: return { ...spec, jobType: `${spec.jobType}x` }
    case 5: { const { partition: _unused, ...rest } = spec; return spec.partition === undefined ? { ...spec, partition: "p1" } : rest }
    default: return { ...spec, version: spec.version + 1 }
  }
}

function viewOfScope(scope: ScopeName): ViewReq { return scope === "system" ? "sys" : scope === "platform" ? "plat" : scope }

/** Applies an op to the reference only (used by the generator to aim later ops at live jobs). */
function advanceReference(ref: RefStore, op: Op): void {
  switch (op.k) {
    case "enqueue": ref.enqueue(op.spec); break
    case "claim": ref.claim(op.view, `w${op.w + 1}`, op.limit, ref.vnow); break
    case "renew": { const r = ref.resolve(op.fence); ref.renew(r.slot, r.worker, r.token, op.extendMs); break }
    case "succeed": { const r = ref.resolve(op.fence); ref.succeed(r.slot, r.worker, r.token, r.attempt, op.result); break }
    case "retry": { const r = ref.resolve(op.fence); ref.retry(r.slot, r.worker, r.token, r.attempt, ref.vnow + op.delta, op.error); break }
    case "fail": { const r = ref.resolve(op.fence); ref.fail(r.slot, r.worker, r.token, r.attempt, op.status, op.error); break }
    case "release": { const r = ref.resolve(op.fence); ref.release(r.slot, r.worker, r.token, ref.vnow + op.delta, op.reason); break }
    case "cancel": ref.cancel(ref.slotOf(op.job), op.view, op.reason); break
    case "expire": ref.expire(ref.slotOf(op.job)); break
    case "advance": ref.vnow += op.ms; break
    default: break
  }
}

export function generateOps(rng: Rng, size: { min: number; max: number; dense?: boolean } = { min: 24, max: 71 }): Op[] {
  const length = size.min + rng.int(size.max - size.min + 1)
  const ops: Op[] = []
  const specs: EnqueueSpec[] = []
  const ref = new RefStore({ expiredFinalAttemptError: "expired" })
  let ordinal = 0
  const aimedJob = (status: JobStatusName | null): number => {
    const pool = ref.jobs.filter((job) => status === null || job.status === status)
    return pool.length > 0 && rng.bool(0.85) ? rng.pick(pool).slot : rng.int(8)
  }
  const fence = (status: JobStatusName | null): Fence => ({
    job: aimedJob(status),
    who: rng.bool(0.85) ? "holder" : "other",
    tok: rng.pick(["cur", "cur", "cur", "cur", "cur", "stale", "bogus"] as const),
    att: rng.pick(["cur", "cur", "cur", "cur", "cur", "minus", "plus"] as const),
  })
  const viewFor = (live = false): ViewReq => {
    const pool = live ? ref.jobs.filter((job) => job.status === "pending" || job.status === "retrying" || job.status === "running") : ref.jobs
    return pool.length > 0 && rng.bool(0.9) ? viewOfScope(rng.pick(pool).spec.scope) : rng.pick(VIEWS)
  }
  const viewOfJob = (index: number): ViewReq => (ref.jobs.length > 0 && rng.bool(0.9) ? viewOfScope(ref.jobs[index % ref.jobs.length]!.spec.scope) : rng.pick(VIEWS))
  for (let index = 0; index < length; index++) {
    // Front-load enqueues so later operations have jobs in every state to act on.
    const roll = size.dense
      ? (index < 3 ? 0 : rng.bool(0.06) ? 0 : rng.bool(0.36) ? 20 + rng.int(22) : 42 + rng.int(47))
      : index < length / 4 ? (rng.bool(0.6) ? 0 : 20 + rng.int(80)) : rng.bool(0.1) ? 0 : 20 + rng.int(80)
    let op: Op
    if (roll < 20 || ops.length < 2) {
      if (specs.length > 0 && rng.bool(0.25)) {
        const original = rng.pick(specs)
        op = { k: "enqueue", spec: rng.bool(0.6) ? original : mutateSpec(rng, original) }
      } else {
        const spec = generateEnqueueSpec(rng, ordinal++, size.dense === true)
        if (spec.idem !== undefined) specs.push(spec)
        op = { k: "enqueue", spec }
      }
    } else if (roll < 42) op = { k: "claim", w: rng.int(3), view: viewFor(true), limit: rng.pick([1, 1, 2, 3, 5]) }
    else if (roll < 51) op = { k: "succeed", fence: fence("running"), result: rng.pick(RESULTS) }
    else if (roll < 60) op = { k: "retry", fence: fence("running"), error: rng.pick(ERRORS), delta: rng.pick([-1000, 0, 0, 1000, 2500, 6000]) }
    else if (roll < 66) op = { k: "fail", fence: fence("running"), error: rng.pick(ERRORS), status: rng.pick(["failed", "failed", "dead_letter", "cancelled"] as const) }
    else if (roll < 72) op = { k: "release", fence: fence("running"), reason: rng.pick(ERRORS), delta: rng.pick([-1000, 0, 1000, 5000]) }
    else if (roll < 75) op = { k: "renew", fence: fence("running"), extendMs: rng.pick([HOUR, 2 * HOUR, 1_000, 60_000, 0, -5, Number.NaN]) }
    else if (roll < 80) {
      const job = aimedJob(rng.pick(["running", "pending", "retrying", "failed", "failed", "dead_letter", "succeeded", null] as const))
      op = { k: "cancel", job, view: viewOfJob(job), ...(rng.bool(0.6) ? { reason: rng.pick(ERRORS) } : {}) }
    }
    else if (roll < 87) op = { k: "expire", job: aimedJob("running") }
    else if (roll < 91) op = { k: "advance", ms: rng.pick([500, 1000, 2500, 5000]) }
    else if (roll < 93) op = { k: "getById", job: rng.int(8), view: viewFor() }
    else if (roll < 95) op = { k: "getByIdem", key: rng.pick(IDEM_KEYS), view: viewFor() }
    else if (roll < 97) op = { k: "getByCorr", corr: rng.pick(CORRS), view: viewFor() }
    else if (roll < 98) op = { k: "prior", schedule: rng.pick(["s1", "s2"]), before: T0 + rng.int(10) * 1000 + 500, view: viewFor() }
    else op = { k: "pending", view: viewFor(), ...(rng.bool(0.3) ? { jobType: rng.pick(["ta", "tb"]) } : {}), ...(rng.bool(0.4) ? { limit: 1 + rng.int(3) } : {}) }
    ops.push(op)
    advanceReference(ref, op)
  }
  return ops
}

export function* shrinkOps(ops: Op[]): Generator<Op[]> {
  if (ops.length > 2) {
    yield ops.slice(0, Math.ceil(ops.length / 2))
    yield ops.slice(Math.floor(ops.length / 2))
  }
  for (let size = Math.min(8, ops.length - 1); size >= 1; size = Math.floor(size / 2)) {
    for (let start = 0; start + size <= ops.length; start += size) yield [...ops.slice(0, start), ...ops.slice(start + size)]
    if (size === 1) break
  }
}

export function describeOps(ops: Op[]): string {
  return ops.map((op, index) => `${index}: ${JSON.stringify(op, (_key, value: unknown) => (typeof value === "number" && Number.isNaN(value) ? "NaN" : value))}`).join("\n")
}
