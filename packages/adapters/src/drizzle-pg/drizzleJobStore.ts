import { and, desc, eq, getTableColumns, gt, inArray, isNull, lte, lt, ne, or, sql, asc, type AnyColumn, type SQL } from "drizzle-orm"
import { ConfigurationError, ConflictError } from "@xonava/core/domain"
import type { AnyPgTable } from "drizzle-orm/pg-core"
import type {
  JobStore,
  ClaimDueJobsArgs,
  RenewLeaseArgs,
  CompleteJobArgs,
  RetryJobArgs,
  FailJobArgs, ReleaseJobArgs,
  CancelJobArgs,
  GetJobByIdArgs,
  GetByCorrelationIdArgs,
  GetLatestPriorScheduleExecutionArgs,
  GetByIdempotencyKeyArgs,
  FindPendingArgs,
  EnqueueJobArgs,
  StoredJob,
  JobTransitionResult,
} from "@xonava/core/execution"
import { assertRequesterCanEnqueueScope, assertJobScopeCanEnqueue, assertDurableJob, assertDurableIdentifier, requesterJobScope, requesterTenantId, scheduleCorrelationId, CorruptJobMetadataError, JobIdempotencyConflictError } from "@xonava/core/execution"
import { buildJobFingerprintInput, decodeStoredJobMaxAttempts, encodeStoredJobMaxAttempts, fingerprintJob, jobFingerprintMatches } from "@xonava/core/execution"
import { decodePersistedJobFingerprint, decodePersistedJobScope, encodeJobScope } from "../drizzle-shared/jobScope"
import { uuidv7 } from "uuidv7"
import type { DrizzleColumnMap } from "../drizzle-shared/predicateCompiler"
import type { DrizzleSessionLike } from "./drizzleRepository"
import { getAffectedRows } from "./pgUtils"
import { normalizeDrizzleError, rethrowNormalizedDrizzleError } from "../drizzle-shared/errors"

export interface DrizzleJobStoreConfig {
  jobsTable: AnyPgTable
  executionsTable: AnyPgTable
  executionHistory?: "best_effort" | "required"
  columnMap: {
    jobs: DrizzleColumnMap
    executions: DrizzleColumnMap
  }
}

function parseMetadata(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== "string") throw new CorruptJobMetadataError("Job metadata must be a JSON object")
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("metadata must be a JSON object")
    return parsed as Record<string, unknown>
  } catch (error) { throw new CorruptJobMetadataError("Job metadata is not valid JSON", { cause: error }) }
}

function buildIdempotencyScope(tenantId: string | null | undefined, scope: string): string {
  return tenantId ? `tenant:${tenantId}` : scope
}

/**
 * PostgreSQL text cannot hold U+0000 (the write fails with 22021), so a failure message that contains one would make
 * the transition throw and leave the job to be reclaimed after its lease. Replace it with U+FFFD like an invalid byte.
 */
function pgText(value: string): string {
  return value.includes("\u0000") ? value.replaceAll("\u0000", "\uFFFD") : value
}

/** Stable, sanitized reason recorded when a final attempt's lease expires. */
export const LEASE_EXPIRED_ON_FINAL_ATTEMPT = "Lease expired on final attempt"

/** Reports a history failure by framework error code only; provider messages and SQL never escape. */
function historyFailure(error: unknown): JobTransitionResult {
  return { applied: false, reason: "HISTORY_FAILED", historyError: `Execution history persistence failed (${normalizeDrizzleError(error, "postgresql").code})` }
}

/**
 * Drizzle's insert `.values()` is keyed by the table's TypeScript property
 * names, not physical column names. Resolve the property that owns `column`.
 */
function propertyKeyFor(table: AnyPgTable, column: AnyColumn, label: string): string {
  const columns = getTableColumns(table) as Record<string, AnyColumn>
  for (const [key, candidate] of Object.entries(columns)) if (candidate === column) return key
  for (const [key, candidate] of Object.entries(columns)) if (candidate.name === column.name) return key
  throw new ConfigurationError(`Job store '${label}' column does not belong to the executions table`)
}

