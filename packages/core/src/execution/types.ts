import type { Clock } from "../kernel/clock"
import { ConfigurationError, TenantScopeViolationError } from "../domain/errors"
import { validateExecutionScope, type ExecutionScope } from "../domain/executionScope"

export type JobStatus = "pending" | "running" | "succeeded" | "retrying" | "failed" | "dead_letter" | "cancelled"

export type PriorScheduleExecutionStatus = "queued" | "running" | "completed" | "failed" | "cancelled"

export type JobScope = "tenant" | "platform" | "system"
export type JobExecutionScope = Exclude<ExecutionScope, { kind: "application" }>

export interface Lease {
  owner: string
  /** Opaque value that fences stale workers from mutating this lease. */
  claimToken: string
  acquiredAt: Date
  expiresAt: Date
  durationMs: number
}

export interface NewJob {
  executionScope: JobExecutionScope
  jobType: string
  jobVersion: number
  payload: Record<string, unknown>
  runAt?: Date
  maxAttempts?: number
  idempotencyKey?: string
  correlationId?: string
  priority?: number
  metadata?: Record<string, unknown>
  /**
   * Serializes execution: at most one job per partition may run at a time.
   * Set to a schedule identity so queued schedule occurrences never overlap.
   */
  partitionKey?: string
}

/**
 * Value persisted in a job's max-attempts column when `NewJob.maxAttempts` is
 * omitted. Such a job has no per-job override: its attempt budget is the
 * JobDefinition's `maxAttempts`, resolved by the dispatcher (and the stored job
 * reports `maxAttempts: undefined`). It is the largest signed 32-bit integer,
 * so every store's `attempts < max_attempts` claim guard keeps working without
 * a schema change while the dispatcher enforces the definition's budget.
 */
export const JOB_MAX_ATTEMPTS_FROM_DEFINITION = 2_147_483_647

/** Durable max-attempts column value for a new job (see JOB_MAX_ATTEMPTS_FROM_DEFINITION). */
export function encodeStoredJobMaxAttempts(maxAttempts: number | undefined): number {
  return maxAttempts ?? JOB_MAX_ATTEMPTS_FROM_DEFINITION
}

/** Decodes a persisted max-attempts column: undefined means "use the job definition". */
export function decodeStoredJobMaxAttempts(value: unknown): number | undefined {
  const parsed = Number(value)
  return value === null || value === undefined || parsed === JOB_MAX_ATTEMPTS_FROM_DEFINITION ? undefined : parsed
}

export interface StoredJob {
  id: string
  jobType: string
  jobVersion: number
  /** Normalized persistence projection; executionScope remains authoritative. */
  tenantId: string | null
  executionScope: JobExecutionScope
  /** Normalized persistence projection; executionScope remains authoritative. */
  scope: JobScope
  payload: string
  status: JobStatus
  priority: number
  attemptsCompleted: number
  currentAttempt: number
  /** Per-job attempt budget; undefined when the job uses its definition's maxAttempts. */
  maxAttempts?: number | undefined
  runAt: Date
  nextAttemptAt: Date | null
  leaseOwner: string | null
  leaseExpiresAt: Date | null
  claimToken: string | null
  idempotencyKey: string | null
  fingerprint: string
  correlationId: string | null
  lastError: string | null
  resultPayload: string | null
  metadata: Record<string, unknown> | null
  /** Serialization partition; at most one job per non-null partition runs at a time. */
  partitionKey: string | null
  createdAt: Date
  startedAt: Date | null
  completedAt: Date | null
}

export type JobResult =
  | { success: true; data?: Record<string, unknown>; error?: never }
  | { success: false; data?: Record<string, unknown>; error?: JobError }

export type JobFailureKind = "retryable" | "permanent" | "cancelled"
export type JobError = Error & { readonly kind?: JobFailureKind }

export interface RetryPolicy {
  maxAttempts: number
  delayMs: number
  backoffMultiplier: number
  maxDelayMs?: number
}

export class RetryableJobError extends Error {
  readonly kind = "retryable" as const
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "RetryableJobError"
  }
}

export class PermanentJobError extends Error {
  readonly kind = "permanent" as const
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "PermanentJobError"
  }
}

export class JobScopeMismatchError extends PermanentJobError {
  readonly storedScope: ExecutionScope["kind"]
  readonly definitionScope: JobScope

