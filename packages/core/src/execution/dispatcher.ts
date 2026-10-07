import type { JobRegistry } from "./jobRegistry"
import { shouldRetry, computeNextAttemptAt, validateRetryPolicy } from "./retryPolicy"
import type {
  CompleteJobArgs,
  ExecutionClock,
  JobDefinition,
  JobError,
  JobFailureKind,
  JobRequester,
  JobResult,
  JobStore,
  RetryJobArgs,
  RetryPolicy,
  StoredJob,
} from "./types"
import { InvalidJobPayloadError, MalformedJobPayloadError } from "./types"
import { assertJobScopeMatches } from "./types"
import { createExecutionContext } from "./executionContext"
import { ValidationError } from "../domain"
import { createTelemetryLogger, type TelemetryLogger, type TelemetryPort } from "../telemetry/telemetry"

export const MAX_STORED_JOB_PAYLOAD_BYTES = 1024 * 1024

export interface DispatchResult {
  claimed: number
  succeeded: number
  failed: number
  retried: number
  deadLettered: number
  leaseLost: number
  stalled: number
  errors: DispatchError[]
}

export interface DispatchError {
  jobId: string
  jobType: string
  error: string
  action: "retry" | "failed" | "dead_letter" | "lease_lost" | "stalled"
}

export type DispatcherClock = ExecutionClock

type DispatcherLogger = TelemetryLogger

export interface DispatcherConfig {
  store: JobStore
  registry: JobRegistry
  workerId: string
  leaseDurationMs: number
  claimLimit: number
  requester: JobRequester
  clock?: DispatcherClock
  telemetry?: TelemetryPort
  timeoutPolicy?: JobTimeoutPolicy
  idGenerator?: () => string
}

export interface JobTimeoutPolicy {
  mode: "cooperative"
  timeoutMs?: number
  cancellationGraceMs: number
}

const systemClock: DispatcherClock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function decodeJobPayload<TPayload = Record<string, unknown>>(payload: string, decode: (input: unknown) => TPayload = (input) => input as TPayload): TPayload {
  if (typeof payload !== "string" || new TextEncoder().encode(payload).byteLength > MAX_STORED_JOB_PAYLOAD_BYTES) {
    throw new MalformedJobPayloadError(`Job payload exceeds the maximum of ${MAX_STORED_JOB_PAYLOAD_BYTES} bytes`)
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(payload)
  } catch (error) {
    throw new MalformedJobPayloadError("Job payload is not valid JSON", { cause: error })
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new MalformedJobPayloadError("Job payload must be a JSON object")
  }
  try {
    return decode(decoded)
  } catch (error) {
    if (error instanceof InvalidJobPayloadError) throw error
    throw new InvalidJobPayloadError(error instanceof Error ? error.message : "Job payload failed schema validation", { cause: error })
  }
}

type OutcomeKind = "succeeded" | "retried" | "failed" | "dead_letter" | "lease_lost" | "stalled"
type JobOutcome = { kind: OutcomeKind; error?: string }
type FailureKind = JobFailureKind

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function classifyFailure(error: unknown): FailureKind {
  if (error && typeof error === "object" && "kind" in error) {
    const kind = (error as { kind?: unknown }).kind
    if (kind === "permanent" || kind === "cancelled" || kind === "retryable") return kind
  }
  return "retryable"
}

function resultError(result: JobResult): JobError | string {
  if (result.error) return result.error
  const message = result.data?.errorMessage
  return typeof message === "string" ? message : "Job returned unsuccessful result"
}

async function waitForExecutionSettlement(executionPromise: Promise<JobResult>, maxWaitMs: number, clock: DispatcherClock): Promise<boolean> {
  let timeoutId: unknown
  const settlement = executionPromise.then(() => true, () => true)
  const timeout = new Promise<boolean>((resolve) => {
    const callback = () => resolve(false)
    timeoutId = clock.setTimeout?.(callback, Math.max(1, maxWaitMs))
    if (timeoutId === undefined) timeoutId = setTimeout(callback, Math.max(1, maxWaitMs))
  })
  const settled = await Promise.race([settlement, timeout])
  if (timeoutId !== undefined) {
    if (clock.clearTimeout) clock.clearTimeout(timeoutId)
    else clearTimeout(timeoutId as ReturnType<typeof setTimeout>)
  }
  return settled
}

