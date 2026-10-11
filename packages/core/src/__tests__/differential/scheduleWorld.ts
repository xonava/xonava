import type { JobExecutionScope, JobRequester, JobStatus, JobStore, NewJob, StoredJob, AdvanceScheduleArgs } from "../../execution/types"
import type { FencedAdvanceScheduleArgs, FencedReleaseScheduleArgs, FencedScheduleClaim, RenewScheduleLeaseArgs, ScheduleStore } from "../../execution/scheduleStore"
import type { ScheduleRenewalClock } from "../../execution/scheduleDispatcher"

/**
 * In-memory world for the schedule dispatcher model test: a fake clock, a
 * schedule store that mirrors the claim/fencing semantics of the SQL stores
 * (adapters/src/drizzle-pg/drizzleScheduleStore.ts), a job store with an
 * idempotency-key index, and one-shot fault injection. It records every store
 * interaction so the test can compare each claim's observable effects with the
 * reference model.
 */

export type ScheduleScopeKind = "tenant" | "platform" | "system"

export interface WorldSchedule {
  id: string
  scope: ScheduleScopeKind
  payload: string
  cron: string
  timezone: string
  overlap: "allow" | "skip" | "queue"
  misfire: "skip" | "fire_now" | "queue_all"
  enabled: boolean
  paused: boolean
  effectiveFrom: number | null
  effectiveUntil: number | null
  remaining: number | null
  calendarKey: string | null
  nextRunAt: number | null
  lastRunAt: number | null
  lastStatus: string | null
  lastError: string | null
  leaseOwner: string | null
  claimToken: string | null
  leaseExpiresAt: number | null
}

export interface WorldJob {
  key: string
  scheduleId: string
  runAt: number
  status: JobStatus
  order: number
  stored: StoredJob
}

export type StoreFault =
  | { kind: "enqueue_throws"; index: number; committed: boolean; style: "error" | "string" | "long" }
  | { kind: "advance_false" }
  | { kind: "advance_throws" }
  | { kind: "renew_false"; call: number }
  | { kind: "prior_throws" }

export const FAULT_TEXT = {
  error: "enqueue failed",
  string: "string failure",
  long: `${"\u{1F600}".repeat(300)}${"x".repeat(300)}`,
  advance: "schedule store unavailable",
  prior: "prior lookup failed",
} as const

export interface ClaimRecord {
  workerId: string
  claim: FencedScheduleClaim
  /** The schedule's jobs as they were when the claim was granted. */
  jobs: Array<{ key: string; runAt: number; status: JobStatus }>
}

export type WorldEvent =
  | { type: "renew"; scheduleId: string; token: string; ok: boolean }
  | { type: "enqueue"; scheduleId: string; key: string; runAt: number; requester: JobRequester; job: NewJob; outcome: "stored" | "threw_after_commit" | "threw" }
  | { type: "advance"; scheduleId: string; token: string; args: FencedAdvanceScheduleArgs; outcome: "applied" | "rejected" | "false_fault" | "threw" }

const NOT_USED = (): never => {
  throw new Error("job store method not used by the schedule dispatcher")
}

export class ScheduleWorld {
  now: number
  readonly schedules = new Map<string, WorldSchedule>()
  readonly jobs = new Map<string, WorldJob>()
  readonly claims: ClaimRecord[] = []
  readonly events: WorldEvent[] = []
  private readonly faults = new Map<string, StoreFault[]>()
  private tokens = 0
  private jobOrder = 0
  private readonly renewCalls = new Map<string, number>()
  private readonly enqueueCalls = new Map<string, number>()
  private readonly advanceCalls = new Map<string, number>()
  /** Highest nextRunAt ever stored per schedule since its last definition change (monotonicity check). */
  readonly floorNextRunAt = new Map<string, number>()
  violations: string[] = []

  constructor(now: number) {
    this.now = now
  }

  // ---- faults ------------------------------------------------------------

  armFault(scheduleId: string, fault: StoreFault): void {
    this.faults.set(scheduleId, [...(this.faults.get(scheduleId) ?? []), fault])
  }

