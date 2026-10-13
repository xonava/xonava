/**
 * Store-contract differential for the REAL schedule stores (PostgreSQL, MySQL, D1).
 *
 * Random sequences of schedule-definition changes (insert / patch / pause / resume / delete, written straight to the
 * table the way a deployer's admin tooling would) and ScheduleStore operations (claimDueSchedules, renewScheduleLease,
 * advanceSchedule, releaseSchedule, with correct AND stale/foreign claim tokens, workers and schedules) are run against
 * the real store and against an in-memory reference written from docs/spec/execution.md and the ScheduleStore contract.
 * After every step each return value (or thrown error class) and every observable row is compared.
 *
 * Time handling (documented per the brief):
 *  - Everything the stores take from the caller (`now` of claimDueSchedules: due-ness, effective window, remaining
 *    occurrences, failure backoff `retryAt` vs `now`) is driven by a controlled logical clock that starts in 2031, so it
 *    is exactly comparable, including the equality boundaries.
 *  - Lease liveness is judged by each store on the DATABASE clock (`now()` / CURRENT_TIMESTAMP / julianday). The
 *    differential never races that clock: leases are either long (minutes) and therefore live, or are made expired by
 *    back-dating the lease column by an hour (the same row write a crash plus the passage of the lease would leave).
 *    The reference compares a live lease's expiry numerically with a few seconds of tolerance (so a store that
 *    shortens a lease on renewal is caught); real elapsed-lease expiry is covered separately by a short-lease test with
 *    a bounded real wait.
 *  - nextRunAt values are made unique per row, because the stores order by nextRunAt only (ties are unspecified).
 */
import { expect } from "vitest"
import { assertDurableIdentifier, scheduleOccurrencesConsumed, type FencedScheduleClaim, type ScheduleStore } from "core/execution"
import { forAllAsync, type Rng } from "../../../core/src/__tests__/differential/harness.js"

// ---------------------------------------------------------------------------------------------------------------------
// Driver

export interface ScheduleDialect {
  readonly table: string
  readonly leaseOwnerColumn: string
  /** Placeholder for the 1-based parameter index. */
  param(index: number): string
  time(ms: number | null): unknown
  bool(value: boolean): unknown
  fromTime(value: unknown): number | null
  fromBool(value: unknown): boolean
}

export interface ScheduleDriver {
  readonly label: string
  readonly store: ScheduleStore
  readonly dialect: ScheduleDialect
  /** The deployer schema allows next_run_at NULL (the MySQL fixture schema declares it NOT NULL). */
  readonly nullableNextRunAt: boolean
  /** Round trips are slow (D1 over Miniflare HTTP): shorter sequences, state compared every few steps, smaller concurrency cases. */
  readonly slowRoundTrips?: boolean
  run(sql: string, params: unknown[]): Promise<void>
  /** Several statements in one round trip (optional; used to batch the harness's own table writes). */
  runMany?(statements: Array<{ sql: string; params: unknown[] }>): Promise<void>
  all(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>>
}

type Scope = "tenant" | "platform" | "system"

export interface RefRow {
  id: string
  scope: Scope
  tenantId: string | null
  jobType: string
  jobVersion: number
  payload: string
  cronExpression: string
  timezone: string
  enabled: boolean
  paused: boolean
  overlapPolicy: "allow" | "skip" | "queue"
  misfirePolicy: "skip" | "fire_now" | "queue_all"
  nextRunAt: number | null
  lastRunAt: number | null
  lastStatus: string | null
  lastError: string | null
  leaseOwner: string | null
  claimToken: string | null
  leaseAt: number | null
  effectiveFrom: number | null
  effectiveUntil: number | null
  remaining: number | null
  calendarKey: string | null
  owner: string | null
  description: string | null
}

type Kind = "text" | "int" | "bool" | "time"
const FIELD_KINDS: Record<keyof RefRow, Kind> = {
  id: "text", scope: "text", tenantId: "text", jobType: "text", jobVersion: "int", payload: "text", cronExpression: "text", timezone: "text",
  enabled: "bool", paused: "bool", overlapPolicy: "text", misfirePolicy: "text", nextRunAt: "time", lastRunAt: "time", lastStatus: "text",
  lastError: "text", leaseOwner: "text", claimToken: "text", leaseAt: "time", effectiveFrom: "time", effectiveUntil: "time", remaining: "int",
  calendarKey: "text", owner: "text", description: "text",
}
const FIELD_COLUMN: Record<keyof RefRow, string> = {
  id: "id", scope: "scope", tenantId: "tenant_id", jobType: "job_type", jobVersion: "job_version", payload: "payload", cronExpression: "cron_expression",
  timezone: "timezone", enabled: "enabled", paused: "paused", overlapPolicy: "overlap_policy", misfirePolicy: "misfire_policy", nextRunAt: "next_run_at",
  lastRunAt: "last_run_at", lastStatus: "last_status", lastError: "last_error", leaseOwner: "@lease_owner", claimToken: "claim_token",
  leaseAt: "lease_expires_at", effectiveFrom: "effective_from", effectiveUntil: "effective_until", remaining: "remaining_occurrences",
  calendarKey: "calendar_exclusion_key", owner: "owner", description: "description",
}
const FIELDS = Object.keys(FIELD_KINDS) as Array<keyof RefRow>

function column(driver: ScheduleDriver, field: keyof RefRow): string {
  const name = FIELD_COLUMN[field]
  return name === "@lease_owner" ? driver.dialect.leaseOwnerColumn : name
}

function encode(driver: ScheduleDriver, field: keyof RefRow, value: unknown): unknown {
  if (value === null || value === undefined) return null
  const kind = FIELD_KINDS[field]
  if (kind === "time") return driver.dialect.time(value as number)
  if (kind === "bool") return driver.dialect.bool(value as boolean)
  return value
}

function decode(driver: ScheduleDriver, field: keyof RefRow, value: unknown): unknown {
  if (value === null || value === undefined) return null
  const kind = FIELD_KINDS[field]
  if (kind === "time") return driver.dialect.fromTime(value)
  if (kind === "bool") return driver.dialect.fromBool(value)
  if (kind === "int") return Number(value)
  return value
}

export async function insertRow(driver: ScheduleDriver, row: RefRow): Promise<void> {
  const cols = FIELDS.map((field) => column(driver, field))
  const params = FIELDS.map((field) => encode(driver, field, row[field]))
  await driver.run(`INSERT INTO ${driver.dialect.table} (${cols.join(",")}) VALUES (${FIELDS.map((_, index) => driver.dialect.param(index + 1)).join(",")})`, params)
}

export async function updateRow(driver: ScheduleDriver, id: string, fields: Partial<RefRow>): Promise<void> {
  const keys = Object.keys(fields) as Array<keyof RefRow>
  if (keys.length === 0) return
  const sets = keys.map((key, index) => `${column(driver, key)}=${driver.dialect.param(index + 1)}`)
  await driver.run(`UPDATE ${driver.dialect.table} SET ${sets.join(",")} WHERE id=${driver.dialect.param(keys.length + 1)}`, [...keys.map((key) => encode(driver, key, fields[key])), id])
}

export async function deleteRow(driver: ScheduleDriver, id: string): Promise<void> {
  await driver.run(`DELETE FROM ${driver.dialect.table} WHERE id=${driver.dialect.param(1)}`, [id])
}

export async function readRows(driver: ScheduleDriver): Promise<Map<string, RefRow>> {
  const rows = await driver.all(`SELECT ${FIELDS.map((field) => `${column(driver, field)} AS ${field}`).join(",")} FROM ${driver.dialect.table}`, [])
  const out = new Map<string, RefRow>()
  for (const raw of rows) {
    const row: Record<string, unknown> = {}
    for (const field of FIELDS) row[field] = decode(driver, field, raw[field] ?? raw[field.toLowerCase()])
    out.set(row.id as string, row as unknown as RefRow)
  }
  return out
}

export async function clearRows(driver: ScheduleDriver): Promise<void> {
  await driver.run(`DELETE FROM ${driver.dialect.table}`, [])
}

/**
 * With slow round trips the harness's own table writes (insert/patch/delete/expire) are queued and sent as one batch
 * just before the next read or store call, so the store under test still sees exactly the sequence of states.
 */
function bufferedDriver(driver: ScheduleDriver): ScheduleDriver {
  if (!driver.slowRoundTrips || !driver.runMany) return driver
  const queue: Array<{ sql: string; params: unknown[] }> = []
  // Concurrent callers all wait for the same in-flight batch.
  let inflight: Promise<void> = Promise.resolve()
  const flush = (): Promise<void> => {
    if (queue.length > 0) {
      const batch = queue.splice(0, queue.length)
      inflight = inflight.then(() => driver.runMany!(batch))
    }
    return inflight
  }
  const store = new Proxy(driver.store, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== "function") return value
      return async (...args: unknown[]) => { await flush(); return (value as (...a: unknown[]) => unknown).apply(target, args) }
    },
  })
  return { ...driver, store, run: async (sql, params) => { queue.push({ sql, params }) }, all: async (sql, params) => { await flush(); return driver.all(sql, params) }, runMany: async (statements) => { queue.push(...statements) } }
}