function readJobScope(row: Record<string, unknown>): StoredJob["scope"] {
  const scope = row.scope
  if (scope !== "tenant" && scope !== "platform" && scope !== "system") {
    throw new ConfigurationError(`Job ${String(row.id)} has a missing or invalid scope`)
  }
  return scope
}

function toStoredJob(row: Record<string, unknown>): StoredJob {
  const scope = readJobScope(row)
  const tenantId = (row.tenantId as string) ?? null
  return {
    id: row.id as string,
    jobType: row.jobType as string,
    jobVersion: row.jobVersion as number,
    tenantId,
    scope,
    executionScope: decodePersistedJobScope(scope, tenantId),
    payload: row.payload as string,
    status: row.status as StoredJob["status"],
    priority: row.priority as number,
    currentAttempt: row.attempts as number,
    attemptsCompleted: Math.max(0, (row.attempts as number) - 1),
    maxAttempts: decodeStoredJobMaxAttempts(row.maxAttempts),
    runAt: new Date(row.runAt as string),
    nextAttemptAt: row.nextAttemptAt ? new Date(row.nextAttemptAt as string) : null,
     leaseOwner: (row.leaseOwner as string) ?? null,
     leaseExpiresAt: row.leaseExpiresAt ? new Date(row.leaseExpiresAt as string) : null,
     claimToken: (row.claimToken as string) ?? null,
    idempotencyKey: (row.idempotencyKey as string) ?? null,
    fingerprint: decodePersistedJobFingerprint(row.fingerprint),
    correlationId: (row.correlationId as string) ?? null,
    lastError: (row.lastError as string) ?? null,
    resultPayload: (row.resultPayload as string) ?? null,
    metadata: row.metadata ? parseMetadata(row.metadata) : null,
    partitionKey: (row.partitionKey as string | null) ?? null,
    createdAt: new Date(row.createdAt as string),
    startedAt: row.startedAt ? new Date(row.startedAt as string) : null,
    completedAt: row.completedAt ? new Date(row.completedAt as string) : null,
  }
}

export class DrizzleJobStore implements JobStore {
  private static readonly REQUIRED_JOB_COLUMNS = [
    "id", "jobType", "jobVersion", "tenantId", "scope", "payload", "status", "priority", "attempts",
    "maxAttempts", "runAt", "nextAttemptAt", "leaseOwner", "leaseExpiresAt", "claimToken",
    "idempotencyKey", "idempotencyScope", "fingerprint", "correlationId", "lastError",
    "resultPayload", "metadata", "createdAt", "startedAt", "completedAt", "partitionKey",
  ] as const

  private readonly jobs: DrizzleColumnMap
  private readonly executions: DrizzleColumnMap

  constructor(private readonly db: DrizzleSessionLike, config: DrizzleJobStoreConfig) {
    this.jobs = config.columnMap.jobs
    this.executions = config.columnMap.executions
    this.jobsTable = config.jobsTable
    this.executionsTable = config.executionsTable
    this.executionHistory = config.executionHistory ?? "best_effort"
    if (this.executionHistory === "required" && typeof this.db.atomicJobTransition !== "function") {
      throw new ConfigurationError("executionHistory 'required' requires a session that provides atomicJobTransition")
    }
    for (const column of DrizzleJobStore.REQUIRED_JOB_COLUMNS) {
      if (!this.jobs[column]) {
        throw new ConfigurationError(`Job store is missing the required '${column}' column in its column map`)
      }
    }
    this.partitionKeyColumnName = (this.jobs.partitionKey as unknown as { name?: string }).name ?? "partition_key"
    this.leaseExpiresAtColumnName = (this.jobs.leaseExpiresAt as unknown as { name?: string } | undefined)?.name ?? "lease_expires_at"
    this.physicalIdColumn = (this.jobs.id as unknown as { name?: string }).name ?? "id"
    this.physicalStatusColumn = (this.jobs.status as unknown as { name?: string }).name ?? "status"

    // Validate and store required execution-history column objects from the map.
    const REQUIRED_EXEC_COLUMNS = ["id", "jobId", "attempt", "workerId", "status", "errorMessage", "startedAt", "finishedAt"] as const
    for (const col of REQUIRED_EXEC_COLUMNS) {
      if (!this.executions[col]) {
        throw new ConfigurationError(`Job store is missing the required '${col}' column in its executions column map`)
      }
    }
    this.execId = this.executions.id!
    this.execJobId = this.executions.jobId!
    this.execAttempt = this.executions.attempt!
    this.execWorkerId = this.executions.workerId!
    this.execStatus = this.executions.status!
    this.execErrorMessage = this.executions.errorMessage!
    this.execStartedAt = this.executions.startedAt!
    this.execFinishedAt = this.executions.finishedAt!
    this.execKeys = Object.fromEntries(REQUIRED_EXEC_COLUMNS.map((col) => [col, propertyKeyFor(this.executionsTable, this.executions[col]!, col)])) as Record<(typeof REQUIRED_EXEC_COLUMNS)[number], string>
  }