  constructor(storedScope: ExecutionScope["kind"], definitionScope: JobScope) {
    super(`Job scope mismatch: stored job is ${storedScope}, definition requires ${definitionScope}`)
    this.name = "JobScopeMismatchError"
    this.storedScope = storedScope
    this.definitionScope = definitionScope
  }
}

export class CancelledJobError extends Error {
  readonly kind = "cancelled" as const
  constructor(message = "Job cancelled", options?: ErrorOptions) {
    super(message, options)
    this.name = "CancelledJobError"
  }
}

export class MalformedJobPayloadError extends PermanentJobError {
  constructor(message = "Job payload is malformed", options?: ErrorOptions) {
    super(message, options)
    this.name = "MalformedJobPayloadError"
  }
}

export class InvalidJobPayloadError extends PermanentJobError {
  constructor(message = "Job payload failed schema validation", options?: ErrorOptions) {
    super(message, options)
    this.name = "InvalidJobPayloadError"
  }
}

export interface ClaimDueJobsArgs {
  limit: number
  workerId: string
  leaseDurationMs: number
  requester: JobRequester
  now?: Date
}

export interface RenewLeaseArgs {
  jobId: string
  workerId: string
  claimToken: string
  /** Duration in milliseconds to extend the lease. The DB computes the absolute expiry. */
  extendByMs: number
}

export class CorruptJobMetadataError extends PermanentJobError {
  constructor(message = "Job metadata is malformed", options?: ErrorOptions) {
    super(message, options)
    this.name = "CorruptJobMetadataError"
  }
}

export interface CompleteJobArgs {
  jobId: string
  workerId: string
  claimToken: string
  attempt: number
  result?: Record<string, unknown>
}

const MAX_JOB_JSON_DEPTH = 50
const MAX_JOB_JSON_TOTAL_KEYS = 10_000
const MAX_JOB_JSON_STRING_BYTES = 65_536
const MAX_JOB_JSON_SERIALIZED_BYTES = 1024 * 1024

export const MAX_DURABLE_JOB_TYPE_BYTES = 100
export const MAX_DURABLE_IDEMPOTENCY_KEY_BYTES = 255
export const MAX_DURABLE_CORRELATION_ID_BYTES = 100
export const MAX_DURABLE_SCOPE_BYTES = 10
export const MAX_DURABLE_WORKER_ID_BYTES = 100
export const MAX_DURABLE_PARTITION_KEY_BYTES = 255

/**
 * Bounds a durable identifier that maps to a DB column/index. Bounds are
 * measured in UTF-8 bytes (via TextEncoder) so multi-byte characters cannot
 * exceed the underlying column capacity.
 */
export function assertDurableIdentifier(value: string, label: string, maxBytes: number): void {
  if (typeof value !== "string") throw new TenantScopeViolationError(`${label} must be a string`)
  const bytes = new TextEncoder().encode(value).byteLength
  if (bytes > maxBytes) throw new TenantScopeViolationError(`${label} exceeds the maximum of ${maxBytes} bytes`)
}