  /** Faults live for one tick. */
  clearFaults(): void {
    this.faults.clear()
    this.renewCalls.clear()
    this.enqueueCalls.clear()
    this.advanceCalls.clear()
  }

  private fault<K extends StoreFault["kind"]>(scheduleId: string, kind: K): Extract<StoreFault, { kind: K }> | undefined {
    return this.faults.get(scheduleId)?.find((fault): fault is Extract<StoreFault, { kind: K }> => fault.kind === kind)
  }

  // ---- schedule store ----------------------------------------------------

  private claimable(row: WorldSchedule, now: number): boolean {
    if (!row.enabled || row.paused || row.nextRunAt === null || row.nextRunAt > now) return false
    if (row.effectiveFrom !== null && row.effectiveFrom > now) return false
    if (row.effectiveUntil !== null && row.effectiveUntil <= now) return false
    if (row.remaining !== null && row.remaining <= 0) return false
    // A failed schedule backs off: its lease expiry holds the earliest retry time.
    if (row.lastStatus === "failed" && row.leaseExpiresAt !== null && row.leaseExpiresAt > now) return false
    // A running schedule is claimable only once its lease has expired.
    if (row.lastStatus === "running" && !(row.leaseExpiresAt !== null && row.leaseExpiresAt < now)) return false
    return true
  }

  private holds(row: WorldSchedule | undefined, workerId: string, token: string): row is WorldSchedule {
    return row !== undefined && row.leaseOwner === workerId && row.claimToken === token && row.lastStatus === "running" && row.leaseExpiresAt !== null && row.leaseExpiresAt > this.now
  }

  readonly scheduleStore: ScheduleStore = {
    claimDueSchedules: async (args) => {
      const now = args.now?.getTime() ?? this.now
      const eligible = [...this.schedules.values()]
        .filter((row) => this.claimable(row, now))
        .sort((a, b) => a.nextRunAt! - b.nextRunAt! || (a.id < b.id ? -1 : 1))
        .slice(0, args.limit)
      const granted: FencedScheduleClaim[] = []
      for (const row of eligible) {
        const prior = row.lastStatus
        const claimToken = `token-${++this.tokens}`
        row.lastStatus = "running"
        row.leaseOwner = args.workerId
        row.claimToken = claimToken
        row.leaseExpiresAt = now + args.leaseDurationMs
        const claim = this.toClaim(row, prior, claimToken)
        granted.push(claim)
        this.claims.push({
          workerId: args.workerId,
          claim,
          jobs: [...this.jobs.values()].filter((job) => job.scheduleId === row.id).map((job) => ({ key: job.key, runAt: job.runAt, status: job.status })),
        })
      }
      return granted
    },
    advanceSchedule: async (args) => {
      const row = this.schedules.get(args.scheduleId)
      const call = (this.advanceCalls.get(args.scheduleId) ?? 0) + 1
      this.advanceCalls.set(args.scheduleId, call)
      const base = { type: "advance" as const, scheduleId: args.scheduleId, token: args.claimToken, args }
      if (this.fault(args.scheduleId, "advance_throws")) {
        this.events.push({ ...base, outcome: "threw" })
        throw new Error(FAULT_TEXT.advance)
      }
      if (call === 1 && this.fault(args.scheduleId, "advance_false")) {
        this.events.push({ ...base, outcome: "false_fault" })
        return false
      }
      if (!this.holds(row, args.workerId, args.claimToken)) {
        this.events.push({ ...base, outcome: "rejected" })
        return false
      }
      const previous = this.floorNextRunAt.get(row.id)
      if (args.nextRunAt !== null && previous !== undefined && args.nextRunAt.getTime() < previous) {
        this.violations.push(`schedule ${row.id}: nextRunAt moved backwards ${new Date(previous).toISOString()} -> ${args.nextRunAt.toISOString()}`)
      }
      if (args.nextRunAt !== null) this.floorNextRunAt.set(row.id, args.nextRunAt.getTime())
      const consumed = args.occurrencesFired ?? (args.lastStatus === "fired" ? 1 : 0)
      row.nextRunAt = args.nextRunAt === null ? null : args.nextRunAt.getTime()
      row.lastRunAt = args.lastRunAt.getTime()
      row.lastStatus = args.lastStatus
      row.lastError = args.lastError ?? null
      row.leaseOwner = null
      row.claimToken = null
      row.leaseExpiresAt = args.lastStatus === "failed" && args.retryAt ? args.retryAt.getTime() : null
      if (row.remaining !== null) row.remaining = Math.max(0, row.remaining - consumed)
      this.events.push({ ...base, outcome: "applied" })
      return true
    },
    releaseSchedule: async (args: FencedReleaseScheduleArgs) => {
      const row = this.schedules.get(args.scheduleId)
      if (!this.holds(row, args.workerId, args.claimToken)) return false
      row.lastStatus = "idle"
      row.leaseOwner = null
      row.claimToken = null
      row.leaseExpiresAt = null
      return true
    },
    renewScheduleLease: async (args: RenewScheduleLeaseArgs) => {
      const row = this.schedules.get(args.scheduleId)
      const callKey = `${args.scheduleId}:${args.claimToken}`
      const call = (this.renewCalls.get(callKey) ?? 0) + 1
      this.renewCalls.set(callKey, call)
      const injected = this.fault(args.scheduleId, "renew_false")
      const ok = !(injected && injected.call === call) && this.holds(row, args.workerId, args.claimToken) && args.extendByMs > 0
      if (ok) row!.leaseExpiresAt = Math.max(row!.leaseExpiresAt!, this.now + args.extendByMs)
      this.events.push({ type: "renew", scheduleId: args.scheduleId, token: args.claimToken, ok })
      return ok
    },
  }