async function renewWithDeadline(operation: Promise<boolean>, leaseDurationMs: number, clock: DispatcherClock): Promise<boolean> {
  let timeoutId: unknown
  const timeout = new Promise<never>((_resolve, reject) => {
    const callback = () => reject(new Error("Job lease renewal timed out"))
    timeoutId = clock.setTimeout?.(callback, Math.max(1, Math.floor(leaseDurationMs / 2)))
    if (timeoutId === undefined) timeoutId = setTimeout(callback, Math.max(1, Math.floor(leaseDurationMs / 2)))
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timeoutId !== undefined) {
      if (clock.clearTimeout) clock.clearTimeout(timeoutId)
      else clearTimeout(timeoutId as ReturnType<typeof setTimeout>)
    }
  }
}

async function markFailedState(args: Parameters<JobStore["markFailed"]>[0], store: JobStore): Promise<{ applied: boolean; error?: string }> {
  try {
    const status = await store.markFailed(args)
    return status.applied ? status : { applied: false, error: status.reason === "HISTORY_FAILED" ? status.historyError ?? "Required execution history could not be persisted" : "Job lease was lost" }
  } catch (error) {
    return { applied: false, error: errorMessage(error) }
  }
}

export async function dispatchDueJobs(config: DispatcherConfig): Promise<DispatchResult> {
  validateDispatcherConfig(config)
  const clock = config.clock ?? systemClock
  const result: DispatchResult = { claimed: 0, succeeded: 0, failed: 0, retried: 0, deadLettered: 0, leaseLost: 0, stalled: 0, errors: [] }
  const log = createTelemetryLogger(config.telemetry, "execution.dispatch", () => clock.now())
  const jobs = await config.store.claimDue({
    limit: config.claimLimit,
    workerId: config.workerId,
    leaseDurationMs: config.leaseDurationMs,
    requester: config.requester,
    now: clock.now(),
  })
  result.claimed = jobs.length
  log.info("Dispatch claimed jobs", { workerId: config.workerId, claimed: jobs.length, claimLimit: config.claimLimit })
  if (jobs.length === 0) log.debug?.("No jobs to dispatch", { workerId: config.workerId })

  for (const job of jobs) {
    const outcome = await executeJob({ ...config, job, log, clock })
    if (outcome.kind === "succeeded") result.succeeded++
    else if (outcome.kind === "failed") result.failed++
    else if (outcome.kind === "retried") result.retried++
    else if (outcome.kind === "dead_letter") result.deadLettered++
    else if (outcome.kind === "stalled") result.stalled++
    else result.leaseLost++
    if (outcome.error) {
      const action = outcome.kind === "dead_letter" ? "dead_letter" : outcome.kind === "lease_lost" ? "lease_lost" : outcome.kind === "stalled" ? "stalled" : outcome.kind === "retried" ? "retry" : "failed"
      result.errors.push({ jobId: job.id, jobType: job.jobType, error: outcome.error, action })
    }
    // P2-04 observability: structured per-job outcome logging
    if (outcome.kind === "succeeded" && !outcome.error) {
      log.debug?.("Job succeeded", { jobId: job.id, jobType: job.jobType, attempt: job.currentAttempt })
    } else if (outcome.kind === "succeeded" && outcome.error) {
      log.warn?.("Job succeeded with history error", { jobId: job.id, jobType: job.jobType, error: outcome.error })
    } else if (outcome.kind === "lease_lost") {
      log.warn?.("Job lease lost", { jobId: job.id, jobType: job.jobType, claimToken: job.claimToken ?? undefined, error: outcome.error })
    } else if (outcome.kind === "stalled") {
      log.error("Job stalled", { jobId: job.id, jobType: job.jobType, error: outcome.error })
    } else if (outcome.kind === "retried") {
      // handleJobError already logs retry; add historyError visibility
      if (outcome.error?.includes("history")) log.warn?.("Job retried with history error", { jobId: job.id, error: outcome.error })
    } else if (outcome.kind === "failed" || outcome.kind === "dead_letter") {
      log.error("Job failed", { jobId: job.id, jobType: job.jobType, kind: outcome.kind, error: outcome.error })
    }
  }
  log.info("Dispatch batch completed", {
    workerId: config.workerId,
    claimed: result.claimed,
    succeeded: result.succeeded,
    failed: result.failed,
    retried: result.retried,
    deadLettered: result.deadLettered,
    leaseLost: result.leaseLost,
    stalled: result.stalled,
  })
  return result
}

