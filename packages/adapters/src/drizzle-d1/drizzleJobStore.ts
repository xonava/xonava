import { and, asc, desc, eq, gt, inArray, isNull, lte, lt, ne, or, sql, type AnyColumn } from "drizzle-orm"
import { ConfigurationError } from "core/domain"
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core"
import type {
  JobStore,
  ClaimDueJobsArgs,
  RenewLeaseArgs,
  CompleteJobArgs,
  RetryJobArgs,
  FailJobArgs,
  CancelJobArgs,
  GetJobByIdArgs,
  GetByCorrelationIdArgs,
  GetLatestPriorScheduleExecutionArgs,
  GetByIdempotencyKeyArgs,
  FindPendingArgs,
  EnqueueJobArgs,
  StoredJob,
  JobTransitionResult,
} from "core/execution"
import { assertRequesterCanEnqueueScope, assertJobScopeCanEnqueue, assertDurableJob, assertDurableIdentifier, requesterJobScope, requesterTenantId, scheduleCorrelationId, CorruptJobMetadataError, JobIdempotencyConflictError } from "core/execution"
import { buildJobFingerprintInput, fingerprintJob } from "core/execution"
import { decodePersistedJobFingerprint, decodePersistedJobScope, encodeJobScope } from "../drizzle-shared/jobScope"
import { uuidv7 } from "uuidv7"
import type { DrizzleColumnMap } from "../drizzle-shared/predicateCompiler"
import type { DrizzleSessionLike } from "./drizzleRepository"
import { d1CurrentEpochMilliseconds, d1EpochMillisecondsAfter, getAffectedRows } from "./d1Utils"