  private toClaim(row: WorldSchedule, priorStatus: string | null, claimToken: string): FencedScheduleClaim {
    const executionScope: JobExecutionScope = row.scope === "tenant" ? { kind: "tenant", tenantId: `tenant-${row.id}` } : row.scope === "platform" ? { kind: "platform", platformKey: "default" } : { kind: "system", systemKey: "scheduler" }
    return {
      scheduleId: row.id,
      scope: row.scope,
      executionScope,
      jobType: `job.${row.id}`,
      jobVersion: 1,
      tenantId: row.scope === "tenant" ? `tenant-${row.id}` : null,
      payload: row.payload,
      cronExpression: row.cron,
      timezone: row.timezone,
      overlapPolicy: { type: row.overlap },
      misfirePolicy: { type: row.misfire },
      nextRunAt: new Date(row.nextRunAt!),
      lastRunAt: row.lastRunAt === null ? null : new Date(row.lastRunAt),
      lastStatus: priorStatus,
      lifecycle: {
        paused: row.paused,
        ...(row.effectiveFrom === null ? {} : { effectiveFrom: new Date(row.effectiveFrom).toISOString() }),
        ...(row.effectiveUntil === null ? {} : { effectiveUntil: new Date(row.effectiveUntil).toISOString() }),
        ...(row.remaining === null ? {} : { remainingOccurrences: row.remaining }),
        ...(row.calendarKey === null ? {} : { calendarExclusionKey: row.calendarKey }),
      },
      claimToken,
    }
  }

  // ---- job store ---------------------------------------------------------

  private scheduleIdOf(correlationId: string | undefined): string {
    return (correlationId ?? "").replace(/^sched:/, "")
  }