// ---------------------------------------------------------------------------------------------------------------------
// Reference store (from the contract and docs/spec/execution.md)

const T0 = Date.UTC(2031, 0, 1)
const DEAD_LEASE_AGE_MS = 3_600_000
const LEASE_TOLERANCE_MS = 5_000

export interface Claim {
  scheduleId: string
  scope: Scope
  executionScope: { kind: string; [key: string]: unknown }
  jobType: string
  jobVersion: number
  tenantId: string | null
  payload: string
  cronExpression: string
  timezone: string
  overlapPolicy: { type: string }
  misfirePolicy: { type: string }
  nextRunAt: number
  lastRunAt: number | null
  lastStatus: string | null
  lifecycle: Record<string, unknown>
}

type Settled<T> = { ok: T } | { error: string }
async function settle<T>(fn: () => Promise<T>): Promise<Settled<T>> {
  try { return { ok: await fn() } } catch (error) { return { error: error instanceof Error ? error.constructor.name : typeof error } }
}

export class ReferenceScheduleStore {
  readonly rows = new Map<string, RefRow>()
  private tokens = 0

  private live(row: RefRow): boolean {
    return row.leaseAt !== null && row.leaseAt > Date.now()
  }

  /** The rows claimDueSchedules may grant at `now`, oldest first (the lease-marker rule included). */
  eligible(now: number): RefRow[] {
    return [...this.rows.values()].filter((row) => {
      if (!row.enabled || row.paused || row.nextRunAt === null || row.nextRunAt > now) return false
      if (row.effectiveFrom !== null && row.effectiveFrom > now) return false
      if (row.effectiveUntil !== null && row.effectiveUntil <= now) return false
      if (row.remaining !== null && row.remaining <= 0) return false
      if (row.lastStatus === "failed" && row.leaseAt !== null && row.leaseAt > now) return false
      if (row.lastStatus === "running" && this.live(row)) return false
      return true
    }).sort((a, b) => a.nextRunAt! - b.nextRunAt!)
  }

  toClaim(row: RefRow, prior: string | null): Claim {
    return {
      scheduleId: row.id, scope: row.scope,
      executionScope: row.scope === "tenant" ? { kind: "tenant", tenantId: row.tenantId } : row.scope === "platform" ? { kind: "platform", platformKey: "default" } : { kind: "system", systemKey: "framework" },
      jobType: row.jobType, jobVersion: row.jobVersion, tenantId: row.tenantId, payload: row.payload, cronExpression: row.cronExpression,
      timezone: row.timezone, overlapPolicy: { type: row.overlapPolicy }, misfirePolicy: { type: row.misfirePolicy }, nextRunAt: row.nextRunAt!,
      lastRunAt: row.lastRunAt, lastStatus: prior,
      lifecycle: {
        paused: row.paused,
        ...(row.effectiveFrom === null ? {} : { effectiveFrom: new Date(row.effectiveFrom).toISOString() }),
        ...(row.effectiveUntil === null ? {} : { effectiveUntil: new Date(row.effectiveUntil).toISOString() }),
        ...(row.remaining === null ? {} : { remainingOccurrences: row.remaining }),
        ...(row.calendarKey === null ? {} : { calendarExclusionKey: row.calendarKey }),
        ...(row.owner === null ? {} : { owner: row.owner }),
        ...(row.description === null ? {} : { description: row.description }),
      },
    }
  }

  /** Marks `row` claimed and returns the claim (with the pre-claim status as lastStatus) and the reference token. */
  grant(row: RefRow, workerId: string, leaseMs: number): { claim: Claim; token: string } {
    const prior = row.lastStatus
    const token = `ref-token-${++this.tokens}`
    const claim = this.toClaim(row, prior)
    row.lastStatus = "running"
    row.leaseOwner = workerId
    row.claimToken = token
    row.leaseAt = Date.now() + leaseMs
    return { claim, token }
  }

  claim(args: { workerId: string; limit: number; now: number; leaseMs: number }): Array<{ claim: Claim; token: string }> {
    assertDurableIdentifier(args.workerId, "workerId", 100)
    return this.eligible(args.now).slice(0, args.limit).map((row) => this.grant(row, args.workerId, args.leaseMs))
  }

