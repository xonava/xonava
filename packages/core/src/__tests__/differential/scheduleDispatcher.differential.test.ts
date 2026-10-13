import { describe, expect, it, vi } from "vitest"
import { forAllAsync, scaledRuns, type Rng } from "./harness"
import { generateDenseCronExpression, generateInstant, generateZone } from "./scheduleArbitraries"
import { oracleNext, oracleOccurrences, parseOracleCron, type OracleCron } from "./scheduleOracle"
import { FAULT_TEXT, ScheduleWorld, type ClaimRecord, type ScheduleScopeKind, type StoreFault, type WorldEvent, type WorldSchedule } from "./scheduleWorld"
import { DEFAULT_SCHEDULE_FAILURE_BACKOFF, materializeDueSchedules, type MaterializeResult } from "../../execution/scheduleDispatcher"
import type { JobRequester, JobStatus } from "../../execution/types"

/**
 * Model-based test for materializeDueSchedules. A fake schedule store (claim
 * and fencing semantics of the SQL stores), a fake job store with an
 * idempotency index, a frozen clock and fault injection drive random operation
 * sequences; for every claim a straight-line reference model (built on the
 * brute-force cron oracle) predicts the jobs that must be enqueued, the
 * advance the store must receive, the failure/backoff bookkeeping and the
 * tick result. Global invariants are checked after every operation.
 *
 * Model of the policies (execution.md is silent on details; these follow the
 * dispatcher's documented comments and the store contract):
 *  - claims only come from the store; the dispatcher never claims by itself
 *  - lifecycle exclusion: skip the claim and move to the first occurrence after now
 *  - calendar exclusion applies per occurrence: a single-run policy skips its claimed occurrence and moves to the first
 *    occurrence after now; in a queue_all backlog an excluded slot is consumed without a job (nor a remaining occurrence)
 *    and the other slots enqueue; a backlog that is entirely excluded advances as "skipped" past its last slot
 *  - misfire "skip": a lag of more than 60 minutes drops the backlog; within the window one run fires
 *  - misfire "fire_now": one run (runAt = now) for the oldest due occurrence, then next occurrence after now
 *  - misfire "queue_all": every due occurrence (oldest first, at most maxQueueAllOccurrences per tick)
 *    runs at its own slot; the schedule stays due while backlog remains
 *  - overlap "skip": busy when the latest earlier job is queued/running (the prior-job lookup alone decides:
 *    a claim's lastStatus "running" is the store's lease marker, e.g. left by a crashed worker, never execution state); busy drops the run, and within a backlog only the first
 *    occurrence of an idle schedule fires; "allow"/"queue" never drop
 *  - at most one enqueue per idempotency key `schedule:<id>:<occurrence ISO>`; an existing job counts
 *    as that occurrence's run without a second enqueue
 *  - any failure keeps the occurrence, records the failure and backs off (doubling, capped); a lost
 *    lease records nothing and never enqueues after the loss
 */

vi.setConfig({ testTimeout: 120_000 * Math.max(1, scaledRuns(100) / 100) })

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const CLOCK_FLOOR = Date.UTC(2018, 0, 1)
const CLOCK_CEILING = Date.UTC(2038, 0, 1)

// ---------------------------------------------------------------------------
// Case description
// ---------------------------------------------------------------------------

type PayloadKind = "ok" | "bad_json" | "array" | "empty" | "null" | "huge"
const PAYLOADS: Record<PayloadKind, () => string> = {
  ok: () => '{"n":1,"s":"x"}',
  bad_json: () => "not-json",
  array: () => "[1]",
  empty: () => "",
  null: () => "null",
  huge: () => `{"a":"${"x".repeat(1024 * 1024)}"}`,
}
const PAYLOAD_ERRORS: Partial<Record<PayloadKind, string>> = {
  bad_json: "Schedule payload is not valid JSON.",
  array: "Schedule payload must be a JSON object.",
  null: "Schedule payload must be a JSON object.",
  huge: "Schedule payload exceeds the maximum of 1048576 bytes.",
}
const PAYLOAD_VALUES: Record<"ok" | "empty", Record<string, unknown>> = { ok: { n: 1, s: "x" }, empty: {} }

interface ScheduleSpec {
  id: string
  scope: ScheduleScopeKind
  payloadKind: PayloadKind
  cron: string
  timezone: string
  overlap: "allow" | "skip" | "queue"
  misfire: "skip" | "fire_now" | "queue_all"
  remaining: number | null
  windowFromMin: number | null
  windowUntilMin: number | null
  calendarKey: "cal" | null
  nextOffsetMin: number
  aligned: boolean
  enabled: boolean
}

type TickFault = { id: string; fault: StoreFault }
type Patch = Partial<Pick<ScheduleSpec, "cron" | "timezone" | "overlap" | "misfire" | "remaining" | "payloadKind" | "calendarKey" | "enabled">> & { rebase?: boolean }

type Op =
  | { kind: "clock"; deltaMs: number }
  | { kind: "tick"; workers: string[]; limit: number; cap: number | undefined; leaseMs: number; backoff: { initialDelayMs: number; maxDelayMs: number } | undefined; faults: TickFault[] }
  | { kind: "pause" | "resume" | "delete"; id: string }
  | { kind: "update"; id: string; patch: Patch }
  | { kind: "create"; spec: ScheduleSpec }
  | { kind: "jobStatus"; id: string; pick: number; status: JobStatus }