/** Reject values that cannot be represented deterministically in durable JSON. */
export function assertDurableJob(job: NewJob, runAt: Date = job.runAt ?? new Date()): void {
  validateExecutionScope(job.executionScope)
  if (typeof job.jobType !== "string" || job.jobType.trim().length === 0) throw new TenantScopeViolationError("Job type must be non-empty")
  assertDurableIdentifier(job.jobType, "Job jobType", MAX_DURABLE_JOB_TYPE_BYTES)
  if (!Number.isSafeInteger(job.jobVersion) || job.jobVersion < 1) throw new TenantScopeViolationError("Job version must be a positive integer")
  if (!(runAt instanceof Date) || !Number.isFinite(runAt.getTime())) throw new TenantScopeViolationError("Job runAt must be a valid date")
  if (job.maxAttempts !== undefined && (!Number.isSafeInteger(job.maxAttempts) || job.maxAttempts < 1)) throw new TenantScopeViolationError("Job maxAttempts must be a positive integer")
  if (job.priority !== undefined && !Number.isSafeInteger(job.priority)) throw new TenantScopeViolationError("Job priority must be a safe integer")
  if (job.idempotencyKey !== undefined && (typeof job.idempotencyKey !== "string" || job.idempotencyKey.length === 0)) throw new TenantScopeViolationError("Job idempotencyKey must be non-empty")
  if (job.idempotencyKey !== undefined) assertDurableIdentifier(job.idempotencyKey, "Job idempotencyKey", MAX_DURABLE_IDEMPOTENCY_KEY_BYTES)
  if (job.correlationId !== undefined && (typeof job.correlationId !== "string" || job.correlationId.length === 0)) throw new TenantScopeViolationError("Job correlationId must be non-empty")
  if (job.correlationId !== undefined) assertDurableIdentifier(job.correlationId, "Job correlationId", MAX_DURABLE_CORRELATION_ID_BYTES)
  if (job.partitionKey !== undefined) {
    if (typeof job.partitionKey !== "string" || job.partitionKey.length === 0) throw new TenantScopeViolationError("Job partitionKey must be a non-empty string")
    assertDurableIdentifier(job.partitionKey, "Job partitionKey", MAX_DURABLE_PARTITION_KEY_BYTES)
  }
  const budget = { totalKeys: 0, totalBytes: 0 }
  assertJsonObject(job.payload, "Job payload", budget)
  if (job.metadata !== undefined) assertJsonObject(job.metadata, "Job metadata", budget)
}

interface JsonObjectBudget {
  totalKeys: number
  totalBytes: number
}

function assertJsonObject(value: unknown, label: string, budget: JsonObjectBudget): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TenantScopeViolationError(`${label} must be a JSON object`)
  const visited = new WeakSet<object>()
  const visit = (entry: unknown, depth: number): void => {
    if (depth > MAX_JOB_JSON_DEPTH) throw new TenantScopeViolationError(`${label} exceeds the maximum nesting depth of ${MAX_JOB_JSON_DEPTH}`)
    if (entry === undefined || typeof entry === "bigint" || typeof entry === "function" || typeof entry === "symbol" || (typeof entry === "number" && !Number.isFinite(entry))) throw new TenantScopeViolationError(`${label} contains a non-durable value`)
    if (entry === null) return
    if (typeof entry === "string") {
      const bytes = new TextEncoder().encode(entry).byteLength
      if (bytes > MAX_JOB_JSON_STRING_BYTES) throw new TenantScopeViolationError(`${label} contains a string longer than ${MAX_JOB_JSON_STRING_BYTES} bytes`)
      return
    }
    if (typeof entry === "number" || typeof entry === "boolean") return
    if (Array.isArray(entry)) {
      if (visited.has(entry)) throw new TenantScopeViolationError(`${label} contains a circular reference`)
      visited.add(entry)
      for (const item of entry) visit(item, depth + 1)
      visited.delete(entry)
      return
    }
    if (entry instanceof Date) throw new TenantScopeViolationError(`${label} contains a Date; only plain JSON values are allowed`)
    const prototype = Object.getPrototypeOf(entry) as object | null
    if (prototype !== Object.prototype && prototype !== null) throw new TenantScopeViolationError(`${label} contains a Map, Set, class instance, or non-plain object`)
    if (visited.has(entry)) throw new TenantScopeViolationError(`${label} contains a circular reference`)
    visited.add(entry)
    const record = entry as Record<string, unknown>
    const keys = Object.keys(record)
    budget.totalKeys += keys.length
    if (budget.totalKeys > MAX_JOB_JSON_TOTAL_KEYS) throw new TenantScopeViolationError(`${label} exceeds the maximum of ${MAX_JOB_JSON_TOTAL_KEYS} total keys`)
    for (const key of keys) {
      const keyBytes = new TextEncoder().encode(key).byteLength
      if (keyBytes > MAX_JOB_JSON_STRING_BYTES) throw new TenantScopeViolationError(`${label} contains a key longer than ${MAX_JOB_JSON_STRING_BYTES} bytes`)
      visit(record[key], depth + 1)
    }
    visited.delete(entry)
  }
  visit(value, 0)
  const serialized = JSON.stringify(value)
  if (serialized !== undefined) budget.totalBytes += new TextEncoder().encode(serialized).byteLength
  if (budget.totalBytes > MAX_JOB_JSON_SERIALIZED_BYTES) throw new TenantScopeViolationError(`${label} exceeds the maximum of ${MAX_JOB_JSON_SERIALIZED_BYTES} serialized bytes for payload and metadata`)
}