  private holds(scheduleId: string, workerId: string, token: string): RefRow | undefined {
    const row = this.rows.get(scheduleId)
    if (!row || row.lastStatus !== "running" || row.leaseOwner !== workerId || row.claimToken !== token || !this.live(row)) return undefined
    return row
  }

  advance(args: { scheduleId: string; workerId: string; token: string; nextRunAt: number | null; lastRunAt: number; lastStatus: string; lastError?: string; occurrencesFired?: number; retryAt?: number }): boolean {
    if (!args.token) return false
    const consumed = scheduleOccurrencesConsumed({ lastStatus: args.lastStatus, ...(args.occurrencesFired === undefined ? {} : { occurrencesFired: args.occurrencesFired }) })
    const row = this.holds(args.scheduleId, args.workerId, args.token)
    if (!row) return false
    row.nextRunAt = args.nextRunAt
    row.lastRunAt = args.lastRunAt
    row.lastStatus = args.lastStatus
    row.lastError = args.lastError ?? null
    row.leaseOwner = null
    row.claimToken = null
    row.leaseAt = args.lastStatus === "failed" && args.retryAt !== undefined ? args.retryAt : null
    if (row.remaining !== null) row.remaining = Math.max(row.remaining - consumed, 0)
    return true
  }

  release(args: { scheduleId: string; workerId: string; token: string }): boolean {
    if (!args.token) return false
    const row = this.holds(args.scheduleId, args.workerId, args.token)
    if (!row) return false
    row.lastStatus = "idle"
    row.leaseOwner = null
    row.claimToken = null
    row.leaseAt = null
    return true
  }