  private readonly jobsTable: AnyPgTable
  private readonly executionsTable: AnyPgTable
  private readonly executionHistory: "best_effort" | "required"
  private readonly partitionKeyColumnName: string
  private readonly leaseExpiresAtColumnName: string
  private readonly physicalIdColumn: string
  private readonly physicalStatusColumn: string

  // Required execution-history column objects derived from the column map.
  // Used as keys in .values() inserts so Drizzle maps them to the correct
  // physical column names even when the column map renames columns.
  private readonly execId: AnyColumn
  private readonly execJobId: AnyColumn
  private readonly execAttempt: AnyColumn
  private readonly execWorkerId: AnyColumn
  private readonly execStatus: AnyColumn
  private readonly execErrorMessage: AnyColumn
  private readonly execStartedAt: AnyColumn
  private readonly execFinishedAt: AnyColumn
  /** TypeScript property keys of the executions table, used as `.values()` keys. */
  private readonly execKeys: Record<"id" | "jobId" | "attempt" | "workerId" | "status" | "errorMessage" | "startedAt" | "finishedAt", string>

  private historyValues(args: { id: string; jobId: string; attempt: number | SQL; workerId: string; status: string; error: string | null | undefined; now: Date }): Record<string, unknown> {
    const keys = this.execKeys
    return {
      [keys.id]: args.id,
      [keys.jobId]: args.jobId,
      [keys.attempt]: args.attempt,
      [keys.workerId]: args.workerId,
      [keys.status]: args.status,
      [keys.errorMessage]: args.error == null ? null : pgText(args.error),
      [keys.startedAt]: args.now,
      [keys.finishedAt]: args.now,
    }
  }

  /** Column of the jobs table qualified by a subquery alias, using its physical name. */
  private aliased(alias: string, column: AnyColumn): SQL {
    return sql`${sql.identifier(alias)}.${sql.identifier(column.name)}`
  }

  /** Same scope, tenant and partition as the outer job row, excluding the row itself. */
  private samePartition(alias: string): SQL {
    const j = this.jobs
    return sql`${this.aliased(alias, j.partitionKey!)} = ${j.partitionKey!} AND ${this.aliased(alias, j.scope!)} = ${j.scope!} AND ${this.aliased(alias, j.tenantId!)} IS NOT DISTINCT FROM ${j.tenantId!} AND ${this.aliased(alias, j.id!)} <> ${j.id!}`
  }

  private tenantFilter(tenantId: string | null) {
     return tenantId === null ? isNull(this.jobs.tenantId!) : eq(this.jobs.tenantId!, tenantId)
  }

  private scopeFilter(scope: string) {
     return eq(this.jobs.scope!, scope)
  }

  private requesterFilters(requester: GetJobByIdArgs["requester"]) {
    const filters = [] as ReturnType<typeof eq>[]
    filters.push(this.scopeFilter(requesterJobScope(requester)))
    const tenantId = requesterTenantId(requester)
    if (tenantId !== null) filters.push(this.tenantFilter(tenantId))
    return filters
  }