export interface DrizzleJobStoreConfig {
  jobsTable: AnySQLiteTable
  executionsTable: AnySQLiteTable
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

function isUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const e = err as Record<string, unknown>
  if (e.errno === 19 || e.code === "SQLITE_CONSTRAINT" || e.code === 2067) return true
  if (typeof e.message === "string" && e.message.includes("UNIQUE constraint")) return true
  return false
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
    maxAttempts: row.maxAttempts as number,
    runAt: new Date(row.runAt as number),
    nextAttemptAt: row.nextAttemptAt ? new Date(row.nextAttemptAt as number) : null,
    leaseOwner: (row.leaseOwner as string) ?? null,
    leaseExpiresAt: row.leaseExpiresAt ? new Date(row.leaseExpiresAt as number) : null,
    claimToken: (row.claimToken as string) ?? null,
    idempotencyKey: (row.idempotencyKey as string) ?? null,
    fingerprint: decodePersistedJobFingerprint(row.fingerprint),
    correlationId: (row.correlationId as string) ?? null,
    lastError: (row.lastError as string) ?? null,
    resultPayload: (row.resultPayload as string) ?? null,
    metadata: row.metadata ? parseMetadata(row.metadata) : null,
    partitionKey: (row.partitionKey as string | null) ?? null,
    createdAt: new Date(row.createdAt as number),
    startedAt: row.startedAt ? new Date(row.startedAt as number) : null,
    completedAt: row.completedAt ? new Date(row.completedAt as number) : null,
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
  }

  private readonly jobsTable: AnySQLiteTable
  private readonly executionsTable: AnySQLiteTable
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
    const fingerprint = await fingerprintJob(buildJobFingerprintInput(job, runAt))
    if (job.idempotencyKey) {
      try {
        const id = uuidv7()
        await this.db.insert(this.jobsTable).values({
           id, jobType: job.jobType, jobVersion: job.jobVersion, tenantId, scope,
          payload: JSON.stringify(job.payload), status: "pending", priority: job.priority ?? 0,
          attempts: 0, maxAttempts: job.maxAttempts ?? 3, runAt, nextAttemptAt: runAt,
            idempotencyKey: job.idempotencyKey, idempotencyScope, ...(this.jobs.fingerprint ? { fingerprint } : {}), correlationId: job.correlationId ?? null,
           metadata: job.metadata ? JSON.stringify(job.metadata) : null, claimToken: null, partitionKey: job.partitionKey ?? null, createdAt: now,
        })
         const rows = await this.db.select().from(this.jobsTable).where(eq(this.jobs.id!, id)).limit(1)
        if (!rows[0]) throw new Error(`Failed to read back enqueued job ${id}`)
        return toStoredJob(rows[0] as Record<string, unknown>)
      } catch (err) {
        if (isUniqueConstraintError(err)) {
            const idempotencyScope = buildIdempotencyScope(tenantId, scope)
          const existing = await this.db.select().from(this.jobsTable).where(and(
             eq(this.jobs.idempotencyScope!, idempotencyScope),
             eq(this.jobs.idempotencyKey!, job.idempotencyKey),
          )).limit(1)
           if (existing[0]) {
             const row = existing[0] as Record<string, unknown>
              const existingFingerprint = row.fingerprint
              if (typeof existingFingerprint !== "string" || existingFingerprint.length === 0) {
                throw new Error("Stored job fingerprint is missing; migrate fingerprints before replaying jobs.")
              }
              if (existingFingerprint !== fingerprint) throw new JobIdempotencyConflictError(idempotencyScope, job.idempotencyKey)
             return toStoredJob(row)
           }
        }
        throw err
      }
    }
    const id = uuidv7()
    await this.db.insert(this.jobsTable).values({
      id, jobType: job.jobType, jobVersion: job.jobVersion, tenantId, scope,
      payload: JSON.stringify(job.payload), status: "pending", priority: job.priority ?? 0,
      attempts: 0, maxAttempts: job.maxAttempts ?? 3, runAt, nextAttemptAt: runAt,
      idempotencyKey: job.idempotencyKey ?? null, idempotencyScope, ...(this.jobs.fingerprint ? { fingerprint } : {}), correlationId: job.correlationId ?? null,
       metadata: job.metadata ? JSON.stringify(job.metadata) : null, claimToken: null, partitionKey: job.partitionKey ?? null, createdAt: now,
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
    const now = args.now ?? new Date()
    const leaseExpiresAt = d1EpochMillisecondsAfter(args.leaseDurationMs)
     const due = or(
       and(inArray(this.jobs.status!, ["pending", "retrying"]), lte(this.jobs.nextAttemptAt ?? this.jobs.runAt!, now), lt(this.jobs.attempts!, this.jobs.maxAttempts!)),
        and(eq(this.jobs.status!, "running"), lt(this.jobs.attempts!, this.jobs.maxAttempts!), lt(this.jobs.leaseExpiresAt!, d1CurrentEpochMilliseconds())),
      )
     const requesterScope = this.requesterFilters(args.requester)
     const scope = requesterScope.length > 0 ? and(...requesterScope) : undefined
     const eligible = await this.db.select({ id: this.jobs.id! }).from(this.jobsTable).where(scope ? and(due, scope) : due)
       .orderBy(sql`${asc(this.jobs.priority!)}, ${asc(this.jobs.runAt!)}`).limit(args.limit).offset(0)
    const claimedIds: string[] = []
    const claimTokens = new Map<string, string>()
    // queue-overlap serialization: at most one job of the same partition may be
    // running at a time. The NOT EXISTS is evaluated inside the claim UPDATE,
    // so it atomically fences two workers racing to claim the same partition.
     const noRunningSibling = sql`NOT EXISTS (SELECT 1 FROM ${this.jobsTable} sibling WHERE sibling.${sql.identifier(this.partitionKeyColumnName)} = ${this.jobs.partitionKey} AND sibling.${sql.identifier(this.physicalStatusColumn)} = 'running' AND sibling.${sql.identifier(this.leaseExpiresAtColumnName)} > ${d1CurrentEpochMilliseconds()} AND sibling.${sql.identifier(this.physicalIdColumn)} <> ${this.jobs.id})`
    for (const row of eligible as { id: string }[]) {
      const claimToken = uuidv7()
      const result = await this.db.update(this.jobsTable).set({
          status: "running", leaseOwner: args.workerId, leaseExpiresAt, claimToken,
        attempts: sql`attempts + 1`, startedAt: now, nextAttemptAt: null,
       }).where(and(eq(this.jobs.id!, row.id), due, ...(scope ? [scope] : []), noRunningSibling))
       if (getAffectedRows(result) > 0) {
         claimedIds.push(row.id)
         claimTokens.set(row.id, claimToken)
       }
    }
    if (claimedIds.length === 0) return []
    const tokenReadback = [...claimTokens.entries()].map(([id, token]) => and(eq(this.jobs.id!, id), eq(this.jobs.claimToken!, token)))
    const claimed = await this.db.select().from(this.jobsTable).where(and(
       or(...tokenReadback), eq(this.jobs.leaseOwner!, args.workerId), eq(this.jobs.status!, "running"), gt(this.jobs.leaseExpiresAt!, d1CurrentEpochMilliseconds()),
    )).limit(claimedIds.length)
    return claimed.map((row: unknown) => toStoredJob(row as Record<string, unknown>))
  }

  async renewLease(args: RenewLeaseArgs): Promise<boolean> {
    assertDurableIdentifier(args.workerId, "workerId", 100)
    const durationMs = args.extendByMs
    if (!Number.isFinite(durationMs) || durationMs <= 0) return false
    const leaseExpiresAt = d1EpochMillisecondsAfter(durationMs)
    const result = await this.db.update(this.jobsTable).set({ leaseExpiresAt }).where(and(
         eq(this.jobs.id!, args.jobId), eq(this.jobs.leaseOwner!, args.workerId), eq(this.jobs.claimToken!, args.claimToken), eq(this.jobs.status!, "running"), gt(this.jobs.leaseExpiresAt!, d1CurrentEpochMilliseconds()),
    ))
    return getAffectedRows(result) > 0
  }

  async markSucceeded(args: CompleteJobArgs): Promise<JobTransitionResult> {
    const now = new Date()
    const token = uuidv7()
    const where = and(eq(this.jobs.id!, args.jobId), eq(this.jobs.leaseOwner!, args.workerId), eq(this.jobs.claimToken!, args.claimToken), eq(this.jobs.attempts!, args.attempt), eq(this.jobs.status!, "running"), gt(this.jobs.leaseExpiresAt!, d1CurrentEpochMilliseconds()))
    if (this.executionHistory === "required") return this.atomicTransition({ where, token, set: { status: "succeeded", resultPayload: args.result ? JSON.stringify(args.result) : null, completedAt: now, leaseOwner: null, claimToken: token, leaseExpiresAt: null }, status: "succeeded", attempt: args.attempt, workerId: args.workerId, jobId: args.jobId, now })
      const result = await this.db.update(this.jobsTable).set({ status: "succeeded", resultPayload: args.result ? JSON.stringify(args.result) : null, completedAt: now, leaseOwner: null, leaseExpiresAt: null, claimToken: null }).where(where)
    const affected = getAffectedRows(result) > 0
     if (!affected) return { applied: false, reason: "LEASE_LOST" }
      const history = await this.recordExecution(args.jobId, "succeeded", args.attempt, args.workerId, undefined, now)
     return { applied: true, transitionToken: history.token }
  }

  async markRetrying(args: RetryJobArgs): Promise<JobTransitionResult> {
      const now = new Date()
       const token = uuidv7()
       const where = and(eq(this.jobs.id!, args.jobId), eq(this.jobs.leaseOwner!, args.workerId), eq(this.jobs.claimToken!, args.claimToken), eq(this.jobs.attempts!, args.attempt), lt(this.jobs.attempts!, this.jobs.maxAttempts!), inArray(this.jobs.status!, ["running"]), gt(this.jobs.leaseExpiresAt!, d1CurrentEpochMilliseconds()))
       if (this.executionHistory === "required") return this.atomicTransition({ where, token, set: { status: "retrying", nextAttemptAt: args.nextAttemptAt, lastError: args.error, leaseOwner: null, leaseExpiresAt: null, claimToken: token }, status: "retrying", attempt: args.attempt, workerId: args.workerId, error: args.error, jobId: args.jobId, now })
       const result = await this.db.update(this.jobsTable).set({ status: "retrying", nextAttemptAt: args.nextAttemptAt, lastError: args.error, leaseOwner: null, leaseExpiresAt: null, claimToken: null }).where(where)
    const affected = getAffectedRows(result) > 0
     if (!affected) return { applied: false, reason: "LEASE_LOST" }
      const history = await this.recordExecution(args.jobId, "retrying", args.attempt, args.workerId, args.error, now)
     return { applied: true, transitionToken: history.token }
  }

  async markFailed(args: FailJobArgs): Promise<JobTransitionResult> {
      const now = new Date()
       const token = uuidv7()
        const where = and(eq(this.jobs.id!, args.jobId), eq(this.jobs.leaseOwner!, args.workerId), eq(this.jobs.claimToken!, args.claimToken), eq(this.jobs.attempts!, args.attempt), eq(this.jobs.status!, "running"), gt(this.jobs.leaseExpiresAt!, d1CurrentEpochMilliseconds()))
       if (this.executionHistory === "required") return this.atomicTransition({ where, token, set: { status: args.status, lastError: args.error, completedAt: now, leaseOwner: null, leaseExpiresAt: null, claimToken: token }, status: args.status, attempt: args.attempt, workerId: args.workerId, error: args.error, jobId: args.jobId, now })
       const result = await this.db.update(this.jobsTable).set({ status: args.status, lastError: args.error, completedAt: now, leaseOwner: null, leaseExpiresAt: null, claimToken: null }).where(where)
    const affected = getAffectedRows(result) > 0
     if (!affected) return { applied: false, reason: "LEASE_LOST" }
      const history = await this.recordExecution(args.jobId, args.status, args.attempt, args.workerId, args.error, now)
     return { applied: true, transitionToken: history.token }
  }

    async cancel(args: CancelJobArgs): Promise<JobTransitionResult> {
     const conditions = [eq(this.jobs.id!, args.jobId), ne(this.jobs.status!, "succeeded"), ne(this.jobs.status!, "cancelled"), ne(this.jobs.status!, "dead_letter")]
      conditions.push(...this.requesterFilters(args.requester))
       const now = new Date()
       if (this.executionHistory === "required") {
         const token = uuidv7()
         try {
            const historyValues: Record<string, unknown> = {
              [this.execId.name]: token,
              [this.execJobId.name]: args.jobId,
              [this.execAttempt.name]: sql`${this.jobs.attempts}`,
              [this.execWorkerId.name]: "cancellation",
              [this.execStatus.name]: "cancelled",
              [this.execErrorMessage.name]: args.reason ?? null,
              [this.execStartedAt.name]: now,
              [this.execFinishedAt.name]: now,
            }
            const result = await this.db.atomicJobTransition!({
              updateTable: this.jobsTable,
              updateSet: { status: "cancelled", completedAt: now, lastError: args.reason ?? null, leaseOwner: null, claimToken: token, leaseExpiresAt: null },
              updateWhere: and(...conditions),
              historyTable: this.executionsTable,
              historyValues,
              historyWhere: eq(this.jobs.claimToken!, token),
            })
           return result.applied ? { applied: true, transitionToken: token } : { applied: false, reason: "INVALID_STATE" }
         } catch (error) {
           return { applied: false, reason: "HISTORY_FAILED", historyError: `Execution history persistence failed: ${error instanceof Error ? error.message : String(error)}` }
         }
       }
       const rows = await this.db.select().from(this.jobsTable).where(and(...conditions)).limit(1)
      const row = rows[0] as Record<string, unknown> | undefined
      if (!row) return { applied: false, reason: "INVALID_STATE" }
       const history = await this.recordExecution(args.jobId, "cancelled", (row.attempts as number) ?? 0, "cancellation", args.reason, now)
      const result = await this.db.update(this.jobsTable).set({ status: "cancelled", completedAt: now, lastError: args.reason ?? null, leaseOwner: null, claimToken: null, leaseExpiresAt: null }).where(and(...conditions))
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
      await this.db.insert(this.executionsTable).values({
        [this.execId.name]: token,
        [this.execJobId.name]: jobId,
        [this.execAttempt.name]: attempt,
        [this.execWorkerId.name]: workerId,
        [this.execStatus.name]: status,
        [this.execErrorMessage.name]: error ?? null,
        [this.execStartedAt.name]: now,
        [this.execFinishedAt.name]: now,
      })
      return { token }
    } catch (historyError) {
      if (this.executionHistory === "required") return { token, error: `Execution history persistence failed: ${historyError instanceof Error ? historyError.message : String(historyError)}` }
      return { token }
    }
  }

  private async atomicTransition(args: { where: ReturnType<typeof and>; token: string; set: Record<string, unknown>; status: string; attempt: number; workerId: string; error?: string | undefined; jobId: string; now: Date }): Promise<JobTransitionResult> {
    try {
      const historyValues: Record<string, unknown> = {
        [this.execId.name]: args.token,
        [this.execJobId.name]: args.jobId,
        [this.execAttempt.name]: args.attempt,
        [this.execWorkerId.name]: args.workerId,
        [this.execStatus.name]: args.status,
        [this.execErrorMessage.name]: args.error ?? null,
        [this.execStartedAt.name]: args.now,
        [this.execFinishedAt.name]: args.now,
      }
      const result = await this.db.atomicJobTransition!({ updateTable: this.jobsTable, updateSet: args.set, updateWhere: args.where, historyTable: this.executionsTable, historyValues, historyWhere: eq(this.jobs.claimToken!, args.token) })
      return result.applied ? { applied: true, transitionToken: args.token } : { applied: false, reason: "LEASE_LOST" }
    } catch (error) { return { applied: false, reason: "HISTORY_FAILED", historyError: `Execution history persistence failed: ${error instanceof Error ? error.message : String(error)}` } }
  }
}

export function createDrizzleJobStore(db: DrizzleSessionLike, config: DrizzleJobStoreConfig): DrizzleJobStore {
  return new DrizzleJobStore(db, config)
}