  renew(args: { scheduleId: string; workerId: string; token: string; extendByMs: number }): boolean {
    assertDurableIdentifier(args.workerId, "workerId", 100)
    if (!Number.isFinite(args.extendByMs) || args.extendByMs <= 0) return false
    const row = this.holds(args.scheduleId, args.workerId, args.token)
    if (!row) return false
    // The contract: a renewal moves the expiry monotonically forward, it never shortens a lease.
    row.leaseAt = Math.max(row.leaseAt!, Date.now() + args.extendByMs)
    return true
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Generated operations

type Variant = "valid" | "wrongWorker" | "longWorker" | "wrongToken" | "emptyToken" | "crossSchedule" | "missingSchedule"
const VARIANTS: readonly Variant[] = ["valid", "valid", "valid", "valid", "wrongWorker", "longWorker", "wrongToken", "emptyToken", "crossSchedule", "missingSchedule"]
const LONG_WORKER = "w".repeat(101)
const IDS = ["sched-a", "sched-b", "sched-c", "sched-d", "sched-e", "sched-f"] as const
const WORKERS = ["worker-1", "worker-2", "worker-3", "worker-4"] as const
const LEASES = [120_000, 600_000] as const
const EXTENSIONS = [1_000, 60_000, 300_000, 900_000, 0, -5, Number.NaN, Number.POSITIVE_INFINITY] as const
const STATUSES = ["fired", "fired", "skipped", "failed", "failed", "custom-status"] as const
const OCCURRENCES: ReadonlyArray<number | undefined> = [undefined, undefined, undefined, 0, 1, 2, 5, -1, 1.5]
const ERRORS: ReadonlyArray<string | undefined> = [undefined, undefined, "boom", "", `it's "quoted" \\ back\\slash\nline2`, `${"\u{1F600}".repeat(40)}${"x".repeat(900)}`]
const PAYLOADS = ['{}', '{"a":1}', '{"b":[1,2,{"c":"d"}],"a":"x"}', '{"note":"it\'s \\"quoted\\" \u00e9\u{1F600} \\u00e9"}'] as const

interface GrantRef { grant: number; other: number; variant: Variant }
type PatchOp =
  | { field: "paused" | "enabled"; value: boolean }
  | { field: "remaining"; value: number | null }
  | { field: "from" | "until"; value: number | null }
  | { field: "next"; value: number }
  | { field: "timezone"; value: string }
  | { field: "payload"; value: string }
  | { field: "calendar" | "owner" | "description"; value: string | null }
  | { field: "policy"; overlap: "allow" | "skip" | "queue"; misfire: "skip" | "fire_now" | "queue_all" }
interface AdvanceSpec { nextOff: number | null; lastRunOff: number; status: string; error: string | undefined; occurrences: number | undefined; retryOff: number | undefined }

export type Op =
  | { k: "insert"; id: string; scope: Scope; payload: string; cron: string; tz: string; overlap: RefRow["overlapPolicy"]; misfire: RefRow["misfirePolicy"]; enabled: boolean; paused: boolean; fromOff: number | null; untilOff: number | null; remaining: number | null; calendar: string | null; owner: string | null; description: string | null; nextOff: number; lastStatus: string | null; retryOff: number | null; lastRunOff: number | null; lastError: string | null }
  | { k: "patch"; id: string; patch: PatchOp }
  | { k: "delete"; id: string }
  | { k: "time"; ms: number }
  | { k: "expire"; id: string }
  | { k: "claim"; worker: string; limit: number; jitter: number; leaseMs: number }
  | { k: "claimRace"; workers: Array<{ worker: string; limit: number }>; jitter: number; leaseMs: number }
  | ({ k: "renew"; extendByMs: number } & GrantRef)
  | ({ k: "advance"; spec: AdvanceSpec } & GrantRef)
  | ({ k: "release" } & GrantRef)
  | ({ k: "settleRace"; first: AdvanceSpec; second: AdvanceSpec; extendByMs: number } & GrantRef)
  | ({ k: "staleRace"; worker: string; limit: number; spec: AdvanceSpec } & GrantRef)

function genAdvance(rng: Rng, nullable: boolean): AdvanceSpec {
  const status = rng.pick(STATUSES)
  return {
    nextOff: nullable && rng.bool(0.1) ? null : rng.int(13) - 3,
    lastRunOff: rng.int(9) - 4,
    status,
    error: rng.pick(ERRORS),
    occurrences: rng.pick(OCCURRENCES),
    retryOff: rng.bool(status === "failed" ? 0.8 : 0.2) ? rng.int(9) - 3 : undefined,
  }
}

function genRef(rng: Rng): GrantRef {
  return { grant: rng.int(1_000), other: rng.int(1_000), variant: rng.pick(VARIANTS) }
}

function genInsert(rng: Rng, id: string): Op {
  const lastStatus = rng.pick([null, "idle", "fired", "skipped", "failed", "failed", "running"] as const)
  return {
    k: "insert", id, scope: rng.pick(["tenant", "platform", "system"] as const), payload: rng.pick(PAYLOADS),
    cron: rng.pick(["*/5 * * * *", "0 * * * *", "0 0 1 1 *"]), tz: rng.pick(["UTC", "Europe/Berlin", "America/New_York"]),
    overlap: rng.pick(["allow", "skip", "queue"] as const), misfire: rng.pick(["skip", "fire_now", "queue_all"] as const),
    enabled: rng.bool(0.9), paused: rng.bool(0.12),
    fromOff: rng.bool(0.25) ? rng.int(9) - 5 : null, untilOff: rng.bool(0.25) ? rng.int(9) - 2 : null,
    remaining: rng.bool(0.4) ? rng.pick([0, 1, 1, 2, 3, 5]) : null,
    calendar: rng.bool(0.2) ? "holidays" : null, owner: rng.bool(0.3) ? "team-ops" : null, description: rng.bool(0.3) ? "nightly \"sync\" é\u{1F600}" : null,
    nextOff: rng.int(9) - 6, lastStatus, retryOff: rng.bool(0.7) ? rng.int(9) - 4 : null,
    lastRunOff: rng.bool(0.5) ? rng.int(9) - 8 : null, lastError: lastStatus === "failed" && rng.bool(0.7) ? "earlier failure" : null,
  }
}

function genPatch(rng: Rng): PatchOp {
  switch (rng.int(9)) {
    case 0: return { field: "paused", value: rng.bool(0.5) }
    case 1: return { field: "enabled", value: rng.bool(0.7) }
    case 2: return { field: "remaining", value: rng.bool(0.3) ? null : rng.pick([0, 1, 2, 3]) }
    case 3: return { field: "from", value: rng.bool(0.3) ? null : rng.int(9) - 5 }
    case 4: return { field: "until", value: rng.bool(0.3) ? null : rng.int(9) - 2 }
    case 5: return { field: "next", value: rng.int(11) - 7 }
    case 6: return rng.bool(0.5) ? { field: "timezone", value: rng.pick(["UTC", "Asia/Tokyo"]) } : { field: "payload", value: rng.pick(PAYLOADS) }
    case 7: return { field: rng.pick(["calendar", "owner", "description"] as const), value: rng.bool(0.5) ? null : "changed" }
    default: return { field: "policy", overlap: rng.pick(["allow", "skip", "queue"] as const), misfire: rng.pick(["skip", "fire_now", "queue_all"] as const) }
  }
}

export function generateOps(rng: Rng, nullable: boolean, count: number): Op[] {
  const ops: Op[] = []
  const seeded = 3 + rng.int(3)
  for (let index = 0; index < seeded; index++) ops.push(genInsert(rng, IDS[index]!))
  while (ops.length < count) {
    const roll = rng.int(100)
    const id = rng.pick(IDS)
    if (roll < 24) ops.push({ k: "claim", worker: rng.bool(0.04) ? LONG_WORKER : rng.pick(WORKERS), limit: rng.pick([0, 1, 1, 2, 3, 100]), jitter: rng.pick([0, 0, 0, -1, 1, 500]), leaseMs: rng.pick(LEASES) })
    else if (roll < 38) ops.push({ k: "advance", spec: genAdvance(rng, nullable), ...genRef(rng) })
    else if (roll < 43) ops.push({ k: "release", ...genRef(rng) })
    else if (roll < 51) ops.push({ k: "renew", extendByMs: rng.pick(EXTENSIONS), ...genRef(rng) })
    else if (roll < 58) ops.push(genInsert(rng, id))
    else if (roll < 70) ops.push({ k: "patch", id, patch: genPatch(rng) })
    else if (roll < 73) ops.push({ k: "delete", id })
    else if (roll < 79) ops.push({ k: "expire", id })
    else if (roll < 85) ops.push({ k: "time", ms: 1_000 * (1 + rng.int(4)) })
    else if (roll < 91) ops.push({ k: "claimRace", workers: rng.shuffle(WORKERS).slice(0, 2 + rng.int(3)).map((worker) => ({ worker, limit: rng.pick([1, 2, 3, 100]) })), jitter: rng.pick([0, 0, 500]), leaseMs: rng.pick(LEASES) })
    else if (roll < 96) ops.push({ k: "settleRace", first: genAdvance(rng, nullable), second: genAdvance(rng, nullable), extendByMs: rng.pick([60_000, 900_000]), ...genRef(rng) })
    else ops.push({ k: "staleRace", worker: rng.pick(WORKERS), limit: rng.pick([1, 3, 100]), spec: genAdvance(rng, nullable), ...genRef(rng) })
  }
  return ops
}

// ---------------------------------------------------------------------------------------------------------------------
// Executor

interface Grant { scheduleId: string; workerId: string; ref: string; real: string }

interface AdvanceMs { nextRunAt: number | null; lastRunAt: number; lastStatus: string; lastError?: string; occurrencesFired?: number; retryAt?: number }
function storeArgs(args: AdvanceMs) {
  return {
    nextRunAt: args.nextRunAt === null ? null : new Date(args.nextRunAt), lastRunAt: new Date(args.lastRunAt), lastStatus: args.lastStatus,
    ...(args.lastError === undefined ? {} : { lastError: args.lastError }),
    ...(args.occurrencesFired === undefined ? {} : { occurrencesFired: args.occurrencesFired }),
    ...(args.retryAt === undefined ? {} : { retryAt: new Date(args.retryAt) }),
  }
}

class Run {
  readonly ref = new ReferenceScheduleStore()
  readonly grants: Grant[] = []
  readonly seenTokens = new Set<string>()
  cursor = T0
  private lastNow = T0

  constructor(readonly driver: ScheduleDriver, readonly store: ScheduleStore) {}

  unique(ms: number, exceptId: string): number {
    let candidate = ms
    while ([...this.ref.rows.values()].some((row) => row.id !== exceptId && row.nextRunAt === candidate)) candidate += 1
    return candidate
  }

  // ---- definition changes (applied to the table and to the reference) ----

  async insert(op: Extract<Op, { k: "insert" }>): Promise<void> {
    const running = op.lastStatus === "running"
    const row: RefRow = {
      id: op.id, scope: op.scope, tenantId: op.scope === "tenant" ? `tenant-${op.id}` : null, jobType: `job.${op.id}`, jobVersion: 1,
      payload: op.payload, cronExpression: op.cron, timezone: op.tz, enabled: op.enabled, paused: op.paused, overlapPolicy: op.overlap, misfirePolicy: op.misfire,
      nextRunAt: this.unique(this.cursor + op.nextOff * 1_000, op.id), lastRunAt: op.lastRunOff === null ? null : this.cursor + op.lastRunOff * 1_000,
      lastStatus: op.lastStatus, lastError: op.lastError,
      // A crashed worker's marker: running, its owner and token, a lease that has run out. A failed row keeps its retry time in the lease column.
      leaseOwner: running ? "ghost-worker" : null, claimToken: running ? "ghost-token" : null,
      leaseAt: running ? Date.now() - DEAD_LEASE_AGE_MS : op.lastStatus === "failed" && op.retryOff !== null ? this.cursor + op.retryOff * 1_000 : null,
      effectiveFrom: op.fromOff === null ? null : this.cursor + op.fromOff * 1_000, effectiveUntil: op.untilOff === null ? null : this.cursor + op.untilOff * 1_000,
      remaining: op.remaining, calendarKey: op.calendar, owner: op.owner, description: op.description,
    }
    if (this.ref.rows.has(op.id)) await deleteRow(this.driver, op.id)
    await insertRow(this.driver, row)
    this.ref.rows.set(op.id, row)
  }

  async patch(op: Extract<Op, { k: "patch" }>): Promise<void> {
    const row = this.ref.rows.get(op.id)
    if (!row) { await updateRow(this.driver, op.id, { jobType: "ignored" }); return }
    const p = op.patch
    const fields: Partial<RefRow> = {}
    switch (p.field) {
      case "paused": fields.paused = p.value; break
      case "enabled": fields.enabled = p.value; break
      case "remaining": fields.remaining = p.value; break
      case "from": fields.effectiveFrom = p.value === null ? null : this.cursor + p.value * 1_000; break
      case "until": fields.effectiveUntil = p.value === null ? null : this.cursor + p.value * 1_000; break
      case "next": fields.nextRunAt = this.unique(this.cursor + p.value * 1_000, op.id); break
      case "timezone": fields.timezone = p.value; break
      case "payload": fields.payload = p.value; break
      case "calendar": fields.calendarKey = p.value; break
      case "owner": fields.owner = p.value; break
      case "description": fields.description = p.value; break
      case "policy": fields.overlapPolicy = p.overlap; fields.misfirePolicy = p.misfire; break
    }
    await updateRow(this.driver, op.id, fields)
    Object.assign(row, fields)
  }

  async remove(id: string): Promise<void> {
    await deleteRow(this.driver, id)
    this.ref.rows.delete(id)
  }

  async expire(id: string): Promise<void> {
    const row = this.ref.rows.get(id)
    if (!row || row.lastStatus !== "running") return
    const leaseAt = Date.now() - DEAD_LEASE_AGE_MS
    await updateRow(this.driver, id, { leaseAt })
    row.leaseAt = leaseAt
  }

  // ---- claim bookkeeping ----

  private compareClaims(real: FencedScheduleClaim[], expected: Claim[], context: string): void {
    expect(real.map((claim) => normalizeClaim(claim, this.driver)), `${context}: claims`).toEqual(expected.map((claim) => normalizeClaim(claim, this.driver)))
    for (const claim of real) {
      expect(typeof claim.claimToken === "string" && claim.claimToken.length > 0, `${context}: claimToken is a non-empty string`).toBe(true)
      expect(this.seenTokens.has(claim.claimToken), `${context}: claimToken ${claim.claimToken} is fresh`).toBe(false)
      this.seenTokens.add(claim.claimToken)
    }
  }

  private now(jitter: number): number {
    this.lastNow = this.cursor + jitter
    return this.lastNow
  }

  async claim(op: Extract<Op, { k: "claim" }>): Promise<void> {
    const now = this.now(op.jitter)
    const args = { workerId: op.worker, limit: op.limit, now: new Date(now), leaseDurationMs: op.leaseMs }
    const expected = await settle(async () => this.ref.claim({ workerId: op.worker, limit: op.limit, now, leaseMs: op.leaseMs }))
    const real = await settle(() => this.store.claimDueSchedules(args))
    if ("error" in expected || "error" in real) { expect(real).toEqual(expected); return }
    this.compareClaims(real.ok, expected.ok.map((entry) => entry.claim), "claimDueSchedules")
    real.ok.forEach((claim, index) => this.grants.push({ scheduleId: claim.scheduleId, workerId: op.worker, ref: expected.ok[index]!.token, real: claim.claimToken }))
  }

  private target(op: GrantRef): { scheduleId: string; workerId: string; ref: string; real: string; valid: boolean } {
    if (this.grants.length === 0) return { scheduleId: IDS[0], workerId: WORKERS[0], ref: "no-such-token", real: "no-such-token", valid: false }
    const grant = this.grants[op.grant % this.grants.length]!
    const other = this.grants[op.other % this.grants.length]!
    switch (op.variant) {
      case "wrongWorker": return { ...grant, workerId: grant.workerId === WORKERS[3] ? WORKERS[2] : WORKERS[3], valid: false }
      case "longWorker": return { ...grant, workerId: LONG_WORKER, valid: false }
      case "wrongToken": return { ...grant, ref: "bogus-token", real: "bogus-token", valid: false }
      case "emptyToken": return { ...grant, ref: "", real: "", valid: false }
      case "crossSchedule": return { ...grant, scheduleId: other.scheduleId, valid: false }
      case "missingSchedule": return { ...grant, scheduleId: "no-such-schedule", valid: false }
      default: return { ...grant, valid: true }
    }
  }

  /** Advance arguments in epoch ms; nextRunAt values are made unique per row so that claim ordering is fully determined. */
  private advanceUnique(spec: AdvanceSpec, scheduleId: string): AdvanceMs {
    return {
      nextRunAt: spec.nextOff === null ? null : this.unique(this.cursor + spec.nextOff * 1_000, scheduleId), lastRunAt: this.cursor + spec.lastRunOff * 1_000, lastStatus: spec.status,
      ...(spec.error === undefined ? {} : { lastError: spec.error }),
      ...(spec.occurrences === undefined ? {} : { occurrencesFired: spec.occurrences }),
      ...(spec.retryOff === undefined ? {} : { retryAt: this.cursor + spec.retryOff * 1_000 }),
    }
  }

  async advance(op: Extract<Op, { k: "advance" }>): Promise<void> {
    const t = this.target(op)
    const args = this.advanceUnique(op.spec, t.scheduleId)
    const expected = await settle(async () => this.ref.advance({ scheduleId: t.scheduleId, workerId: t.workerId, token: t.ref, ...args }))
    const real = await settle(() => this.store.advanceSchedule({ scheduleId: t.scheduleId, workerId: t.workerId, claimToken: t.real, ...storeArgs(args) }))
    expect(real, `advanceSchedule(${op.variant})`).toEqual(expected)
  }

  async release(op: Extract<Op, { k: "release" }>): Promise<void> {
    const t = this.target(op)
    const expected = await settle(async () => this.ref.release({ scheduleId: t.scheduleId, workerId: t.workerId, token: t.ref }))
    const real = await settle(() => this.store.releaseSchedule({ scheduleId: t.scheduleId, workerId: t.workerId, claimToken: t.real }))
    expect(real, `releaseSchedule(${op.variant})`).toEqual(expected)
  }

  async renew(op: Extract<Op, { k: "renew" }>): Promise<void> {
    const t = this.target(op)
    const expected = await settle(async () => this.ref.renew({ scheduleId: t.scheduleId, workerId: t.workerId, token: t.ref, extendByMs: op.extendByMs }))
    const real = await settle(() => this.store.renewScheduleLease({ scheduleId: t.scheduleId, workerId: t.workerId, claimToken: t.real, now: new Date(), extendByMs: op.extendByMs }))
    expect(real, `renewScheduleLease(${op.variant}, ${String(op.extendByMs)})`).toEqual(expected)
  }

  // ---- concurrency ----

  async claimRace(op: Extract<Op, { k: "claimRace" }>): Promise<void> {
    const now = this.now(op.jitter)
    const eligible = this.ref.eligible(now)
    const eligibleIds = new Set(eligible.map((row) => row.id))
    const results = await Promise.all(op.workers.map(({ worker, limit }) => this.store.claimDueSchedules({ workerId: worker, limit, now: new Date(now), leaseDurationMs: op.leaseMs })))
    const owner = new Map<string, string>()
    let granted = 0
    results.forEach((claims, index) => {
      const { worker, limit } = op.workers[index]!
      expect(claims.length, `claimRace: ${worker} never exceeds its limit ${limit}`).toBeLessThanOrEqual(limit)
      expect(claims.map((claim) => claim.nextRunAt.getTime()), `claimRace: ${worker} receives its claims oldest first`).toEqual(claims.map((claim) => claim.nextRunAt.getTime()).sort((a, b) => a - b))
      for (const claim of claims) {
        granted += 1
        expect(eligibleIds.has(claim.scheduleId), `claimRace: ${claim.scheduleId} was claimable`).toBe(true)
        expect(owner.has(claim.scheduleId), `claimRace: ${claim.scheduleId} is held by two live claims (${owner.get(claim.scheduleId)} and ${worker})`).toBe(false)
        owner.set(claim.scheduleId, worker)
      }
    })
    if (eligible.length > 0 && op.workers.some(({ limit }) => limit >= 1)) expect(granted, "claimRace: at least one worker wins a due schedule").toBeGreaterThanOrEqual(1)
    // Adopt the real outcome into the reference: each claim must carry the reference's view of its schedule.
    for (const [index, claims] of results.entries()) this.adopt(claims, op.workers[index]!.worker, op.leaseMs, `claimRace ${op.workers[index]!.worker}`)
  }

  private adopt(claims: FencedScheduleClaim[], worker: string, leaseMs: number, context: string): void {
    for (const claim of claims) {
      const row = this.ref.rows.get(claim.scheduleId)!
      this.compareClaims([claim], [this.ref.toClaim(row, row.lastStatus)], context)
      const { token } = this.ref.grant(row, worker, leaseMs)
      this.grants.push({ scheduleId: row.id, workerId: worker, ref: token, real: claim.claimToken })
    }
  }

  async settleRace(op: Extract<Op, { k: "settleRace" }>): Promise<void> {
    const t = this.target(op)
    const held = this.ref.rows.get(t.scheduleId)
    const live = held !== undefined && held.lastStatus === "running" && held.leaseOwner === t.workerId && held.claimToken === t.ref && held.leaseAt! > Date.now()
    const a = this.advanceUnique(op.first, t.scheduleId)
    const b = this.advanceUnique(op.second, t.scheduleId)
    if (b.nextRunAt !== null && b.nextRunAt === a.nextRunAt) b.nextRunAt += 1
    const fence = { scheduleId: t.scheduleId, workerId: t.workerId, claimToken: t.real }
    const [first, second, released, renewed] = await Promise.all([
      settle(() => this.store.advanceSchedule({ ...fence, ...storeArgs(a) })),
      settle(() => this.store.advanceSchedule({ ...fence, ...storeArgs(b) })),
      settle(() => this.store.releaseSchedule(fence)),
      settle(() => this.store.renewScheduleLease({ ...fence, now: new Date(), extendByMs: op.extendByMs })),
    ])
    const winners: string[] = []
    for (const [name, outcome] of [["first", first], ["second", second], ["released", released]] as const) {
      // An invalid occurrencesFired is rejected by that advance alone; the others still settle the claim.
      if ("error" in outcome) expect(outcome.error, `settleRace: ${name}`).toBe("ConfigurationError")
      else if (outcome.ok) winners.push(name)
    }
    expect(winners.length, `settleRace(${op.variant}): exactly one of advance/advance/release settles a live claim, none a stale one (winners: ${winners.join(",")})`).toBe(live ? 1 : 0)
    if ("error" in renewed) expect(renewed.error).toBe("TenantScopeViolationError")
    else if (!live) expect(renewed.ok, "settleRace: a stale claim is never renewed").toBe(false)
    const ref = { scheduleId: t.scheduleId, workerId: t.workerId, token: t.ref }
    if (winners[0] === "first") this.ref.advance({ ...ref, ...a })
    else if (winners[0] === "second") this.ref.advance({ ...ref, ...b })
    else if (winners[0] === "released") this.ref.release(ref)
  }

  async staleRace(op: Extract<Op, { k: "staleRace" }>): Promise<void> {
    // The lease of the targeted claim runs out, then its (former) owner races a new claimant: whatever the interleaving,
    // the old token can no longer renew, release or advance, and the claimant succeeds exactly as the reference says.
    const t = this.target({ ...op, variant: "valid" })
    if (this.grants.length > 0) await this.expire(t.scheduleId)
    const still = this.ref.rows.get(t.scheduleId)
    const oldTokenStillLive = !!still && still.lastStatus === "running" && still.claimToken === t.ref && still.leaseAt! > Date.now()
    const now = this.now(0)
    const a = this.advanceUnique(op.spec, t.scheduleId)
    const candidates = this.ref.eligible(now)
    const [advanced, renewed, released, claimed] = await Promise.all([
      settle(() => this.store.advanceSchedule({ scheduleId: t.scheduleId, workerId: t.workerId, claimToken: t.real, ...storeArgs(a) })),
      settle(() => this.store.renewScheduleLease({ scheduleId: t.scheduleId, workerId: t.workerId, claimToken: t.real, now: new Date(), extendByMs: 60_000 })),
      settle(() => this.store.releaseSchedule({ scheduleId: t.scheduleId, workerId: t.workerId, claimToken: t.real })),
      settle(() => this.store.claimDueSchedules({ workerId: op.worker, limit: op.limit, now: new Date(now), leaseDurationMs: 600_000 })),
    ])
    expect(oldTokenStillLive, "staleRace: lease was expired").toBe(false)
    if ("error" in advanced) expect(advanced.error).toBe("ConfigurationError")
    else expect(advanced.ok, "staleRace: an expired claim cannot advance").toBe(false)
    expect(renewed, "staleRace: an expired claim cannot renew").toEqual({ ok: false })
    expect(released, "staleRace: an expired claim cannot release").toEqual({ ok: false })
    if ("error" in claimed) throw new Error(`staleRace: claim threw ${claimed.error}`)
    const ids = claimed.ok.map((claim) => claim.scheduleId)
    if (this.driver.label === "mysql") {
      // FOR UPDATE SKIP LOCKED skips a row that a concurrent (fenced-out) write currently has locked, so the claim may miss it this tick.
      expect(ids.every((id) => candidates.some((row) => row.id === id)), "staleRace: only claimable schedules are claimed").toBe(true)
      expect(ids.length).toBeLessThanOrEqual(op.limit)
    } else {
      expect(ids, "staleRace: the claimant receives exactly the claimable schedules").toEqual(candidates.slice(0, op.limit).map((row) => row.id))
    }
    this.adopt(claimed.ok, op.worker, 600_000, "staleRace claim")
  }

  async compareState(context: string): Promise<void> {
    const real = await readRows(this.driver)
    expect([...real.keys()].sort(), `${context}: schedule ids`).toEqual([...this.ref.rows.keys()].sort())
    for (const [id, expected] of this.ref.rows) {
      const actual = real.get(id)!
      const lease = leaseExpectation(expected, actual)
      // Tokens are opaque and differ per store: compare them through the grant that issued them.
      const token = actual.claimToken === null ? null : this.grants.find((grant) => grant.real === actual.claimToken)?.ref ?? actual.claimToken
      const wanted: Record<string, unknown> = normalizeRow({ ...expected, leaseAt: lease }, this.driver)
      const got: Record<string, unknown> = normalizeRow({ ...actual, claimToken: token }, this.driver)
      const differing = Object.keys(wanted).filter((key) => JSON.stringify(wanted[key]) !== JSON.stringify(got[key]))
      if (differing.length > 0) throw new Error(`${context}: row ${id} differs from the reference in ${differing.map((key) => `${key}: store=${JSON.stringify(got[key])} reference=${JSON.stringify(wanted[key])}`).join("; ")}`)
    }
  }
}

function leaseExpectation(expected: RefRow, actual: RefRow): number | null {
  // A live lease is compared with tolerance (database clock); everything else (none, back-dated, retryAt) exactly.
  if (expected.lastStatus === "running" && expected.leaseAt !== null && expected.leaseAt > Date.now() && actual.leaseAt !== null && Math.abs(actual.leaseAt - expected.leaseAt) <= LEASE_TOLERANCE_MS) return actual.leaseAt
  return expected.leaseAt
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, sortKeys(item)]))
  return value
}

