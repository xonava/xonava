import { JobDefinitionUnavailableError, type JobRegistry } from "./jobRegistry"
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
import { assertJobScopeMatches, assertTimerDelayWithinLimit } from "./types"
import { createExecutionContext } from "./executionContext"
import { ConfigurationError, ValidationError } from "../domain"
import { createTelemetryLogger, type TelemetryLogger, type TelemetryPort } from "../telemetry/telemetry"

export const MAX_STORED_JOB_PAYLOAD_BYTES = 1024 * 1024

/**
 * Upper bound, in UTF-8 bytes, of the failure text handed to a store as a job's last error. Handler error messages
 * are unbounded (an HTTP body, a stack), and a store rejecting an over-long value (MySQL TEXT holds 65,535 bytes)
 * would leave the failed job running until its lease lapses and then re-run its handler without any backoff.
 */
export const MAX_JOB_ERROR_BYTES = 16 * 1024
const JOB_ERROR_TRUNCATION_MARKER = "... [truncated]"

/** Cuts `message` to at most MAX_JOB_ERROR_BYTES UTF-8 bytes (marker included) without splitting a character. */
export function boundJobErrorMessage(message: string): string {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(message)
  if (bytes.byteLength <= MAX_JOB_ERROR_BYTES) return message
  let cut = MAX_JOB_ERROR_BYTES - encoder.encode(JOB_ERROR_TRUNCATION_MARKER).byteLength
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--
  return `${new TextDecoder().decode(bytes.subarray(0, cut))}${JOB_ERROR_TRUNCATION_MARKER}`
}

/**
 * How long a job that no registered definition can run is handed back for
 * another worker (rolling deploys) before it is dead-lettered with
 * UNKNOWN_JOB_DEFINITION. Measured from the job's first consecutive deferral
 * (see unrunnableSince), never from when it became due.
 */
export const DEFAULT_UNKNOWN_DEFINITION_MAX_DEFERRAL_MS = 24 * 60 * 60 * 1000

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
  /** See DEFAULT_UNKNOWN_DEFINITION_MAX_DEFERRAL_MS. */
  unknownDefinitionMaxDeferralMs?: number
}

export interface JobTimeoutPolicy {
  mode: "cooperative"
  timeoutMs?: number
  cancellationGraceMs: number
}