async function executeJob(args: DispatcherConfig & { job: StoredJob; log: DispatcherLogger; clock: DispatcherClock }): Promise<JobOutcome> {
  const { job, store, registry, workerId, leaseDurationMs, log, clock } = args
  if (!job.claimToken) {
    log.warn?.("Claimed job missing claim token", { jobId: job.id, jobType: job.jobType })
    return { kind: "lease_lost", error: "Claimed job has no claim token" }
  }
  const claimToken = job.claimToken

  // P1-08 fencing: a batch claim can wait behind an earlier job. Re-fence it
  // immediately before execution instead of trusting the lease it received in
  // the batch. This validates the opaque claimToken atomically.
  try {
    const renewed = await renewWithDeadline(store.renewLease({
      jobId: job.id,
      workerId,
      claimToken,
      extendByMs: leaseDurationMs,
    }), leaseDurationMs, clock)
    if (!renewed) {
      log.warn?.("Job lease re-fence rejected", { jobId: job.id, workerId, claimToken })
      return { kind: "lease_lost", error: "Job lease was lost" }
    }
  } catch (error) {
    log.warn?.("Job lease re-fence threw", { jobId: job.id, workerId, error: errorMessage(error) })
    return { kind: "lease_lost", error: errorMessage(error) }
  }

  const def = registry.get(job.jobType, job.jobVersion)
  if (!def) {
    const error = `Unknown job definition: ${job.jobType}@${job.jobVersion}`
    const status = await markFailedState({ jobId: job.id, workerId, claimToken: job.claimToken, error, status: "failed", attempt: job.attemptsCompleted + 1 }, store)
    return status.applied ? { kind: "failed", error } : { kind: "lease_lost", error: status.error ?? error }
  }

  try {
    assertJobScopeMatches(job.executionScope, def.scope)
  } catch (error) {
    const message = errorMessage(error)
    const status = await markFailedState({ jobId: job.id, workerId, claimToken: job.claimToken, error: message, status: "dead_letter", attempt: job.currentAttempt }, store)
    return status.applied ? { kind: "dead_letter", error: message } : { kind: "lease_lost", error: status.error ?? message }
  }

  const retryPolicy: RetryPolicy = {
    // Persisted job settings take precedence; undefined means no job override.
    maxAttempts: job.maxAttempts === undefined ? def.maxAttempts : job.maxAttempts,
    delayMs: def.retryDelayMs,
    backoffMultiplier: def.retryBackoffMultiplier,
  }
  try {
    validateRetryPolicy(retryPolicy)
  } catch (validationError) {
    const error = `Invalid retry policy: ${errorMessage(validationError)}`
    const status = await markFailedState({ jobId: job.id, workerId, claimToken: job.claimToken, error, status: "dead_letter", attempt: job.currentAttempt }, store)
    return status.applied ? { kind: "dead_letter", error } : { kind: "lease_lost", error: status.error ?? error }
  }

  if (job.currentAttempt > retryPolicy.maxAttempts) {
    const error = `Job attempt ${job.currentAttempt} exceeds maxAttempts ${retryPolicy.maxAttempts}`
    const status = await markFailedState({ jobId: job.id, workerId, claimToken: job.claimToken, error, status: "dead_letter", attempt: job.currentAttempt }, store)
    return status.applied ? { kind: "dead_letter", error } : { kind: "lease_lost", error: status.error ?? error }
  }

  let payload: Record<string, unknown>
  try {
    payload = decodeJobPayload<Record<string, unknown>>(job.payload, (input) => def.decodePayload(input))
  } catch (error) {
    const message = errorMessage(error)
    const status = await markFailedState({ jobId: job.id, workerId, claimToken: job.claimToken, error: message, status: "dead_letter", attempt: job.currentAttempt }, store)
    return status.applied ? { kind: "dead_letter", error: message } : { kind: "lease_lost", error: status.error ?? message }
  }

  const timeoutMs = args.timeoutPolicy?.timeoutMs ?? def.timeoutMs ?? leaseDurationMs
  const cancellationGraceMs = args.timeoutPolicy?.cancellationGraceMs ?? leaseDurationMs
  const controller = new AbortController()
  const startedAt = clock.now()
  let leaseLost = false
  let stopped = false
  let renewalInFlight: Promise<void> | undefined
  let resolveLeaseLost: (() => void) | undefined
  const leaseLostPromise = new Promise<never>((_, reject) => { resolveLeaseLost = () => reject(new Error("Job lease was lost")) })
  const markLeaseLost = (error: unknown): void => {
    if (leaseLost) return
    leaseLost = true
    controller.abort(error instanceof Error ? error : new Error("Job lease was lost"))
    resolveLeaseLost?.()
  }
  const renewCurrentLease = (): Promise<void> => {
    if (leaseLost) return Promise.reject(new Error("Job lease was lost"))
    if (renewalInFlight) return renewalInFlight
    const operation = (async (): Promise<void> => {
      const renewed = await renewWithDeadline(store.renewLease({ jobId: job.id, workerId, claimToken, extendByMs: leaseDurationMs }), leaseDurationMs, clock)
      if (!renewed) throw new Error("Job lease was lost")
    })()
    let tracked: Promise<void>
    tracked = operation.then(
      () => { if (renewalInFlight === tracked) renewalInFlight = undefined },
      (error: unknown) => {
        if (renewalInFlight === tracked) renewalInFlight = undefined
        markLeaseLost(error)
        throw error
      },
    )
    renewalInFlight = tracked
    return tracked
  }
  const execution = {
    ...createExecutionContext({
       executionId: args.idGenerator?.() ?? crypto.randomUUID(),
      jobId: job.id,
      jobType: job.jobType,
      jobVersion: job.jobVersion,
      attempt: job.currentAttempt,
      tenantId: job.executionScope.kind === "tenant" ? job.executionScope.tenantId : null,
      executionScope: job.executionScope,
      correlationId: job.correlationId ?? "",
      startedAt,
      deadline: startedAt.getTime() + timeoutMs,
      ...(args.telemetry ? { telemetry: args.telemetry } : {}),
      signal: controller.signal,
      metadata: job.metadata ?? {},
      clock,
      assertLease: renewCurrentLease,
     }),
    payload,
  }
  let heartbeatPromise: Promise<void> | undefined
  let resolveHeartbeatStop: (() => void) | undefined
  const heartbeatStop = new Promise<void>((resolve) => { resolveHeartbeatStop = resolve })
  const heartbeat = async (): Promise<void> => {
    while (!stopped) {
      try {
        await Promise.race([clock.sleep(Math.max(1, leaseDurationMs / 3)), heartbeatStop])
      } catch (sleepError) {
        log.warn?.("Job heartbeat sleep failed; treating as lease lost", { jobId: job.id, error: errorMessage(sleepError) })
        const error = new Error("Job lease renewal failed")
        markLeaseLost(error)
        return
      }
      if (stopped) return
      try {
        await renewCurrentLease()
      } catch (renewError) {
        log.warn?.("Job heartbeat lease renewal failed", { jobId: job.id, error: errorMessage(renewError), claimToken })
        return
      }
    }
  }

  let timedOut = false
  let executionPromise: Promise<JobResult> | undefined
  let timeoutId: unknown
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      const callback = () => {
        timedOut = true
        const error = new Error(`Job ${job.id} timed out after ${timeoutMs}ms`)
        controller.abort(error)
        reject(error)
      }
      timeoutId = clock.setTimeout?.(callback, timeoutMs)
      if (timeoutId === undefined) timeoutId = setTimeout(callback, timeoutMs)
    })
    heartbeatPromise = heartbeat()
    executionPromise = def.execute(execution)
    const executionResult = await Promise.race([executionPromise, timeoutPromise, leaseLostPromise])
    // Completion must not overtake a renewal that already started. Otherwise a
    // fast execution settlement can be committed while that renewal is about
    // to prove the claim stale.
    if (renewalInFlight) await renewalInFlight
    if (leaseLost) {
      if (executionPromise !== undefined) await waitForExecutionSettlement(executionPromise, cancellationGraceMs, clock)
      return { kind: "lease_lost", error: "Job lease was lost" }
    }
    if (!executionResult.success) {
      const error = resultError(executionResult)
      return handleJobError({ job, store, def, retryPolicy, workerId, claimToken: job.claimToken, execution, error: errorMessage(error), failureKind: classifyFailure(error), now: () => clock.now(), log })
    }
    const completeArgs: CompleteJobArgs = { jobId: job.id, workerId, claimToken, attempt: job.currentAttempt }
    if (executionResult.data) completeArgs.result = executionResult.data
    let status: Awaited<ReturnType<JobStore["markSucceeded"]>>
    try {
      status = await store.markSucceeded(completeArgs)
    } catch (statusError) {
      log.error("Job markSucceeded threw", { jobId: job.id, error: errorMessage(statusError), claimToken })
      return { kind: "lease_lost", error: errorMessage(statusError) }
    }
    if (!status.applied) {
      log.warn?.("Job markSucceeded not applied; lease lost", { jobId: job.id, claimToken, reason: status.reason })
      return { kind: "lease_lost", error: "Job lease was lost" }
    }
    if (status.historyError) log.warn?.("Job succeeded but history failed", { jobId: job.id, historyError: status.historyError })
    return status.historyError ? { kind: "succeeded", error: status.historyError } : { kind: "succeeded" }
  } catch (error) {
    if (timedOut && executionPromise) {
      const settled = await waitForExecutionSettlement(executionPromise, cancellationGraceMs, clock)
      if (!settled) return { kind: "stalled", error: `Job ${job.id} did not stop within the ${cancellationGraceMs}ms cancellation grace period.` }
    }
    if (leaseLost) {
      if (executionPromise !== undefined) await waitForExecutionSettlement(executionPromise, cancellationGraceMs, clock)
      return { kind: "lease_lost", error: "Job lease was lost" }
    }
    const message = timedOut ? `Job ${job.id} timed out after ${timeoutMs}ms` : errorMessage(error)
    return handleJobError({ job, store, def, retryPolicy, workerId, claimToken: job.claimToken, execution, error: message, failureKind: timedOut ? "retryable" : classifyFailure(error), now: () => clock.now(), log })
  } finally {
    stopped = true
    resolveHeartbeatStop?.()
    await heartbeatPromise
    if (timeoutId !== undefined) {
      if (clock.clearTimeout) clock.clearTimeout(timeoutId)
      else clearTimeout(timeoutId as ReturnType<typeof setTimeout>)
    }
  }
}