interface Scenario {
  mode: "general" | "backlog" | "failing"
  start: number
  initial: ScheduleSpec[]
  ops: Op[]
  /** After the operations: drain every schedule at a fixed instant and audit completeness. */
  drain: boolean
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const IMPOSSIBLE_CRONS = ["0 0 30 2 *", "0 0 31 4,6,9,11 *"]
const COARSE_CRONS = ["*/10 2-4 * * *", "*/15 * * * *", "0,30 * * * *", "7 * * * *", "0 * * * *", "*/20 1-3 * * *", "30 2 * * *", "0 */6 * * *", "15 0 * * 1-5"]

function sensibleCron(rng: Rng, timezone: string, start: number): string {
  if (rng.bool(0.03)) return rng.pick(IMPOSSIBLE_CRONS)
  for (let attempt = 0; attempt < 5; attempt++) {
    const cron = generateDenseCronExpression(rng)
    const parsed = parseOracleCron(cron)
    if (parsed && oracleNext({ cron: parsed, timeZone: timezone, afterMs: start }) !== null) return cron
  }
  return "*/10 * * * *"
}

function generateSpec(rng: Rng, id: string, mode: Scenario["mode"], start: number): ScheduleSpec {
  const timezone = generateZone(rng)
  const backlog = mode === "backlog"
  return {
    id,
    scope: rng.pick(["tenant", "platform", "system"] as const),
    payloadKind: mode === "failing" ? rng.pick(["bad_json", "array", "null"] as const) : backlog ? "ok" : rng.bool(0.85) ? "ok" : rng.pick(["empty", "bad_json", "array", "null"] as const),
    cron: backlog ? rng.pick(COARSE_CRONS) : sensibleCron(rng, timezone, start),
    timezone,
    overlap: backlog ? rng.pick(["allow", "queue"] as const) : rng.pick(["allow", "allow", "skip", "queue"] as const),
    misfire: backlog ? "queue_all" : rng.pick(["skip", "fire_now", "queue_all", "queue_all"] as const),
    remaining: !backlog && rng.bool(0.2) ? rng.int(5) + 1 : null,
    windowFromMin: !backlog && rng.bool(0.1) ? rng.int(2000) - 1000 : null,
    windowUntilMin: !backlog && rng.bool(0.1) ? rng.int(4000) + 100 : null,
    calendarKey: !backlog && rng.bool(0.1) ? "cal" : null,
    nextOffsetMin: -rng.int(backlog ? 1440 : rng.pick([30, 400, 6000, 60 * 1440])) + rng.int(60),
    aligned: rng.bool(0.8),
    enabled: !rng.bool(0.05),
  }
}

const CLOCK_DELTAS = [0, 1, 1000, 4999, 5000, 5001, 10_000, 20_000, 29_999, 30_000, 30_001, 60_000, 90_000, 5 * MINUTE, 59 * MINUTE, 61 * MINUTE, 3 * HOUR, DAY, 2 * DAY, 40 * DAY, 400 * DAY, -1000, -5 * MINUTE, -2 * HOUR, 600_001]

function generateFault(rng: Rng): StoreFault {
  switch (rng.int(5)) {
    case 0: return { kind: "enqueue_throws", index: rng.int(3), committed: rng.bool(), style: rng.pick(["error", "string", "long"] as const) }
    case 1: return { kind: "advance_false" }
    case 2: return { kind: "advance_throws" }
    case 3: return { kind: "renew_false", call: 1 + rng.int(7) }
    default: return { kind: "prior_throws" }
  }
}

function generateScenario(mode: Scenario["mode"]): (rng: Rng) => Scenario {
  return (rng) => {
    const zone0 = generateZone(rng)
    const start = Math.floor(generateInstant(rng, zone0) / MINUTE) * MINUTE
    const count = mode === "failing" ? 1 : 1 + rng.int(3)
    const initial = Array.from({ length: count }, (_, index) => generateSpec(rng, `s${index + 1}`, mode, start))
    const ids = initial.map((spec) => spec.id)
    let created = count
    const opCount = mode === "backlog" ? 5 + rng.int(6) : 10 + rng.int(18)
    const ops: Op[] = []
    for (let index = 0; index < opCount; index++) {
      const roll = rng.int(100)
      const id = rng.pick(ids)
      if (roll < 30) {
        const deltas = mode === "backlog" ? [MINUTE, 5 * MINUTE, HOUR, 3 * HOUR, 12 * HOUR, 90_000, 29_999, 30_001] : mode === "failing" ? [0, 4999, 5000, 5001, 10_000, 10_001, 20_000, 39_999, 40_000, 80_000, 900_000, 900_001, HOUR] : CLOCK_DELTAS
        ops.push({ kind: "clock", deltaMs: rng.pick(deltas) })
      } else if (roll < 84 || mode !== "general") {
        const workers = rng.bool(0.25) ? ["w1", "w2"] : [rng.pick(["w1", "w2", "w3"])]
        const faults: TickFault[] = mode === "backlog" ? [] : ids.filter(() => rng.bool(mode === "failing" ? 0.15 : 0.35)).map((faultId) => ({ id: faultId, fault: generateFault(rng) }))
        ops.push({
          kind: "tick", workers, limit: rng.pick([1, 2, 3, 100]),
          cap: rng.bool(0.04) ? rng.pick([0, -1, 2.5, Number.NaN]) : mode === "backlog" && rng.bool(0.3) ? rng.pick([Number.MAX_SAFE_INTEGER, 2 ** 53, 1e300]) : rng.pick([undefined, undefined, 1, 2, 3, 3, 7, 50]),
          leaseMs: rng.pick([1000, 30_000, 30_000, 600_000]),
          backoff: rng.bool(0.3) ? rng.pick([{ initialDelayMs: 1000, maxDelayMs: 60_000 }, { initialDelayMs: 5000, maxDelayMs: 5000 }, { initialDelayMs: 1, maxDelayMs: 3 }]) : undefined,
          faults,
        })
      } else if (roll < 88) {
        ops.push({ kind: rng.pick(["pause", "resume", "delete"] as const), id })
      } else if (roll < 95) {
        const patch: Patch = {}
        if (rng.bool(0.4)) patch.cron = sensibleCron(rng, "UTC", start)
        if (rng.bool(0.2)) patch.timezone = generateZone(rng)
        if (rng.bool(0.3)) patch.overlap = rng.pick(["allow", "skip", "queue"] as const)
        if (rng.bool(0.3)) patch.misfire = rng.pick(["skip", "fire_now", "queue_all"] as const)
        if (rng.bool(0.2)) patch.remaining = rng.bool() ? null : rng.int(4) + 1
        if (rng.bool(0.3)) patch.payloadKind = rng.pick(["ok", "ok", "bad_json", "empty"] as const)
        if (rng.bool(0.15)) patch.calendarKey = rng.bool() ? "cal" : null
        if (rng.bool(0.1)) patch.enabled = rng.bool()
        if (rng.bool(0.3)) patch.rebase = true
        ops.push({ kind: "update", id, patch })
      } else if (roll < 97 && created < 5) {
        created += 1
        ops.push({ kind: "create", spec: generateSpec(rng, `s${created}`, mode, start) })
        ids.push(`s${created}`)
      } else {
        ops.push({ kind: "jobStatus", id, pick: rng.int(8), status: rng.pick(["pending", "running", "succeeded", "retrying", "failed", "dead_letter", "cancelled"] as const) })
      }
    }
    if (mode === "failing") {
      ops.push({ kind: "update", id: ids[0]!, patch: { payloadKind: "ok" } }, { kind: "clock", deltaMs: 900_001 }, { kind: "tick", workers: ["w1"], limit: 100, cap: undefined, leaseMs: 30_000, backoff: undefined, faults: [] })
    }
    return { mode, start, initial, ops, drain: mode === "backlog" }
  }
}

function* shrinkScenario(value: Scenario): Generator<Scenario> {
  for (let index = 0; index < value.ops.length; index++) yield { ...value, ops: value.ops.filter((_, position) => position !== index) }
  for (let index = 0; index < value.ops.length; index++) {
    const op = value.ops[index]!
    if (op.kind === "tick" && op.faults.length > 0) yield { ...value, ops: value.ops.map((candidate, position) => (position === index ? { ...op, faults: [] } : candidate)) }
    if (op.kind === "tick" && op.workers.length > 1) yield { ...value, ops: value.ops.map((candidate, position) => (position === index ? { ...op, workers: [op.workers[0]!] } : candidate)) }
  }
  if (value.initial.length > 1) for (let index = 0; index < value.initial.length; index++) yield { ...value, initial: value.initial.filter((_, position) => position !== index) }
}

// ---------------------------------------------------------------------------
// Reference model
// ---------------------------------------------------------------------------

const cronCache = new Map<string, OracleCron>()
function cronOf(expression: string): OracleCron {
  let cron = cronCache.get(expression)
  if (!cron) {
    cron = parseOracleCron(expression) ?? (() => { throw new Error(`bad cron ${expression}`) })()
    cronCache.set(expression, cron)
  }
  return cron
}

const calendarExcludes = (key: string, instant: Date): boolean => key === "cal" && Math.floor(instant.getTime() / HOUR) % 2 === 0

type Prior = "queued" | "running" | "completed" | "failed" | "cancelled"
const PRIOR_OF: Record<JobStatus, Prior> = { pending: "queued", retrying: "queued", running: "running", succeeded: "completed", failed: "failed", dead_letter: "failed", cancelled: "cancelled" }

interface ExpectedAdvance { nextRunAt: number | null; lastRunAt: number; lastStatus: string; occurrencesFired?: number; lastError?: string; retryAt?: number }
interface ExpectedAttempt { key: string; runAt: number; outcome: "stored" | "threw_after_commit" | "threw"; partitioned: boolean; payload: Record<string, unknown> }
interface ClaimModel {
  attempts: ExpectedAttempt[]
  terminal: { kind: "advance"; args: ExpectedAdvance } | { kind: "fail"; message: string }
  truncated: boolean
}

interface TickContext { now: number; cap: number | undefined; backoff: { initialDelayMs: number; maxDelayMs: number } }

const codePointTruncate = (text: string, max: number): string => Array.from(text).slice(0, max).join("")

function failureAdvance(record: ClaimModel["terminal"] & { kind: "fail" }, claim: ClaimRecord["claim"], ctx: TickContext): ExpectedAdvance {
  const since = claim.lastStatus === "failed" && claim.lastRunAt ? Math.max(0, ctx.now - claim.lastRunAt.getTime()) : 0
  const delay = Math.min(ctx.backoff.maxDelayMs, Math.max(ctx.backoff.initialDelayMs, since * 2))
  return { nextRunAt: claim.nextRunAt.getTime(), lastRunAt: ctx.now, lastStatus: "failed", lastError: codePointTruncate(record.message, 512), retryAt: ctx.now + delay }
}

function modelClaim(record: ClaimRecord, ctx: TickContext, faults: StoreFault[]): ClaimModel {
  const claim = record.claim
  const now = ctx.now
  const first = claim.nextRunAt.getTime()
  const cron = cronOf(claim.cronExpression)
  const nextAfter = (instant: number): number | null => oracleNext({ cron, timeZone: claim.timezone, afterMs: instant })
  const attempts: ExpectedAttempt[] = []
  const skipTo = (): ClaimModel => ({ attempts, truncated: false, terminal: { kind: "advance", args: { nextRunAt: nextAfter(now), lastRunAt: now, lastStatus: "skipped" } } })
  const fail = (message: string, truncated = false): ClaimModel => ({ attempts, truncated, terminal: { kind: "fail", message } })

  const lifecycle = claim.lifecycle
  const effective = lifecycle === undefined || (
    !lifecycle.paused && (lifecycle.remainingOccurrences === undefined || lifecycle.remainingOccurrences > 0) &&
    (lifecycle.effectiveFrom === undefined || now >= Date.parse(lifecycle.effectiveFrom)) && (lifecycle.effectiveUntil === undefined || now < Date.parse(lifecycle.effectiveUntil))
  )
  const queueAll = claim.misfirePolicy.type === "queue_all"
  const excluded = (instant: number): boolean => lifecycle?.calendarExclusionKey !== undefined && calendarExcludes(lifecycle.calendarExclusionKey, new Date(instant))
  if (!effective || (!queueAll && excluded(first))) return skipTo()

  const cap = ctx.cap ?? 50
  if (queueAll && (!Number.isInteger(cap) || cap <= 0)) return fail("maxQueueAllOccurrences must be a positive integer")

  if (faults.some((fault) => fault.kind === "prior_throws")) return fail(FAULT_TEXT.prior)
  const earlier = record.jobs.filter((job) => job.runAt < first)
  let latest: (typeof earlier)[number] | undefined
  for (const job of earlier) if (!latest || job.runAt >= latest.runAt) latest = job
  const groupPrior: Prior | null = latest ? PRIOR_OF[latest.status] : null

  const lag = now - first
  const dropsBacklog = claim.misfirePolicy.type === "skip" && lag > HOUR
  const busyOf = (prior: Prior | null): boolean => prior === "queued" || prior === "running"
  const skipsOverlap = claim.overlapPolicy.type === "skip"
  if (dropsBacklog || (skipsOverlap && busyOf(groupPrior))) return skipTo()

  let occurrences: number[] = [first]
  let truncated = false
  if (queueAll) {
    occurrences = [first, ...oracleOccurrences({ cron, timeZone: claim.timezone, afterMs: first, endMs: now, limit: cap })]
    if (occurrences.length > cap) {
      truncated = true
      occurrences = occurrences.slice(0, cap)
    }
  }

  const remaining = lifecycle?.remainingOccurrences
  let fired = 0
  let calendarSkipped = 0
  let lastOccurrence: number | undefined
  let lastJob: Prior | null = null
  const enqueueFault = faults.find((fault): fault is Extract<StoreFault, { kind: "enqueue_throws" }> => fault.kind === "enqueue_throws")
  const payloadKind = payloadKindOf(claim.payload)
  for (const occurrence of occurrences) {
    if (remaining !== undefined && fired >= remaining) break
    lastOccurrence = occurrence
    if (queueAll && excluded(occurrence)) {
      calendarSkipped++
      continue
    }
    const key = `schedule:${claim.scheduleId}:${new Date(occurrence).toISOString()}`
    if (skipsOverlap && busyOf(lastJob ?? groupPrior)) continue
    const existing = record.jobs.find((job) => job.key === key)
    if (existing) {
      lastJob = PRIOR_OF[existing.status]
      fired++
      continue
    }
    const payloadError = PAYLOAD_ERRORS[payloadKind]
    if (payloadError) return fail(payloadError, truncated)
    const attempt: ExpectedAttempt = { key, runAt: queueAll ? occurrence : now, outcome: "stored", partitioned: claim.overlapPolicy.type === "queue", payload: PAYLOAD_VALUES[payloadKind as "ok" | "empty"] }
    attempts.push(attempt)
    if (enqueueFault && enqueueFault.index === attempts.length - 1) {
      attempt.outcome = enqueueFault.committed ? "threw_after_commit" : "threw"
      return fail(enqueueFault.style === "string" ? FAULT_TEXT.string : enqueueFault.style === "long" ? FAULT_TEXT.long : FAULT_TEXT.error, truncated)
    }
    fired++
    lastJob = "queued"
  }
  if (lastOccurrence === undefined) return fail(`Schedule ${claim.scheduleId} produced no occurrence`, truncated)
  const next = nextAfter(queueAll ? lastOccurrence : now)
  if (next === null) return fail(`Schedule ${claim.scheduleId} has no future occurrence for its cron expression.`, truncated)
  return { attempts, truncated, terminal: { kind: "advance", args: { nextRunAt: next, lastRunAt: now, lastStatus: fired === 0 && calendarSkipped > 0 ? "skipped" : "fired", occurrencesFired: fired } } }
}

function payloadKindOf(payload: string): PayloadKind {
  for (const kind of Object.keys(PAYLOADS) as PayloadKind[]) if (PAYLOADS[kind]() === payload) return kind
  throw new Error("unknown payload")
}

interface Finalized {
  advances: Array<{ args: ExpectedAdvance; outcome: "applied" | "false_fault" | "threw" }>
  errors: string[]
  processed: boolean
}

/** Applies the injected store faults to the advance sequence the dispatcher performs. */
function finalizeClaim(model: ClaimModel, claim: ClaimRecord["claim"], ctx: TickContext, faults: StoreFault[]): Finalized {
  const advances: Finalized["advances"] = []
  const errors: string[] = []
  let calls = 0
  const attemptAdvance = (args: ExpectedAdvance): "applied" | "false_fault" | "threw" => {
    calls++
    const outcome = faults.some((fault) => fault.kind === "advance_throws") ? "threw" : calls === 1 && faults.some((fault) => fault.kind === "advance_false") ? "false_fault" : "applied"
    advances.push({ args, outcome })
    return outcome
  }
  const failWith = (message: string): Finalized => {
    attemptAdvance(failureAdvance({ kind: "fail", message }, claim, ctx))
    errors.push(message)
    return { advances, errors, processed: false }
  }
  if (model.terminal.kind === "fail") return failWith(model.terminal.message)
  const outcome = attemptAdvance(model.terminal.args)
  if (outcome === "applied") return { advances, errors, processed: true }
  if (outcome === "false_fault") {
    errors.push(`Schedule ${claim.scheduleId} lease was lost.`)
    return { advances, errors, processed: false }
  }
  return failWith(FAULT_TEXT.advance)
}

function requesterOf(claim: ClaimRecord["claim"]): JobRequester {
  if (claim.executionScope.kind === "tenant") return { scope: "tenant", tenantId: claim.executionScope.tenantId, actorId: "system" }
  if (claim.executionScope.kind === "platform") return { scope: "platform", actorId: "scheduler" }
  return { scope: "system" }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface Meta {
  /** True while the schedule has only ever been touched by operations that cannot lose an occurrence. */
  clean: boolean
  startNext: number | null
}

class Runner {
  readonly world: ScheduleWorld
  private readonly meta = new Map<string, Meta>()
  private readonly specs = new Map<string, ScheduleSpec>()

  constructor(private readonly scenario: Scenario) {
    this.world = new ScheduleWorld(scenario.start)
    for (const spec of scenario.initial) this.create(spec)
  }

  private rowOf(spec: ScheduleSpec): WorldSchedule {
    const world = this.world
    const cron = cronOf(spec.cron)
    const raw = world.now + spec.nextOffsetMin * MINUTE
    const aligned = oracleNext({ cron, timeZone: spec.timezone, afterMs: raw - 1 })
    const nextRunAt = spec.aligned && aligned !== null ? aligned : raw
    return {
      id: spec.id, scope: spec.scope, payload: PAYLOADS[spec.payloadKind](), cron: spec.cron, timezone: spec.timezone, overlap: spec.overlap, misfire: spec.misfire,
      enabled: spec.enabled, paused: false,
      effectiveFrom: spec.windowFromMin === null ? null : world.now + spec.windowFromMin * MINUTE,
      effectiveUntil: spec.windowUntilMin === null ? null : world.now + spec.windowUntilMin * MINUTE,
      remaining: spec.remaining, calendarKey: spec.calendarKey, nextRunAt, lastRunAt: null, lastStatus: null, lastError: null, leaseOwner: null, claimToken: null, leaseExpiresAt: null,
    }
  }

  private create(spec: ScheduleSpec): void {
    const row = this.rowOf(spec)
    this.specs.set(spec.id, spec)
    this.world.put(row)
    const clean = spec.misfire === "queue_all" && spec.overlap !== "skip" && spec.remaining === null && spec.calendarKey === null && spec.windowFromMin === null && spec.windowUntilMin === null && spec.payloadKind === "ok"
    this.meta.set(spec.id, { clean, startNext: row.nextRunAt })
  }

  async apply(op: Op): Promise<void> {
    const world = this.world
    switch (op.kind) {
      case "clock":
        world.now = Math.min(CLOCK_CEILING, Math.max(CLOCK_FLOOR, world.now + op.deltaMs))
        break
      case "pause":
      case "resume": {
        const row = world.schedules.get(op.id)
        if (row) row.paused = op.kind === "pause"
        break
      }
      case "delete":
        world.remove(op.id)
        this.meta.delete(op.id)
        break
      case "create":
        if (!world.schedules.has(op.spec.id)) this.create(op.spec)
        break
      case "update":
        this.update(op.id, op.patch)
        break
      case "jobStatus": {
        const jobs = world.jobsOf(op.id)
        if (jobs.length > 0) world.setJobStatus(jobs[op.pick % jobs.length]!.key, op.status)
        break
      }
      case "tick":
        await this.tick(op)
        break
    }
    this.checkGlobal()
  }

  private update(id: string, patch: Patch): void {
    const row = this.world.schedules.get(id)
    const spec = this.specs.get(id)
    const meta = this.meta.get(id)
    if (!row || !spec || !meta) return
    if (patch.cron !== undefined) row.cron = patch.cron
    if (patch.timezone !== undefined) row.timezone = patch.timezone
    if (patch.overlap !== undefined) row.overlap = patch.overlap
    if (patch.misfire !== undefined) row.misfire = patch.misfire
    if (patch.remaining !== undefined) row.remaining = patch.remaining
    if (patch.payloadKind !== undefined) row.payload = PAYLOADS[patch.payloadKind]()
    if (patch.calendarKey !== undefined) row.calendarKey = patch.calendarKey
    if (patch.enabled !== undefined) row.enabled = patch.enabled
    const definitionChanged = patch.cron !== undefined || patch.timezone !== undefined || patch.overlap !== undefined || patch.misfire !== undefined || patch.remaining !== undefined || patch.calendarKey !== undefined || patch.payloadKind !== undefined
    if (definitionChanged) meta.clean = false
    if (patch.rebase || definitionChanged) {
      this.world.rebase(id)
      meta.clean = false
    }
    if (patch.rebase) row.nextRunAt = oracleNext({ cron: cronOf(row.cron), timeZone: row.timezone, afterMs: this.world.now })
  }

  async tick(op: Extract<Op, { kind: "tick" }>): Promise<void> {
    const world = this.world
    const eventStart = world.events.length
    const claimStart = world.claims.length
    for (const { id, fault } of op.faults) world.armFault(id, fault)
    const now = world.now
    const backoff = op.backoff ?? DEFAULT_SCHEDULE_FAILURE_BACKOFF
    const runOne = (workerId: string): Promise<MaterializeResult> => materializeDueSchedules({
      scheduleStore: world.scheduleStore, jobStore: world.jobStore, workerId, limit: op.limit, now: new Date(now), leaseDurationMs: op.leaseMs,
      renewalClock: world.renewalClock, calendarExclusionProvider: { isExcluded: async (key, instant) => calendarExcludes(key, instant) },
      ...(op.cap === undefined ? {} : { maxQueueAllOccurrences: op.cap }), ...(op.backoff === undefined ? {} : { failureBackoff: op.backoff }),
    })
    const results = await Promise.all(op.workers.map(runOne))
    const events = world.events.slice(eventStart)
    const ctx: TickContext = { now, cap: op.cap, backoff }
    op.workers.forEach((workerId, index) => this.verifyWorker(workerId, results[index]!, world.claims.slice(claimStart).filter((record) => record.workerId === workerId), events, op, ctx))
    // A schedule that was claimed twice in one instant would show up as two claims for one id without an advance in between.
    const seen = new Set<string>()
    for (const record of world.claims.slice(claimStart)) {
      expect(seen.has(record.claim.scheduleId), `schedule ${record.claim.scheduleId} claimed twice in one tick round`).toBe(false)
      seen.add(record.claim.scheduleId)
    }
    world.clearFaults()
  }

  private verifyWorker(workerId: string, result: MaterializeResult, records: ClaimRecord[], events: WorldEvent[], op: Extract<Op, { kind: "tick" }>, ctx: TickContext): void {
    const label = `worker ${workerId}`
    const expectedErrors: string[] = []
    const expectedTruncated: string[] = []
    let expectedProcessed = 0
    let expectedEnqueued = 0
    for (const record of records) {
      const id = record.claim.scheduleId
      const faults = op.faults.filter((entry) => entry.id === id).map((entry) => entry.fault)
      const mine = events.filter((event) => event.scheduleId === id)
      const renewLost = mine.findIndex((event) => event.type === "renew" && !event.ok)
      const model = modelClaim(record, ctx, faults.filter((fault) => fault.kind !== "renew_false"))
      const stored = mine.filter((event): event is Extract<WorldEvent, { type: "enqueue" }> => event.type === "enqueue")
      const advances = mine.filter((event): event is Extract<WorldEvent, { type: "advance" }> => event.type === "advance")
      if (renewLost >= 0) {
        // Fencing: once the store refused a renewal, the dispatcher must neither enqueue nor advance for this claim.
        const after = mine.slice(renewLost + 1)
        expect(after.filter((event) => event.type !== "renew"), `${label} ${id}: activity after lease loss`).toEqual([])
        expect(stored.map((event) => event.key), `${label} ${id}: enqueues are a prefix of the model's`).toEqual(model.attempts.map((attempt) => attempt.key).slice(0, stored.length))
        expectedErrors.push(`Schedule ${id} lease was lost.`)
        expectedEnqueued += stored.filter((event) => event.outcome === "stored").length
        if (model.truncated) expectedTruncated.push(id)
        continue
      }
      const fin = finalizeClaim(model, record.claim, ctx, faults)
      expect(stored.map((event) => `${event.key}|${event.runAt}|${event.outcome}`), `${label} ${id}: enqueue calls`).toEqual(model.attempts.map((attempt) => `${attempt.key}|${attempt.runAt}|${attempt.outcome}`))
      const requester = requesterOf(record.claim)
      for (const [position, event] of stored.entries()) {
        const attempt = model.attempts[position]!
        expect(event.requester).toEqual(requester)
        expect(event.job).toMatchObject({
          executionScope: record.claim.executionScope, jobType: record.claim.jobType, jobVersion: record.claim.jobVersion,
          idempotencyKey: attempt.key, correlationId: `sched:${id}`, payload: attempt.payload,
          ...(attempt.partitioned ? { partitionKey: `schedule:${id}` } : {}),
        })
        if (!attempt.partitioned) expect(event.job.partitionKey, `${label} ${id}: partition key only for queue overlap`).toBeUndefined()
      }
      expect(advances.map((event) => event.outcome), `${label} ${id}: advance outcomes`).toEqual(fin.advances.map((advance) => advance.outcome))
      advances.forEach((event, position) => {
        const expected = fin.advances[position]!.args
        const where = `${label} ${id} advance #${position}`
        expect(event.args.scheduleId).toBe(id)
        expect(event.args.workerId, where).toBe(workerId)
        expect(event.args.claimToken, where).toBe(record.claim.claimToken)
        expect(event.args.nextRunAt === null ? null : event.args.nextRunAt.getTime(), `${where}: nextRunAt (${event.args.lastStatus})`).toBe(expected.nextRunAt)
        expect(event.args.lastRunAt.getTime(), where).toBe(expected.lastRunAt)
        expect(event.args.lastStatus, where).toBe(expected.lastStatus)
        expect(event.args.occurrencesFired, `${where}: occurrencesFired`).toBe(expected.occurrencesFired)
        expect(event.args.lastError, `${where}: lastError`).toBe(expected.lastError)
        expect(event.args.retryAt?.getTime(), `${where}: retryAt`).toBe(expected.retryAt)
      })
      expectedErrors.push(...fin.errors)
      if (fin.processed) expectedProcessed++
      expectedEnqueued += stored.filter((event) => event.outcome === "stored").length
      if (model.truncated) expectedTruncated.push(id)
    }
    expect(result.errors, `${label}: errors`).toEqual(expectedErrors)
    expect(result.schedulesProcessed, `${label}: schedulesProcessed`).toBe(expectedProcessed)
    expect(result.jobsEnqueued, `${label}: jobsEnqueued`).toBe(expectedEnqueued)
    expect(result.backlogTruncated ?? [], `${label}: backlogTruncated`).toEqual(expectedTruncated)
  }

  checkGlobal(): void {
    const world = this.world
    expect(world.violations, "store/job invariants").toEqual([])
    for (const row of world.schedules.values()) {
      if (row.remaining !== null) expect(row.remaining, `schedule ${row.id}: remaining occurrences`).toBeGreaterThanOrEqual(0)
    }
    this.checkLossless(false)
  }

  /**
   * Schedules that only ever used lossless operations (queue_all, no overlap skip, no exclusions or caps)
   * must hold a job for every occurrence strictly before their nextRunAt. With `complete`, additionally every
   * occurrence up to the clock must be materialized exactly once and nothing else.
   */
  checkLossless(complete: boolean): void {
    const world = this.world
    for (const row of world.schedules.values()) {
      const meta = this.meta.get(row.id)
      if (!meta?.clean || meta.startNext === null || row.nextRunAt === null) continue
      const cron = cronOf(row.cron)
      const horizon = complete ? Math.max(row.nextRunAt - 1, world.now) : row.nextRunAt - 1
      if (horizon - meta.startNext > 40 * DAY) continue
      const slots = meta.startNext <= horizon ? [meta.startNext, ...oracleOccurrences({ cron, timeZone: row.timezone, afterMs: meta.startNext, endMs: horizon })] : []
      const keys = new Set(world.jobsOf(row.id).map((job) => job.key))
      const missing = slots.filter((slot) => !keys.has(`schedule:${row.id}:${new Date(slot).toISOString()}`))
      expect(missing.map((slot) => new Date(slot).toISOString()), `schedule ${row.id}: occurrences without a job (nextRunAt ${new Date(row.nextRunAt).toISOString()})`).toEqual([])
      if (complete) {
        expect(keys.size, `schedule ${row.id}: job count equals occurrence count`).toBe(slots.length)
        expect(row.nextRunAt, `schedule ${row.id}: drained schedule is no longer due`).toBeGreaterThan(world.now)
      }
    }
  }

  async drain(): Promise<void> {
    const world = this.world
    // Past every lease (<= 600_000 ms) and past the longest default failure backoff: a schedule that failed repeatedly is not
    // claimable again for DEFAULT_SCHEDULE_FAILURE_BACKOFF.maxDelayMs, and draining must not mistake that wait for lost work.
    world.now = Math.min(CLOCK_CEILING, world.now + Math.max(600_001, DEFAULT_SCHEDULE_FAILURE_BACKOFF.maxDelayMs + 1))
    for (const row of world.schedules.values()) {
      row.paused = false
      row.enabled = true
    }
    for (let round = 0; round < 60; round++) {
      const before = world.claims.length
      await this.tick({ kind: "tick", workers: ["w1"], limit: 100, cap: 1000, leaseMs: 30_000, backoff: undefined, faults: [] })
      if (world.claims.length === before) break
      this.checkGlobal()
    }
    this.checkLossless(true)
  }
}

async function runScenario(scenario: Scenario): Promise<void> {
  const runner = new Runner(scenario)
  for (const op of scenario.ops) await runner.apply(op)
  if (scenario.drain) await runner.drain()
}

const describeScenario = (scenario: Scenario): string => JSON.stringify(scenario, (_key, value: unknown) => (typeof value === "number" && Number.isNaN(value) ? "NaN" : value), 1)

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("schedule dispatcher - model based", () => {
  it("every claim's jobs, advance, failure bookkeeping and tick result match the reference model over random operation sequences", async () => {
    await forAllAsync("schedule dispatcher matches the reference model over random operation sequences", generateScenario("general"), runScenario, { runs: 200, shrink: shrinkScenario, describe: describeScenario })
  })

  it("queue_all never loses an occurrence: a drained backlog holds exactly one job per due slot", async () => {
    await forAllAsync("schedule queue_all backlog drains into exactly one job per due occurrence", generateScenario("backlog"), runScenario, { runs: 70, shrink: shrinkScenario, describe: describeScenario })
  })

  it("a persistently failing schedule keeps its occurrence, backs off with doubling delays, and recovers", async () => {
    await forAllAsync("schedule failing payload backs off and recovers on the same occurrence", generateScenario("failing"), runScenario, { runs: 100, shrink: shrinkScenario, describe: describeScenario })
  })
})

describe("schedule dispatcher - argument validation", () => {
  it("rejects invalid workerId, limit, lease duration and backoff before touching any store", async () => {
    await forAllAsync("schedule dispatcher rejects invalid options before claiming", (rng) => ({
      workerId: rng.pick(["w1", "", "   ", 7 as unknown as string]),
      limit: rng.pick([undefined, 1, 100, 0, 101, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER]),
      leaseDurationMs: rng.pick([undefined, 1, 30_000, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, Number.MAX_SAFE_INTEGER]),
      invalidNow: rng.bool(0.15),
      backoff: rng.pick([undefined, { initialDelayMs: 1, maxDelayMs: 1 }, { initialDelayMs: 0, maxDelayMs: 5 }, { initialDelayMs: 5, maxDelayMs: 4 }, { initialDelayMs: 1.5, maxDelayMs: 5 }, { initialDelayMs: 1, maxDelayMs: Number.POSITIVE_INFINITY }]),
    }), async (value) => {
      const world = new ScheduleWorld(Date.UTC(2026, 0, 1))
      const validWorker = typeof value.workerId === "string" && value.workerId.trim().length > 0
      const validLimit = value.limit === undefined || (Number.isSafeInteger(value.limit) && value.limit >= 1 && value.limit <= 100)
      const validLease = value.leaseDurationMs === undefined || (Number.isFinite(value.leaseDurationMs) && value.leaseDurationMs > 0 && value.leaseDurationMs <= 2 ** 31 - 1)
      const validBackoff = value.backoff === undefined || (Number.isSafeInteger(value.backoff.initialDelayMs) && value.backoff.initialDelayMs >= 1 && Number.isSafeInteger(value.backoff.maxDelayMs) && value.backoff.maxDelayMs >= value.backoff.initialDelayMs)
      const call = materializeDueSchedules({
        scheduleStore: world.scheduleStore, jobStore: world.jobStore, workerId: value.workerId, now: new Date(value.invalidNow ? Number.NaN : world.now), renewalClock: world.renewalClock,
        ...(value.limit === undefined ? {} : { limit: value.limit }), ...(value.leaseDurationMs === undefined ? {} : { leaseDurationMs: value.leaseDurationMs }), ...(value.backoff === undefined ? {} : { failureBackoff: value.backoff }),
      })
      if (validWorker && validLimit && validLease && validBackoff && !value.invalidNow) await expect(call).resolves.toMatchObject({ schedulesProcessed: 0, jobsEnqueued: 0, errors: [] })
      else await expect(call).rejects.toThrow()
      if (!(validWorker && validLimit && validLease && validBackoff && !value.invalidNow)) expect(world.claims).toEqual([])
    }, { runs: 150, describe: (value) => JSON.stringify(value, (_key, item: unknown) => (typeof item === "number" && !Number.isFinite(item) ? String(item) : item)) })
  })
})