const systemClock: DispatcherClock = {
  now: () => new Date(),
  sleep: (ms, signal) => abortableSleep(ms, signal),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** setTimeout-backed sleep that clears its timer and resolves early when `signal` aborts. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(handle)
      resolve()
    }
    const handle = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
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

  const resolved = resolveJobDefinition(registry, job)
  if (!resolved) return deferUnrunnableJob(args, claimToken, `Unknown job definition: ${job.jobType}@${job.jobVersion}`)
  const def = resolved.definition

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
  let unavailable: JobDefinitionUnavailableError | undefined
  try {
    payload = decodeJobPayload<Record<string, unknown>>(job.payload, (input) => {
      if (!resolved.upcast) return def.decodePayload(input)
      try {
        return registry.decode(job.jobType, job.jobVersion, input, def.version).payload as Record<string, unknown>
      } catch (error) {
        if (error instanceof JobDefinitionUnavailableError) unavailable = error
        throw error
      }
    })
  } catch (error) {
    // No upcaster path from the stored version on this worker: another worker
    // may still hold the stored version's definition.
    if (unavailable) return deferUnrunnableJob(args, claimToken, unavailable.message)
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
  // The race below is the only consumer. When execute() throws before the race starts, a lease lost while the failure is
  // being recorded would otherwise reject with no handler attached and surface as an unhandled rejection.
  leaseLostPromise.catch(() => undefined)
  const markLeaseLost = (error: unknown): void => {
    if (leaseLost) return
    leaseLost = true
    controller.abort(error instanceof Error ? error : new Error("Job lease was lost"))
    resolveLeaseLost?.()
  }
  const renewCurrentLease = (): Promise<void> => {
    if (leaseLost) return Promise.reject(new Error("Job lease was lost"))
    // Once the dispatcher has finished with this claim (including a stalled,
    // abandoned execution), late job code must neither pass the fence nor
    // keep the lease alive.
    if (stopped) return Promise.reject(new Error("Job lease was lost: the claim is no longer active"))
    if (renewalInFlight) return renewalInFlight
    const operation = (async (): Promise<void> => {
      const renewed = await renewWithDeadline(store.renewLease({ jobId: job.id, workerId, claimToken, extendByMs: leaseDurationMs }), leaseDurationMs, clock)
      if (!renewed) throw new Error("Job lease was lost")
    })()
    const tracked: Promise<void> = operation.then(
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
  // Aborted when execution finishes so the pending heartbeat timer is cleared
  // instead of keeping the process alive for up to leaseDurationMs / 3.
  const heartbeatAbort = new AbortController()
  const heartbeat = async (): Promise<void> => {
    while (!stopped) {
      try {
        await Promise.race([clock.sleep(Math.max(1, leaseDurationMs / 3), heartbeatAbort.signal), heartbeatStop])
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

  // Idempotent: ends the heartbeat and closes the claim's fence.
  const stopHeartbeat = async (): Promise<void> => {
    stopped = true
    heartbeatAbort.abort()
    resolveHeartbeatStop?.()
    await heartbeatPromise
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
    timeoutPromise.catch(() => undefined)
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
      // Awaited inside the try so the heartbeat keeps the lease alive until the
      // retry/dead-letter transition has committed.
      return await handleJobError({ job, store, def, retryPolicy, workerId, claimToken: job.claimToken, execution, error: errorMessage(error), failureKind: classifyFailure(error), now: () => clock.now(), log, onTransitionSettled: stopHeartbeat })
    }
    const completeArgs: CompleteJobArgs = { jobId: job.id, workerId, claimToken, attempt: job.currentAttempt }
    if (executionResult.data) {
      // Stores persist the result as JSON. A result that cannot be serialized would make markSucceeded throw after the
      // handler already ran, leaving the job running until its lease lapses and then re-executing the handler on every
      // later attempt. Fail it permanently here instead, once.
      try {
        JSON.stringify(executionResult.data)
      } catch (serializationError) {
        return await handleJobError({ job, store, def, retryPolicy, workerId, claimToken: job.claimToken, execution, error: `Job result is not JSON-serializable: ${errorMessage(serializationError)}`, failureKind: "permanent", now: () => clock.now(), log, onTransitionSettled: stopHeartbeat })
      }
      completeArgs.result = executionResult.data
    }
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
      if (!settled) {
        // Abandon the claim: the still-running execution is fenced off (see
        // renewCurrentLease) and its lease lapses instead of being renewed.
        stopped = true
        return { kind: "stalled", error: `Job ${job.id} did not stop within the ${cancellationGraceMs}ms cancellation grace period.` }
      }
    }
    if (leaseLost) {
      if (executionPromise !== undefined) await waitForExecutionSettlement(executionPromise, cancellationGraceMs, clock)
      return { kind: "lease_lost", error: "Job lease was lost" }
    }
    const message = timedOut ? `Job ${job.id} timed out after ${timeoutMs}ms` : errorMessage(error)
    return await handleJobError({ job, store, def, retryPolicy, workerId, claimToken: job.claimToken, execution, error: message, failureKind: timedOut ? "retryable" : classifyFailure(error), now: () => clock.now(), log, onTransitionSettled: stopHeartbeat })
  } finally {
    await stopHeartbeat()
    if (timeoutId !== undefined) {
      if (clock.clearTimeout) clock.clearTimeout(timeoutId)
      else clearTimeout(timeoutId as ReturnType<typeof setTimeout>)
    }
  }
}

/**
 * The definition that runs a stored job: its exact version, or the latest
 * registered version of its type when that is newer (the payload is then
 * upcast through the registry). Undefined when this worker cannot run it.
 */
function resolveJobDefinition(registry: JobRegistry, job: StoredJob): { definition: JobDefinition; upcast: boolean } | undefined {
  const exact = registry.get(job.jobType, job.jobVersion)
  if (exact) return { definition: exact, upcast: false }
  let latest: JobDefinition | undefined
  for (const entry of registry.list()) {
    if (entry.definition.type === job.jobType && (!latest || entry.definition.version > latest.version)) latest = entry.definition
  }
  return latest && latest.version > job.jobVersion ? { definition: latest, upcast: true } : undefined
}

const UNRUNNABLE_SINCE = / \(unrunnable since (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\)$/

/**
 * When consecutive deferrals of an unrunnable job began. The marker lives in
 * the job's last error, written by the previous deferral's release: any other
 * transition (a retry or failure on a worker that can run the job) overwrites
 * it, so the window restarts. A missing, malformed, or future marker means
 * this is the first deferral.
 */
function unrunnableSince(lastError: string | null, now: Date): Date {
  const marked = lastError === null ? null : UNRUNNABLE_SINCE.exec(lastError)
  const since = marked ? Date.parse(marked[1]!) : Number.NaN
  return Number.isFinite(since) && since <= now.getTime() ? new Date(since) : now
}

/**
 * Hands back a job this worker cannot run (typically a rolling deploy where a
 * newer worker enqueued it) without consuming its attempt. Hand-backs are
 * bounded: once no worker has run the job for longer than the deferral window
 * since its first deferral, it is dead-lettered with UNKNOWN_JOB_DEFINITION
 * instead of circulating forever.
 */
async function deferUnrunnableJob(args: DispatcherConfig & { job: StoredJob; log: DispatcherLogger; clock: DispatcherClock }, claimToken: string, message: string): Promise<JobOutcome> {
  const { job, store, workerId, leaseDurationMs, log, clock } = args
  const attempt = job.currentAttempt
  const at = clock.now()
  const since = unrunnableSince(job.lastError, at)
  // The reason becomes the job's last error and carries the first-deferral
  // marker forward to the next worker that cannot run it.
  const error = `${message} (unrunnable since ${since.toISOString()})`
  const maxDeferralMs = args.unknownDefinitionMaxDeferralMs ?? DEFAULT_UNKNOWN_DEFINITION_MAX_DEFERRAL_MS
  if (at.getTime() - since.getTime() > maxDeferralMs) {
    const deadLetterError = `UNKNOWN_JOB_DEFINITION: ${message}; no worker could run the job within ${maxDeferralMs}ms of ${since.toISOString()}`
    log.error("Job dead-lettered: no runnable definition", { jobId: job.id, jobType: job.jobType, jobVersion: job.jobVersion, maxDeferralMs })
    const status = await markFailedState({ jobId: job.id, workerId, claimToken, error: deadLetterError, status: "dead_letter", attempt }, store)
    return status.applied ? { kind: "dead_letter", error: deadLetterError } : { kind: "lease_lost", error: status.error ?? deadLetterError }
  }
  const nextAttemptAt = new Date(at.getTime() + leaseDurationMs)
  if (typeof store.release === "function") {
    try {
      const released = await store.release({ jobId: job.id, workerId, claimToken, nextAttemptAt, reason: error })
      if (released.applied) {
        log.warn("Job released: unknown definition", { jobId: job.id, jobType: job.jobType, jobVersion: job.jobVersion })
        return { kind: "retried", error }
      }
      return { kind: "lease_lost", error: "Job lease was lost" }
    } catch (releaseError) {
      log.warn("Job release failed", { jobId: job.id, error: errorMessage(releaseError) })
    }
  }
  try {
    const deferred = await store.markRetrying({ jobId: job.id, workerId, claimToken, nextAttemptAt, error, attempt })
    if (deferred.applied) {
      log.warn("Job deferred: unknown definition", { jobId: job.id, jobType: job.jobType, jobVersion: job.jobVersion, attempt })
      return { kind: "retried", error }
    }
  } catch (deferError) {
    log.warn("Job deferral failed", { jobId: job.id, error: errorMessage(deferError) })
  }
  const status = await markFailedState({ jobId: job.id, workerId, claimToken, error, status: "dead_letter", attempt }, store)
  return status.applied ? { kind: "dead_letter", error } : { kind: "lease_lost", error: status.error ?? error }
}

function validateDispatcherConfig(config: DispatcherConfig): void {
  if (typeof config.workerId !== "string" || config.workerId.trim().length === 0) throw new ConfigurationError("workerId must be a non-empty string")
  if (!Number.isInteger(config.claimLimit) || config.claimLimit < 1) throw new ValidationError("claimLimit must be a positive integer")
  const MAX_CLAIM_LIMIT = 100
  if (config.claimLimit > MAX_CLAIM_LIMIT) throw new ValidationError(`Claim limit ${config.claimLimit} exceeds maximum ${MAX_CLAIM_LIMIT}`)
  if (!Number.isFinite(config.leaseDurationMs) || config.leaseDurationMs <= 0) throw new ValidationError("leaseDurationMs must be positive")
  // leaseDurationMs is the default execution timeout, grace period and heartbeat basis.
  assertTimerDelayWithinLimit("leaseDurationMs", config.leaseDurationMs)
  if (config.timeoutPolicy) {
    if (!Number.isFinite(config.timeoutPolicy.cancellationGraceMs) || config.timeoutPolicy.cancellationGraceMs < 0) {
      throw new ValidationError("cancellationGraceMs must be finite and non-negative")
    }
    assertTimerDelayWithinLimit("cancellationGraceMs", config.timeoutPolicy.cancellationGraceMs)
    if (config.timeoutPolicy.timeoutMs !== undefined && (!Number.isFinite(config.timeoutPolicy.timeoutMs) || config.timeoutPolicy.timeoutMs <= 0)) {
      throw new ValidationError("timeoutMs must be finite and positive")
    }
    if (config.timeoutPolicy.timeoutMs !== undefined) assertTimerDelayWithinLimit("timeoutMs", config.timeoutPolicy.timeoutMs)
  }
  if (config.unknownDefinitionMaxDeferralMs !== undefined && (!Number.isFinite(config.unknownDefinitionMaxDeferralMs) || config.unknownDefinitionMaxDeferralMs < 0)) {
    throw new ValidationError("unknownDefinitionMaxDeferralMs must be finite and non-negative")
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
  /** Called once the durable transition has settled, before any lifecycle hook runs. */
  onTransitionSettled?: () => Promise<void>
}): Promise<JobOutcome> {
  const { job, store, def, retryPolicy, workerId, claimToken, execution, failureKind, now, log } = args
  const error = boundJobErrorMessage(args.error)
  const settled = async (): Promise<void> => { await args.onTransitionSettled?.() }
  if (failureKind === "cancelled") {
    const status = await markFailedState({ jobId: job.id, workerId, claimToken, error, status: "cancelled", attempt: job.attemptsCompleted + 1 }, store)
    await settled()
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
      } finally {
        await settled()
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
  } finally {
    await settled()
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