/** JSON payloads compare by value (MySQL's JSON type re-serializes them, with keys reordered). */
function normalizePayload(text: unknown): unknown {
  try { return sortKeys(JSON.parse(String(text))) } catch { return text }
}

function normalizeRow(row: RefRow, driver: ScheduleDriver) {
  // MySQL stores payload as JSON (re-serialized); the text-column stores must return it byte for byte.
  return { ...row, payload: normalizePayload(row.payload), payloadText: driver.label === "mysql" ? null : row.payload }
}

function normalizeClaim(claim: Claim | FencedScheduleClaim, driver: ScheduleDriver) {
  const c = claim as Claim | FencedScheduleClaim
  const time = (value: Date | number | null): number | null => (value === null ? null : value instanceof Date ? value.getTime() : value)
  return {
    scheduleId: c.scheduleId, scope: c.scope, executionScope: c.executionScope, jobType: c.jobType, jobVersion: c.jobVersion, tenantId: c.tenantId,
    payload: normalizePayload(c.payload), payloadText: driver.label === "mysql" ? null : c.payload,
    cronExpression: c.cronExpression, timezone: c.timezone, overlapPolicy: c.overlapPolicy, misfirePolicy: c.misfirePolicy,
    nextRunAt: time(c.nextRunAt), lastRunAt: time(c.lastRunAt), lastStatus: c.lastStatus, lifecycle: c.lifecycle,
  }
}