function validateDispatcherConfig(config: DispatcherConfig): void {
  if (config.workerId.trim().length === 0) throw new ValidationError("workerId must be non-empty")
  if (!Number.isInteger(config.claimLimit) || config.claimLimit < 1) throw new ValidationError("claimLimit must be a positive integer")
  const MAX_CLAIM_LIMIT = 100
  if (config.claimLimit > MAX_CLAIM_LIMIT) throw new ValidationError(`Claim limit ${config.claimLimit} exceeds maximum ${MAX_CLAIM_LIMIT}`)
  if (!Number.isFinite(config.leaseDurationMs) || config.leaseDurationMs <= 0) throw new ValidationError("leaseDurationMs must be positive")
  if (config.timeoutPolicy) {
    if (!Number.isFinite(config.timeoutPolicy.cancellationGraceMs) || config.timeoutPolicy.cancellationGraceMs < 0) {
      throw new ValidationError("cancellationGraceMs must be finite and non-negative")
    }
    if (config.timeoutPolicy.timeoutMs !== undefined && (!Number.isFinite(config.timeoutPolicy.timeoutMs) || config.timeoutPolicy.timeoutMs <= 0)) {
      throw new ValidationError("timeoutMs must be finite and positive")
    }
  }
}

async function handleJobError(args: {
  job: StoredJob
  store: JobStore
  def: JobDefinition
  retryPolicy: RetryPolicy
  workerId: string
  claimToken: string
  execution: Parameters<JobDefinition["execute"]>[0]
  error: string
  failureKind: FailureKind
  now: () => Date
  log: DispatcherLogger
}): Promise<JobOutcome> {
  const { job, store, def, retryPolicy, workerId, claimToken, execution, error, failureKind, now, log } = args
  if (failureKind === "cancelled") {
    const status = await markFailedState({ jobId: job.id, workerId, claimToken, error, status: "cancelled", attempt: job.attemptsCompleted + 1 }, store)
    if (!status.applied) log.warn?.("Job cancelled transition not applied", { jobId: job.id, error: status.error ?? error, claimToken })
    return status.applied ? { kind: "failed", error } : { kind: "lease_lost", error: status.error ?? error }
  }
  const attempt = job.attemptsCompleted + 1
  if (failureKind === "retryable" && shouldRetry({ policy: retryPolicy, attempt })) {
    const nextAttemptAt = computeNextAttemptAt({ policy: retryPolicy, attempt, now: now() })
    if (nextAttemptAt) {
      const retryArgs: RetryJobArgs = { jobId: job.id, workerId, claimToken, nextAttemptAt, error, attempt }
      let status: Awaited<ReturnType<JobStore["markRetrying"]>>
      try {
        status = await store.markRetrying(retryArgs)
      } catch (statusError) {
        log.error("Job markRetrying threw", { jobId: job.id, error: errorMessage(statusError), claimToken })
        return { kind: "lease_lost", error: errorMessage(statusError) }
      }
       if (!status.applied) {
         log.warn?.("Job markRetrying not applied; lease lost", { jobId: job.id, claimToken, reason: status.reason })
         return { kind: "lease_lost", error }
       }
       if (status.historyError) {
         log.warn?.("Job retry history error", { jobId: job.id, historyError: status.historyError })
         return { kind: "retried", error: status.historyError }
       }
      log.info("Job will retry", { jobId: job.id, jobType: job.jobType, attempt, nextAttemptAt })
       if (def.onRetry) {
         if (status.transitionToken) execution.transitionToken = status.transitionToken
         try { await def.onRetry(execution, new Error(error)) }
         catch (hookError) { log.error("onRetry hook failed", { jobId: job.id, error: errorMessage(hookError) }); return { kind: "retried", error: `${error}; onRetry hook failed: ${errorMessage(hookError)}` } }
       }
      return { kind: "retried", error }
    }
  }
  let status: Awaited<ReturnType<JobStore["markFailed"]>>
  try {
    status = await store.markFailed({ jobId: job.id, workerId, claimToken, error, status: "dead_letter", attempt })
  } catch (statusError) {
    log.error("Job markFailed threw", { jobId: job.id, error: errorMessage(statusError), claimToken })
    return { kind: "lease_lost", error: errorMessage(statusError) }
  }
  if (!status.applied) {
    log.warn?.("Job markFailed not applied; lease lost", { jobId: job.id, claimToken, reason: status.reason })
    return { kind: "lease_lost", error }
  }
  if (status.historyError) log.warn?.("Job dead_letter history error", { jobId: job.id, historyError: status.historyError })
  if (status.historyError) return { kind: "dead_letter", error: `${error}; ${status.historyError}` }
  if (def.onMaxRetriesExceeded) {
    if (status.transitionToken) execution.transitionToken = status.transitionToken
    try { await def.onMaxRetriesExceeded(execution, new Error(error)) }
    catch (hookError) { log.error("onMaxRetriesExceeded hook failed", { jobId: job.id, error: errorMessage(hookError) }); return { kind: "dead_letter", error: `${error}; onMaxRetriesExceeded hook failed: ${errorMessage(hookError)}` } }
  }
  return { kind: "dead_letter", error: status.historyError ? `${error}; ${status.historyError}` : error }
}