export interface JobTransitionResult {
  applied: boolean
  reason?: "LEASE_LOST" | "INVALID_STATE" | "HISTORY_FAILED"
  /** Present when the transition was applied and can be used by post-transition hooks. */
  transitionToken?: string
  /** Set when required execution history could not be persisted. */
  historyError?: string
}

export type ScheduleScope = "tenant" | "platform" | "system"

export interface LocalDateTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  dayOfWeek: number
}

export type CronDisambiguation = "skip" | "earlier" | "later" | "reject"

export interface CronTimezoneAdapter {
  toLocalDateTimeParts(utcDate: Date, timezone: string): LocalDateTime
  localToUtc(local: LocalDateTime, timezone: string, disambiguation?: CronDisambiguation): Date
}


export interface RetryJobArgs {
  jobId: string
  workerId: string
  claimToken: string
  nextAttemptAt: Date
  error: string
  attempt: number
}

/** Hands a claimed job back without consuming an attempt (e.g. this worker lacks its definition). */
export interface ReleaseJobArgs {
  jobId: string
  workerId: string
  claimToken: string
  /** Earliest time another worker may claim it. */
  nextAttemptAt: Date
  /** Stable reason recorded as the job's last error. */
  reason: string
}

export interface FailJobArgs {
  jobId: string
  workerId: string
  claimToken: string
  error: string
  status: "failed" | "dead_letter" | "cancelled"
  attempt: number
}

export interface OverlapPolicy {
  type: "allow" | "skip" | "queue"
}

export interface MisfirePolicy {
  type: "skip" | "fire_now" | "queue_all"
}

export interface ScheduleDefinition {
  id: string
  name: string
  jobType: string
  jobVersion: number
  tenantId: string | null
  payload: string
  cronExpression: string
  timezone: string
  enabled: boolean
  overlapPolicy: OverlapPolicy
  misfirePolicy: MisfirePolicy
  nextRunAt: Date | null
  lastRunAt: Date | null
  lastStatus: string | null
  createdAt: Date
  updatedAt: Date
}

export type JobRequester =
  | { scope: "system" }
  | { scope: "platform"; actorId: string; capabilities?: readonly JobEnqueueCapability[] }
  | { scope: "tenant"; tenantId: string; actorId: string }

export type JobEnqueueCapability = "enqueue:platform" | "enqueue:system"

export function assertJobScopeMatches(executionScope: ExecutionScope, definitionScope: JobScope): void {
  const actualScope = validateExecutionScope(executionScope).kind
  if (actualScope !== definitionScope) {
    throw new JobScopeMismatchError(actualScope, definitionScope)
  }
}

export interface GetJobByIdArgs {
  id: string
  requester: JobRequester
}

export interface GetByCorrelationIdArgs {
  correlationId: string
  requester: JobRequester
}

export interface GetLatestPriorScheduleExecutionArgs {
  scheduleId: string
  beforeOccurrence: Date
  requester: JobRequester
}

/** Stable correlation id used by every occurrence of a schedule. */
export function scheduleCorrelationId(scheduleId: string): string {
  return `sched:${scheduleId}`
}

export interface GetByIdempotencyKeyArgs {
  key: string
  requester: JobRequester
}

export interface CancelJobArgs {
  jobId: string
  requester: JobRequester
  reason?: string
}

export interface FindPendingArgs {
  requester: JobRequester
  jobType?: string
  limit?: number
}

export interface EnqueueJobArgs {
  requester: JobRequester
  job: NewJob
}

export function assertJobRequesterCanEnqueue(requester: JobRequester, jobTenantId: string | null | undefined): void {
  if (requester.scope === "tenant" && requester.tenantId !== (jobTenantId ?? null)) {
    throw new TenantScopeViolationError("Tenant requester may only enqueue jobs for its tenant", {
      requesterTenantId: requester.tenantId,
      jobTenantId: jobTenantId ?? null,
    })
  }
}