  async enqueue(args: EnqueueJobArgs): Promise<StoredJob> {
    const job = args.job
    const { scope, tenantId } = encodeJobScope(job.executionScope)
    const runAt = job.runAt ?? new Date()
    assertDurableJob(job, runAt)
    assertRequesterCanEnqueueScope(args.requester, scope, tenantId)
    assertJobScopeCanEnqueue(scope, tenantId)
    const now = new Date()
    const idempotencyScope = buildIdempotencyScope(tenantId, scope)
    const fingerprintInput = buildJobFingerprintInput(job, runAt)
    const fingerprint = await fingerprintJob(fingerprintInput)
    if (job.idempotencyKey) {
      // ON CONFLICT DO NOTHING never raises on a replay, so this is safe inside
      // a caller's transaction (a caught 23505 would abort it with 25P02).
      let inserted: unknown[]
      try {
        inserted = await this.db.insert(this.jobsTable).values({
          id: uuidv7(), jobType: job.jobType, jobVersion: job.jobVersion, tenantId, scope,
          payload: JSON.stringify(job.payload), status: "pending", priority: job.priority ?? 0,
          attempts: 0, maxAttempts: encodeStoredJobMaxAttempts(job.maxAttempts), runAt, nextAttemptAt: runAt,
          idempotencyKey: job.idempotencyKey, idempotencyScope, ...(this.jobs.fingerprint ? { fingerprint } : {}), correlationId: job.correlationId ?? null,
          metadata: job.metadata ? JSON.stringify(job.metadata) : null, partitionKey: job.partitionKey ?? null, createdAt: now,
        }).onConflictDoNothing().returning()
      } catch (error) {
        rethrowNormalizedDrizzleError(error, "postgresql")
      }
      if (inserted[0]) return toStoredJob(inserted[0] as Record<string, unknown>)
      const existing = await this.db.select().from(this.jobsTable).where(and(
        eq(this.jobs.idempotencyScope!, idempotencyScope),
        eq(this.jobs.idempotencyKey!, job.idempotencyKey),
      )).limit(1)
      const row = existing[0] as Record<string, unknown> | undefined
      // The insert conflicted on some other unique constraint.
      if (!row) throw new ConflictError("A record with this value already exists", { dialect: "postgresql" })
      const existingFingerprint = row.fingerprint
      if (typeof existingFingerprint !== "string" || existingFingerprint.length === 0) {
        throw new Error("Stored job fingerprint is missing; migrate fingerprints before replaying jobs.")
      }
      if (!(await jobFingerprintMatches(existingFingerprint, fingerprintInput))) throw new JobIdempotencyConflictError(idempotencyScope, job.idempotencyKey)
      return toStoredJob(row)
    }
    const id = uuidv7()
    await this.db.insert(this.jobsTable).values({
      id, jobType: job.jobType, jobVersion: job.jobVersion, tenantId, scope,
      payload: JSON.stringify(job.payload), status: "pending", priority: job.priority ?? 0,
      attempts: 0, maxAttempts: encodeStoredJobMaxAttempts(job.maxAttempts), runAt, nextAttemptAt: runAt,
      idempotencyKey: job.idempotencyKey ?? null, idempotencyScope, ...(this.jobs.fingerprint ? { fingerprint } : {}), correlationId: job.correlationId ?? null,
      metadata: job.metadata ? JSON.stringify(job.metadata) : null, partitionKey: job.partitionKey ?? null, createdAt: now,
    })
     const rows = await this.db.select().from(this.jobsTable).where(eq(this.jobs.id!, id)).limit(1)
    if (!rows[0]) throw new Error(`Failed to read back enqueued job ${id}`)
    return toStoredJob(rows[0] as Record<string, unknown>)
  }

  async getById(args: GetJobByIdArgs): Promise<StoredJob | null> {
     const conditions = [eq(this.jobs.id!, args.id)]
      conditions.push(...this.requesterFilters(args.requester))
    const rows = await this.db.select().from(this.jobsTable).where(and(...conditions)).limit(1)
    return rows[0] ? toStoredJob(rows[0] as Record<string, unknown>) : null
  }