function brief(op: Op): string {
  return JSON.stringify(op, (_key, value: unknown) => (typeof value === "string" && value.length > 40 ? `${value.slice(0, 12)}...(${value.length})` : value))
}

async function execute(run: Run, ops: Op[]): Promise<void> {
  const every = run.driver.slowRoundTrips ? 4 : 1
  for (const [index, op] of ops.entries()) {
    try {
      switch (op.k) {
        case "insert": await run.insert(op); break
        case "patch": await run.patch(op); break
        case "delete": await run.remove(op.id); break
        case "time": run.cursor += op.ms; break
        case "expire": await run.expire(op.id); break
        case "claim": await run.claim(op); break
        case "claimRace": await run.claimRace(op); break
        case "renew": await run.renew(op); break
        case "advance": await run.advance(op); break
        case "release": await run.release(op); break
        case "settleRace": await run.settleRace(op); break
        case "staleRace": await run.staleRace(op); break
      }
      if ((index + 1) % every === 0 || index === ops.length - 1 || (every === 1 && op.k === "claimRace")) await run.compareState(`after step ${index} (${op.k})`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`step ${index} ${brief(op)}\n${message}`)
    }
  }
}

function shrinkOps(ops: Op[]): Iterable<Op[]> {
  const out: Op[][] = []
  for (let size = Math.floor(ops.length / 2); size >= 1; size = Math.floor(size / 2)) out.push(ops.slice(0, ops.length - size))
  for (let index = ops.length - 1; index >= 0; index--) out.push([...ops.slice(0, index), ...ops.slice(index + 1)])
  return out
}