export interface JobStore {
  /**
   * When idempotencyKey is supplied, enqueue must atomically return the
   * existing job for the same scope and key instead of creating a duplicate.
   */
  enqueue(args: EnqueueJobArgs): Promise<StoredJob>
  getById(args: GetJobByIdArgs): Promise<StoredJob | null>
  getByCorrelationId(args: GetByCorrelationIdArgs): Promise<StoredJob[]>
  /**
   * Returns the single most recent job of the schedule correlation that ran
   * strictly before the given occurrence. This is a dedicated primitive so
   * overlap decisions never depend on a bounded top-N correlation list.
   */
  getLatestPriorScheduleExecution(args: GetLatestPriorScheduleExecutionArgs): Promise<StoredJob | null>
  getByIdempotencyKey(args: GetByIdempotencyKeyArgs): Promise<StoredJob | null>
  /** Every returned running job must carry a fresh, opaque claimToken. */
  claimDue(args: ClaimDueJobsArgs): Promise<StoredJob[]>
  renewLease(args: RenewLeaseArgs): Promise<boolean>
  markSucceeded(args: CompleteJobArgs): Promise<JobTransitionResult>
  markRetrying(args: RetryJobArgs): Promise<JobTransitionResult>
  markFailed(args: FailJobArgs): Promise<JobTransitionResult>
  /**
   * Optional: release a live claim without consuming an attempt. The attempt
   * counted at claim time is given back, the lease is cleared, and the job is
   * claimable again at `nextAttemptAt`. Fenced on worker, token, and lease.
   */
  release?(args: ReleaseJobArgs): Promise<JobTransitionResult>
  cancel(args: CancelJobArgs): Promise<JobTransitionResult>
  findPending(args: FindPendingArgs): Promise<StoredJob[]>
}

export class JobIdempotencyConflictError extends Error {
  readonly code = "JOB_IDEMPOTENCY_CONFLICT" as const
  constructor(public readonly scope: string, public readonly key: string) {
    super(`Job idempotency key already exists with a different fingerprint: ${scope}/${key}`)
    this.name = "JobIdempotencyConflictError"
  }
}

export function assertJobScopeCanEnqueue(scope: JobScope, jobTenantId: string | null | undefined): void {
  const hasTenant = jobTenantId !== null && jobTenantId !== undefined
  if ((scope === "tenant") !== hasTenant) {
    throw new TenantScopeViolationError("Tenant jobs require a tenant id and platform/system jobs must not have one", {
      scope,
      jobTenantId: jobTenantId ?? null,
    })
  }
}

export function requesterJobScope(requester: JobRequester): JobScope {
  return requester.scope
}

/**
 * Largest delay a host timer accepts. Larger values overflow the signed 32-bit
 * timer field and fire after ~1ms in Node and browsers, so every duration that
 * is fed to setTimeout must be validated against this ceiling.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Throws ConfigurationError when a timer duration exceeds MAX_TIMER_DELAY_MS. */
export function assertTimerDelayWithinLimit(name: string, ms: number): void {
  if (ms > MAX_TIMER_DELAY_MS) throw new ConfigurationError(`${name} must not exceed ${MAX_TIMER_DELAY_MS}ms (got ${ms}ms).`)
}