  async getByCorrelationId(args: GetByCorrelationIdArgs): Promise<StoredJob[]> {
     const conditions = [eq(this.jobs.correlationId!, args.correlationId)]
      conditions.push(...this.requesterFilters(args.requester))
     const rows = await this.db.select().from(this.jobsTable).where(and(...conditions)).orderBy(desc(this.jobs.createdAt!)).limit(5).offset(0)
    return rows.map((row: unknown) => toStoredJob(row as Record<string, unknown>))
  }

  async getByIdempotencyKey(args: GetByIdempotencyKeyArgs): Promise<StoredJob | null> {
     const tid = requesterTenantId(args.requester)
      const conditions = [eq(this.jobs.idempotencyKey!, args.key), eq(this.jobs.idempotencyScope!, buildIdempotencyScope(tid, requesterJobScope(args.requester)))]
      conditions.push(...this.requesterFilters(args.requester))
    const rows = await this.db.select().from(this.jobsTable).where(and(...conditions)).limit(1)
    return rows[0] ? toStoredJob(rows[0] as Record<string, unknown>) : null
  }

  async getLatestPriorScheduleExecution(args: GetLatestPriorScheduleExecutionArgs): Promise<StoredJob | null> {
    const conditions = [
      eq(this.jobs.correlationId!, scheduleCorrelationId(args.scheduleId)),
      lt(this.jobs.runAt!, args.beforeOccurrence),
    ]
    conditions.push(...this.requesterFilters(args.requester))
    const rows = await this.db.select().from(this.jobsTable).where(and(...conditions)).orderBy(desc(this.jobs.runAt!)).limit(1).offset(0)
    return rows[0] ? toStoredJob(rows[0] as Record<string, unknown>) : null
  }