/**
 * Random definition/claim/renew/advance/release sequences against the real store, compared with the reference after
 * every step (return values and every row). Clears the table before each case.
 */
export async function assertScheduleStoreMatchesReference(driver: ScheduleDriver, baseRuns = 50, opsPerRun = driver.slowRoundTrips ? 14 : 28): Promise<void> {
  await forAllAsync(
    `real-database schedule store lifecycle differential (${driver.label})`,
    (rng) => generateOps(rng, driver.nullableNextRunAt, opsPerRun),
    async (ops) => {
      await clearRows(driver)
      const buffered = bufferedDriver(driver)
      await execute(new Run(buffered, buffered.store), ops)
    },
    { runs: baseRuns, shrink: shrinkOps, describe: (ops) => ops.map((op, index) => `${index}: ${brief(op)}`).join("\n"), maxShrinkSteps: 40 },
  )
  await clearRows(driver)
}

// ---------------------------------------------------------------------------------------------------------------------
// Concurrency invariants

/**
 * Many workers claim, renew and settle the same due schedules concurrently (Promise.all, repeated rounds). Invariants:
 * a schedule is never held by two live claims, every grant carries the pre-claim status and a fresh token, a stale
 * token never advances or renews, remainingOccurrences never goes negative and is decremented exactly once per settled
 * claim, and no due schedule is lost.
 */