/** Job execution clock: the canonical core Clock plus sleep and optional timers. */
export interface ExecutionClock extends Clock {
  now(): Date
  /** Resolves after `ms`. Implementations should cancel the wait (and resolve) when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  setTimeout?(callback: () => void, ms: number): unknown
  clearTimeout?(handle: unknown): void
}

/**
 * Framework-owned external effect API. External calls that produce durable
 * side effects must go through this interface, which enforces the current
 * claim token/fence and an idempotency key. This makes the safe
 * path unavoidable rather than documentation-only.
 */
export interface FencedExternalEffect {
  /** Executes an external effect under the current claim token fence. */
  execute<T>(args: {
    effectName: string
    idempotencyKey: string
    fn: () => Promise<T>
  }): Promise<T>
}

export interface JobExecutionContext {
  executionId: string
  jobId: string
  jobType: string
  jobVersion: number
  attempt: number
  tenantId: string | null
  executionScope: JobExecutionScope
  correlationId: string
  startedAt: Date
  deadline?: number
  signal?: AbortSignal
  telemetry?: import("../telemetry/telemetry").TelemetryPort
  metadata: Record<string, unknown>
  clock?: ExecutionClock
  /** Framework-owned fence for external effects that produce durable side effects. */
  fencedEffect: FencedExternalEffect
  /** Token for an already-applied transition; this is not a running lease. */
  transitionToken?: string
}

/** Explicit requester-to-target matrix. Platform callers cannot create system work by default. */
export function assertRequesterCanEnqueueScope(requester: JobRequester, targetScope: JobScope, jobTenantId: string | null | undefined): void {
  assertJobRequesterCanEnqueue(requester, jobTenantId)
  const allowed = requester.scope === "system"
    ? true
    : requester.scope === "tenant"
      ? targetScope === "tenant"
      : targetScope === "platform" || requester.capabilities?.includes("enqueue:system") === true
  if (!allowed) {
    throw new TenantScopeViolationError(`Requester scope ${requester.scope} cannot enqueue ${targetScope} jobs`, {
      requesterScope: requester.scope,
      targetScope,
      capability: "enqueue:system",
    })
  }
  if (requester.scope === "tenant" && targetScope !== "tenant") {
    throw new TenantScopeViolationError("Tenant requester may only enqueue tenant jobs", { targetScope })
  }
}

export interface JobDefinition<TPayload = Record<string, unknown>> {
  type: string
  version: number
  scope: JobScope
  maxAttempts: number
  retryDelayMs: number
  retryBackoffMultiplier: number
  timeoutMs?: number
  decodePayload(input: unknown): TPayload
  execute(args: JobExecution<TPayload>): Promise<JobResult>
  onRetry?(args: JobExecution<TPayload>, error: Error): Promise<void>
  onMaxRetriesExceeded?(args: JobExecution<TPayload>, error: Error): Promise<void>
}

export type JobExecution<TPayload = Record<string, unknown>> = JobExecutionContext & {
  payload: TPayload
}

export interface ScheduleOccurrence {
  scheduleId: string
  jobType: string
  jobVersion: number
  tenantId: string | null
  payload: string
  correlationId: string
  scheduledAt: Date
}

export interface ScheduleClaim {
  scheduleId: string
  executionScope: JobExecutionScope
  /** Normalized persistence projection; executionScope remains authoritative. */
  scope: ScheduleScope
  jobType: string
  jobVersion: number
  /** Normalized persistence projection; executionScope remains authoritative. */
  tenantId: string | null
  payload: string
  cronExpression: string
  timezone: string
  overlapPolicy: OverlapPolicy
  misfirePolicy: MisfirePolicy
  nextRunAt: Date
  lastRunAt: Date | null
  lastStatus: string | null
  lifecycle?: import("./scheduleLifecycle").ScheduleLifecycle
}

export interface ClaimDueSchedulesArgs {
  workerId: string
  limit: number
  now?: Date
  leaseDurationMs: number
}

export interface AdvanceScheduleArgs {
  scheduleId: string
  workerId: string
  nextRunAt: Date | null
  lastRunAt: Date
  lastStatus: string
  lastError?: string
  /**
   * Occurrences consumed by this advance; stores subtract it from
   * remainingOccurrences (never below zero). When omitted, a `fired` advance
   * consumes one occurrence and any other status consumes none.
   */
  occurrencesFired?: number
  /**
   * With lastStatus `failed`: the schedule keeps nextRunAt (the occurrence
   * that failed) but must not be claimed again before this instant, so a
   * persistently failing schedule backs off instead of starving others.
   */
  retryAt?: Date
}

/** remainingOccurrences decrement for an advance (see AdvanceScheduleArgs.occurrencesFired). */
export function scheduleOccurrencesConsumed(args: Pick<AdvanceScheduleArgs, "lastStatus" | "occurrencesFired">): number {
  if (args.occurrencesFired !== undefined) {
    if (!Number.isSafeInteger(args.occurrencesFired) || args.occurrencesFired < 0) throw new ConfigurationError("occurrencesFired must be a non-negative integer")
    return args.occurrencesFired
  }
  return args.lastStatus === "fired" ? 1 : 0
}

export interface ReleaseScheduleArgs {
  scheduleId: string
  workerId: string
}

export function requesterTenantId(requester: JobRequester): string | null {
  if (requester.scope === "tenant") return requester.tenantId
  return null
}

export function isSystemOrPlatform(requester: JobRequester): boolean {
  return requester.scope === "system" || requester.scope === "platform"
}

export function requesterToActorId(requester: JobRequester): string {
  switch (requester.scope) {
    case "system": return "system"
    case "platform": return requester.actorId
    case "tenant": return requester.actorId
  }
}