  async claimDue(args: ClaimDueJobsArgs): Promise<StoredJob[]> {
    assertDurableIdentifier(args.workerId, "workerId", 100)
    if (!Number.isSafeInteger(args.limit) || args.limit <= 0) return []
    const j = this.jobs
    const now = args.now ?? new Date()
    const leaseExpiresAt = sql`now() + (${args.leaseDurationMs} * interval '1 millisecond')`
    const requesterScope = this.requesterFilters(args.requester)
    const scope = requesterScope.length > 0 ? and(...requesterScope) : undefined

    // A running job whose lease expired on its final attempt can never be
    // reclaimed; move it to dead_letter (DB clock) so it is not stuck forever.
    await this.db.update(this.jobsTable).set({
      status: "dead_letter", lastError: LEASE_EXPIRED_ON_FINAL_ATTEMPT, completedAt: sql`now()`,
      leaseOwner: null, claimToken: null, leaseExpiresAt: null,
    }).where(and(eq(j.status!, "running"), lt(j.leaseExpiresAt!, sql`now()`), sql`${j.attempts!} >= ${j.maxAttempts!}`, ...(scope ? [scope] : [])))

    const due = or(
      and(inArray(j.status!, ["pending", "retrying"]), lt(j.attempts!, j.maxAttempts!), lte(j.nextAttemptAt ?? j.runAt!, now)),
      and(eq(j.status!, "running"), lt(j.attempts!, j.maxAttempts!), lt(j.leaseExpiresAt!, sql`now()`)),
    )!
    const dueFor = (alias: string) => sql`((${this.aliased(alias, j.status!)} IN ('pending', 'retrying') AND ${this.aliased(alias, j.attempts!)} < ${this.aliased(alias, j.maxAttempts!)} AND ${this.aliased(alias, j.nextAttemptAt ?? j.runAt!)} <= ${now})
      OR (${this.aliased(alias, j.status!)} = 'running' AND ${this.aliased(alias, j.attempts!)} < ${this.aliased(alias, j.maxAttempts!)} AND ${this.aliased(alias, j.leaseExpiresAt!)} < now()))`
    // queue-overlap serialization: at most one job of the same partition
    // (within the same scope and tenant) may be running at a time.
    const noRunningSibling = sql`NOT EXISTS (SELECT 1 FROM ${this.jobsTable} sibling WHERE ${this.samePartition("sibling")} AND ${this.aliased("sibling", j.status!)} = 'running' AND ${this.aliased("sibling", j.leaseExpiresAt!)} > now())`
    // Only the head of each partition is a candidate, so a busy partition can
    // neither fill the LIMIT nor have two of its jobs claimed in one batch.
    const isPartitionHead = sql`NOT EXISTS (SELECT 1 FROM ${this.jobsTable} ahead WHERE ${this.samePartition("ahead")} AND ${dueFor("ahead")}
      AND (${this.aliased("ahead", j.priority!)}, ${this.aliased("ahead", j.runAt!)}, ${this.aliased("ahead", j.id!)}) < (${j.priority!}, ${j.runAt!}, ${j.id!}))`
    const eligible = and(due, ...(scope ? [scope] : []), noRunningSibling, isPartitionHead)
    // Row locks with SKIP LOCKED let concurrent claimers take disjoint batches.
    // ARRAY(subquery) is an uncorrelated InitPlan, so the locking LIMIT runs
    // exactly once (an IN-subquery may be rescanned and over-claim).
    const candidates = sql`SELECT ${j.id!} FROM ${this.jobsTable} WHERE ${eligible} ORDER BY ${j.priority!} ASC, ${j.runAt!} ASC, ${j.id!} ASC LIMIT ${args.limit} FOR UPDATE SKIP LOCKED`
    const claimed = await this.db.update(this.jobsTable).set({
      status: "running", leaseOwner: args.workerId, claimToken: sql`gen_random_uuid()::text`, leaseExpiresAt,
      attempts: sql`${j.attempts!} + 1`, startedAt: now, nextAttemptAt: null,
    }).where(and(sql`${j.id!} = ANY(ARRAY(${candidates}))`, due, ...(scope ? [scope] : []), noRunningSibling)).returning<Record<string, unknown>>()
    return claimed.map((row) => toStoredJob(row)).sort((left, right) => left.priority - right.priority || left.runAt.getTime() - right.runAt.getTime() || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  }

  async renewLease(args: RenewLeaseArgs): Promise<boolean> {
    assertDurableIdentifier(args.workerId, "workerId", 100)
    const durationMs = args.extendByMs
    if (!Number.isFinite(durationMs) || durationMs <= 0) return false
    // Renewal only ever moves the expiry forward: a shorter extension than the time left must not shorten the lease.
    const leaseExpiresAt = sql`GREATEST(${this.jobs.leaseExpiresAt!}, now() + (${durationMs} * interval '1 millisecond'))`
    const result = await this.db.update(this.jobsTable).set({ leaseExpiresAt }).where(and(
        eq(this.jobs.id!, args.jobId), eq(this.jobs.leaseOwner!, args.workerId), eq(this.jobs.claimToken!, args.claimToken),
         eq(this.jobs.status!, "running"), gt(this.jobs.leaseExpiresAt!, sql`now()`),
     ))
    return getAffectedRows(result) > 0
  }

  async markSucceeded(args: CompleteJobArgs): Promise<JobTransitionResult> {
    const now = new Date()
    const token = uuidv7()
    const where = and(eq(this.jobs.id!, args.jobId), eq(this.jobs.leaseOwner!, args.workerId), eq(this.jobs.claimToken!, args.claimToken), eq(this.jobs.attempts!, args.attempt), eq(this.jobs.status!, "running"), gt(this.jobs.leaseExpiresAt!, sql`now()`))
    if (this.executionHistory === "required") return this.atomicTransition({ where, token, set: { status: "succeeded", resultPayload: args.result ? JSON.stringify(args.result) : null, completedAt: now, leaseOwner: null, claimToken: token, leaseExpiresAt: null }, status: "succeeded", attempt: args.attempt, workerId: args.workerId, jobId: args.jobId, now })
    const result = await this.db.update(this.jobsTable).set({ status: "succeeded", resultPayload: args.result ? JSON.stringify(args.result) : null, completedAt: now, leaseOwner: null, claimToken: null, leaseExpiresAt: null }).where(where)
    const affected = getAffectedRows(result) > 0
    if (!affected) return { applied: false, reason: "LEASE_LOST" }
    const history = await this.recordExecution(args.jobId, "succeeded", args.attempt, args.workerId, undefined, now)
    return { applied: true, transitionToken: history.token }
  }

  async markRetrying(args: RetryJobArgs): Promise<JobTransitionResult> {
      const now = new Date()
       const where = and(eq(this.jobs.id!, args.jobId), eq(this.jobs.leaseOwner!, args.workerId), eq(this.jobs.claimToken!, args.claimToken), eq(this.jobs.attempts!, args.attempt), lt(this.jobs.attempts!, this.jobs.maxAttempts!), inArray(this.jobs.status!, ["running"]), gt(this.jobs.leaseExpiresAt!, sql`now()`))
       const token = uuidv7()
       if (this.executionHistory === "required") return this.atomicTransition({ where, token, set: { status: "retrying", nextAttemptAt: args.nextAttemptAt, lastError: pgText(args.error), leaseOwner: null, claimToken: token, leaseExpiresAt: null }, status: "retrying", attempt: args.attempt, workerId: args.workerId, error: args.error, jobId: args.jobId, now })
       const result = await this.db.update(this.jobsTable).set({ status: "retrying", nextAttemptAt: args.nextAttemptAt, lastError: pgText(args.error), leaseOwner: null, claimToken: null, leaseExpiresAt: null }).where(where)
    const affected = getAffectedRows(result) > 0
     if (!affected) return { applied: false, reason: "LEASE_LOST" }
       const history = await this.recordExecution(args.jobId, "retrying", args.attempt, args.workerId, args.error, now)
     return { applied: true, transitionToken: history.token }
  }

  /** Gives a live claim back without consuming the attempt counted at claim time. */
  async release(args: ReleaseJobArgs): Promise<JobTransitionResult> {
    const where = and(eq(this.jobs.id!, args.jobId), eq(this.jobs.leaseOwner!, args.workerId), eq(this.jobs.claimToken!, args.claimToken), eq(this.jobs.status!, "running"), gt(this.jobs.leaseExpiresAt!, sql`now()`))
    const result = await this.db.update(this.jobsTable).set({ status: "retrying", attempts: sql`CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END`, nextAttemptAt: args.nextAttemptAt, lastError: pgText(args.reason.slice(0, 512)), leaseOwner: null, leaseExpiresAt: null, claimToken: null }).where(where)
    return getAffectedRows(result) > 0 ? { applied: true } : { applied: false, reason: "LEASE_LOST" }
  }

  async markFailed(args: FailJobArgs): Promise<JobTransitionResult> {
    const now = new Date()
       const where = and(eq(this.jobs.id!, args.jobId), eq(this.jobs.leaseOwner!, args.workerId), eq(this.jobs.claimToken!, args.claimToken), eq(this.jobs.attempts!, args.attempt), eq(this.jobs.status!, "running"), gt(this.jobs.leaseExpiresAt!, sql`now()`))
       const token = uuidv7()
       if (this.executionHistory === "required") return this.atomicTransition({ where, token, set: { status: args.status, lastError: pgText(args.error), completedAt: now, leaseOwner: null, claimToken: token, leaseExpiresAt: null }, status: args.status, attempt: args.attempt, workerId: args.workerId, error: args.error, jobId: args.jobId, now })
       const result = await this.db.update(this.jobsTable).set({ status: args.status, lastError: pgText(args.error), completedAt: now, leaseOwner: null, claimToken: null, leaseExpiresAt: null }).where(where)
    const affected = getAffectedRows(result) > 0
     if (!affected) return { applied: false, reason: "LEASE_LOST" }
       const history = await this.recordExecution(args.jobId, args.status, args.attempt, args.workerId, args.error, now)
     return { applied: true, transitionToken: history.token }
  }

  async cancel(args: CancelJobArgs): Promise<JobTransitionResult> {
      const conditions = [eq(this.jobs.id!, args.jobId), ne(this.jobs.status!, "succeeded"), ne(this.jobs.status!, "cancelled"), ne(this.jobs.status!, "dead_letter"), ne(this.jobs.status!, "failed")]
      conditions.push(...this.requesterFilters(args.requester))
       const now = new Date()
       if (this.executionHistory === "required") {
         const token = uuidv7()
         try {
            // The attempt is read from the job row inside the same transaction,
            // after the fenced UPDATE locked it, so it cannot drift.
            const historyValues = this.historyValues({
              id: token, jobId: args.jobId, attempt: sql`(SELECT ${this.jobs.attempts!} FROM ${this.jobsTable} WHERE ${this.jobs.id!} = ${args.jobId})`,
              workerId: "cancellation", status: "cancelled", error: args.reason, now,
            })
            const result = await this.db.atomicJobTransition!({
              updateTable: this.jobsTable,
              updateSet: { status: "cancelled", completedAt: now, lastError: args.reason === undefined ? null : pgText(args.reason), leaseOwner: null, claimToken: token, leaseExpiresAt: null },
              updateWhere: and(...conditions),
              historyTable: this.executionsTable,
              historyValues,
              historyWhere: eq(this.jobs.claimToken!, token),
            })
           return result.applied ? { applied: true, transitionToken: token } : { applied: false, reason: "INVALID_STATE" }
         } catch (error) {
           return historyFailure(error)
         }
       }
       const rows = await this.db.select().from(this.jobsTable).where(and(...conditions)).limit(1)
      const row = rows[0] as Record<string, unknown> | undefined
      if (!row) return { applied: false, reason: "INVALID_STATE" }
      const history = await this.recordExecution(args.jobId, "cancelled", (row.attempts as number) ?? 0, "cancellation", args.reason, now)
      const result = await this.db.update(this.jobsTable).set({ status: "cancelled", completedAt: now, lastError: args.reason === undefined ? null : pgText(args.reason), leaseOwner: null, claimToken: null, leaseExpiresAt: null }).where(and(...conditions))
      if (getAffectedRows(result) === 0) return { applied: false, reason: "INVALID_STATE" }
      return { applied: true, transitionToken: history.token }
  }

  async findPending(args: FindPendingArgs): Promise<StoredJob[]> {
     const conditions = [inArray(this.jobs.status!, ["pending", "retrying"])]
     conditions.push(...this.requesterFilters(args.requester))
     if (args.jobType) conditions.push(eq(this.jobs.jobType!, args.jobType))
     const rows = await this.db.select().from(this.jobsTable).where(and(...conditions)).orderBy(sql`${asc(this.jobs.priority!)}, ${asc(this.jobs.createdAt!)}`).limit(args.limit ?? 100).offset(0)
    return rows.map((row: unknown) => toStoredJob(row as Record<string, unknown>))
  }

  private async recordExecution(jobId: string, status: string, attempt: number, workerId: string, error: string | undefined, now: Date): Promise<{ token: string; error?: string }> {
    const token = uuidv7()
    try {
      await this.db.insert(this.executionsTable).values(this.historyValues({ id: token, jobId, attempt, workerId, status, error, now }))
      return { token }
    } catch (historyError) {
      if (this.executionHistory === "required") return { token, error: historyFailure(historyError).historyError! }
      return { token }
    }
  }

  private async atomicTransition(args: { where: ReturnType<typeof and>; token: string; set: Record<string, unknown>; status: string; attempt: number; workerId: string; error?: string | undefined; jobId: string; now: Date }): Promise<JobTransitionResult> {
    try {
      const historyValues = this.historyValues({ id: args.token, jobId: args.jobId, attempt: args.attempt, workerId: args.workerId, status: args.status, error: args.error, now: args.now })
      const result = await this.db.atomicJobTransition!({
        updateTable: this.jobsTable,
        updateSet: args.set,
        updateWhere: args.where,
        historyTable: this.executionsTable,
        historyValues,
        historyWhere: eq(this.jobs.claimToken!, args.token),
      })
      return result.applied ? { applied: true, transitionToken: args.token } : { applied: false, reason: "LEASE_LOST" }
    } catch (error) {
      return historyFailure(error)
    }
  }
}

export function createDrizzleJobStore(db: DrizzleSessionLike, config: DrizzleJobStoreConfig): DrizzleJobStore {
  return new DrizzleJobStore(db, config)
}