export async function assertConcurrentClaimInvariants(driver: ScheduleDriver, baseRuns = 50): Promise<void> {
  await forAllAsync(
    `real-database schedule store concurrent claims (${driver.label})`,
    (rng) => ({
      schedules: driver.slowRoundTrips ? 3 : 3 + rng.int(6),
      rounds: driver.slowRoundTrips ? 2 : 4 + rng.int(3),
      workers: driver.slowRoundTrips ? 2 : 2 + rng.int(3),
      remaining: Array.from({ length: 8 }, () => (rng.bool(0.5) ? 1 + rng.int(3) : null)),
      limits: Array.from({ length: 6 }, () => rng.pick([1, 2, 4, 100])),
      settle: Array.from({ length: 64 }, () => rng.pick(["advance", "advance", "fail", "release", "leave"] as const)),
    }),
    async (c) => {
      await clearRows(driver)
      const buffered = bufferedDriver(driver)
      const run = new Run(buffered, buffered.store)
      for (let index = 0; index < c.schedules; index++) {
        await run.insert({ k: "insert", id: `conc-${index}`, scope: "system", payload: "{}", cron: "*/5 * * * *", tz: "UTC", overlap: "allow", misfire: "fire_now", enabled: true, paused: false, fromOff: null, untilOff: null, remaining: c.remaining[index] ?? null, calendar: null, owner: null, description: null, nextOff: -1 - index, lastStatus: null, retryOff: null, lastRunOff: null, lastError: null })
      }
      let pick = 0
      for (let round = 0; round < c.rounds; round++) {
        run.cursor += 10_000
        const now = new Date(run.cursor)
        const before = new Map([...run.ref.rows].map(([id, row]) => [id, { ...row }]))
        const due = [...before.values()].filter((row) => row.nextRunAt !== null && row.nextRunAt <= run.cursor && (row.remaining === null || row.remaining > 0) && !(row.lastStatus === "failed" && row.leaseAt !== null && row.leaseAt > run.cursor) && !(row.lastStatus === "running" && row.leaseAt! > Date.now()))
        const results = await Promise.all(Array.from({ length: c.workers }, (_, w) => buffered.store.claimDueSchedules({ workerId: `cw-${w}`, limit: c.limits[(round + w) % c.limits.length]!, now, leaseDurationMs: 300_000 })))
        const seen = new Map<string, string>()
        const tokens = new Set<string>()
        results.forEach((claims, w) => {
          for (const claim of claims) {
            expect(seen.has(claim.scheduleId), `round ${round}: ${claim.scheduleId} granted to cw-${seen.get(claim.scheduleId)} and cw-${w} at once`).toBe(false)
            seen.set(claim.scheduleId, String(w))
            expect(tokens.has(claim.claimToken), "claim tokens are unique").toBe(false)
            tokens.add(claim.claimToken)
            const row = before.get(claim.scheduleId)!
            expect(claim.lastStatus, `${claim.scheduleId}: claim returns the pre-claim status`).toBe(row.lastStatus)
            expect(claim.nextRunAt.getTime()).toBe(row.nextRunAt)
          }
        })
        if (due.length > 0) expect(seen.size, `round ${round}: a due schedule is claimed by someone`).toBeGreaterThanOrEqual(1)
        const held = await readRows(buffered)
        for (const [id, w] of seen) {
          const row = held.get(id)!
          expect(row.lastStatus).toBe("running")
          expect(row.leaseOwner).toBe(`cw-${w}`)
          expect(row.leaseAt!).toBeGreaterThan(Date.now())
        }
        // Everyone settles (or abandons) their claims concurrently, while stale holders try the same.
        const settlements: Array<Promise<{ id: string; w: string; kind: string; ok: boolean[] }>> = []
        results.forEach((claims, w) => {
          for (const claim of claims) {
            const kind = c.settle[pick++ % c.settle.length]!
            const common = { scheduleId: claim.scheduleId, workerId: `cw-${w}`, claimToken: claim.claimToken }
            const adv = { nextRunAt: new Date(run.cursor + 5_000 + pick), lastRunAt: now, lastStatus: kind === "fail" ? "failed" : "fired", ...(kind === "fail" ? { lastError: "boom", retryAt: new Date(run.cursor + 5_000) } : {}) }
            settlements.push((async () => {
              const ok = await Promise.all([
                kind === "advance" || kind === "fail" ? buffered.store.advanceSchedule({ ...common, ...adv }) : kind === "release" ? buffered.store.releaseSchedule(common) : Promise.resolve(true),
                buffered.store.advanceSchedule({ ...common, workerId: `cw-${(w + 1) % c.workers}`, ...adv }),
                buffered.store.renewScheduleLease({ ...common, now, extendByMs: 60_000 }),
              ])
              return { id: claim.scheduleId, w: String(w), kind, ok }
            })())
          }
        })
        const settled = await Promise.all(settlements)
        const after = await readRows(buffered)
        for (const [id, row] of after) run.ref.rows.set(id, row)
        for (const { id, kind, ok } of settled) {
          const row = after.get(id)!
          const prior = before.get(id)!
          // Another worker can never advance this worker's claim.
          if (c.workers > 1) expect(ok[1], `${id}: a foreign worker advanced a claim`).toBe(false)
          if (kind === "advance" || kind === "fail" || kind === "release") expect(ok[0], `${id}: the owner settles its live claim`).toBe(true)
          if (kind === "advance" || kind === "fail") {
            expect(row.lastStatus).toBe(kind === "fail" ? "failed" : "fired")
            if (prior.remaining !== null) expect(row.remaining, `${id}: remaining decremented by exactly one fired occurrence`).toBe(kind === "fail" ? prior.remaining : prior.remaining - 1)
            expect(row.leaseOwner).toBeNull()
          }
          if (row.remaining !== null) expect(row.remaining, `${id}: remainingOccurrences never negative`).toBeGreaterThanOrEqual(0)
        }
      }
    },
    { runs: baseRuns, describe: (c) => JSON.stringify({ ...c, settle: c.settle.slice(0, 8) }) },
  )
  await clearRows(driver)
}