  readonly jobStore: JobStore = {
    enqueue: async ({ requester, job }) => {
      const scheduleId = this.scheduleIdOf(job.correlationId)
      const key = job.idempotencyKey!
      const index = this.enqueueCalls.get(scheduleId) ?? 0
      this.enqueueCalls.set(scheduleId, index + 1)
      if (this.jobs.has(key)) {
        this.violations.push(`duplicate enqueue call for idempotency key ${key}`)
        return this.jobs.get(key)!.stored
      }
      const injected = this.fault(scheduleId, "enqueue_throws")
      const base = { type: "enqueue" as const, scheduleId, key, runAt: job.runAt!.getTime(), requester, job }
      const thrown = (): never => {
        if (injected!.style === "string") throw FAULT_TEXT.string
        throw new Error(injected!.style === "long" ? FAULT_TEXT.long : FAULT_TEXT.error)
      }
      if (injected && injected.index === index && !injected.committed) {
        this.events.push({ ...base, outcome: "threw" })
        thrown()
      }
      const stored = this.store(key, scheduleId, job)
      if (injected && injected.index === index) {
        this.events.push({ ...base, outcome: "threw_after_commit" })
        thrown()
      }
      this.events.push({ ...base, outcome: "stored" })
      return stored
    },
    getByIdempotencyKey: async ({ key }) => this.jobs.get(key)?.stored ?? null,
    getLatestPriorScheduleExecution: async ({ scheduleId, beforeOccurrence }) => {
      if (this.fault(scheduleId, "prior_throws")) throw new Error(FAULT_TEXT.prior)
      let best: WorldJob | undefined
      for (const job of this.jobs.values()) {
        if (job.scheduleId !== scheduleId || job.runAt >= beforeOccurrence.getTime()) continue
        if (!best || job.runAt > best.runAt || (job.runAt === best.runAt && job.order > best.order)) best = job
      }
      return best ? { ...best.stored, status: best.status } : null
    },
    getById: NOT_USED,
    getByCorrelationId: NOT_USED,
    claimDue: NOT_USED,
    renewLease: NOT_USED,
    markSucceeded: NOT_USED,
    markRetrying: NOT_USED,
    markFailed: NOT_USED,
    cancel: NOT_USED,
    findPending: NOT_USED,
  }

  private store(key: string, scheduleId: string, job: NewJob): StoredJob {
    const order = ++this.jobOrder
    const runAt = job.runAt!
    const stored = {
      id: `job-${order}`, jobType: job.jobType, jobVersion: job.jobVersion, tenantId: null, executionScope: job.executionScope, scope: job.executionScope.kind,
      payload: JSON.stringify(job.payload), status: "pending", priority: 0, attemptsCompleted: 0, currentAttempt: 0, runAt, nextAttemptAt: null,
      leaseOwner: null, leaseExpiresAt: null, claimToken: null, idempotencyKey: key, fingerprint: "fp", correlationId: job.correlationId ?? null,
      lastError: null, resultPayload: null, metadata: null, partitionKey: job.partitionKey ?? null, createdAt: new Date(this.now), startedAt: null, completedAt: null,
    } as StoredJob
    this.jobs.set(key, { key, scheduleId, runAt: runAt.getTime(), status: "pending", order, stored })
    return stored
  }

  setJobStatus(key: string, status: JobStatus): void {
    const job = this.jobs.get(key)
    if (job) job.status = status
  }

  // ---- renewal clock -----------------------------------------------------

  /** Lease-renewal timers never fire on their own: the tick runs inside a frozen instant. */
  readonly renewalClock: ScheduleRenewalClock = {
    now: () => new Date(this.now),
    setTimeout: () => ({}),
    clearTimeout: () => undefined,
  }

  // ---- schedule definition changes ---------------------------------------

  put(schedule: WorldSchedule): void {
    this.schedules.set(schedule.id, schedule)
    this.floorNextRunAt.delete(schedule.id)
  }

  /** A definition change legitimately re-bases next-run monotonicity. */
  rebase(scheduleId: string): void {
    this.floorNextRunAt.delete(scheduleId)
  }

  remove(scheduleId: string): void {
    this.schedules.delete(scheduleId)
    this.floorNextRunAt.delete(scheduleId)
  }

  jobsOf(scheduleId: string): WorldJob[] {
    return [...this.jobs.values()].filter((job) => job.scheduleId === scheduleId).sort((a, b) => a.order - b.order)
  }
}

export type { AdvanceScheduleArgs }
