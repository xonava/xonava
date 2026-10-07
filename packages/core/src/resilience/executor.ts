import { CancelledError, ConfigurationError, FrameworkCoreError, TimeoutError, UnavailableError } from "../domain/errors"
import { abortSignalError } from "./abortSignal"
import { computeBackoffDelayMs, MAX_BACKOFF_DELAY_MS, type BackoffPolicy } from "./backoff"
import { validateResiliencePolicy, type CircuitBreakerPolicy, type ExternalCallSemantics, type ResiliencePolicy } from "./resilience"

// ------------------------------------------------------- circuit breaker
// Pure state machine (portable): closed -> open after `failureThreshold`
// consecutive failures; open -> half-open after `resetAfterMs`; half-open
// admits exactly one trial call, which closes the circuit on success or
// re-opens it on failure.
//
// Every status transition increments `generation`. A call is tagged with the
// generation it was admitted in, and its result only affects the state when
// it is reported with that same generation: a call admitted while closed that
// completes after the circuit opened or went half-open is ignored, so it can
// neither close the circuit nor consume (or fake) the half-open probe.

export interface CircuitBreakerState {
  readonly status: "closed" | "open" | "half_open"
  readonly consecutiveFailures: number
  readonly openedAt: number | null
  readonly trialInFlight: boolean
  /** Incremented on every status transition; tags admissions. */
  readonly generation: number
}

export const CLOSED_CIRCUIT: CircuitBreakerState = Object.freeze({ status: "closed", consecutiveFailures: 0, openedAt: null, trialInFlight: false, generation: 0 })

function generationOf(state: CircuitBreakerState): number {
  return Number.isSafeInteger(state.generation) && state.generation >= 0 ? state.generation : 0
}

/** Whether a result reported for `admittedGeneration` is stale (admitted before the latest transition). */
function isStale(state: CircuitBreakerState, admittedGeneration: number | undefined): boolean {
  return admittedGeneration !== undefined && admittedGeneration !== generationOf(state)
}

/** Admits a call. The admitted call's generation is `state.generation` of the returned state. */
export function admitCircuit(state: CircuitBreakerState, policy: CircuitBreakerPolicy, nowMs: number): { readonly allowed: boolean; readonly state: CircuitBreakerState } {
  if (state.status === "closed") return { allowed: true, state }
  if (state.status === "open") {
    if (state.openedAt !== null && nowMs - state.openedAt >= policy.resetAfterMs) return { allowed: true, state: Object.freeze({ ...state, status: "half_open", trialInFlight: true, generation: generationOf(state) + 1 }) }
    return { allowed: false, state }
  }
  if (state.trialInFlight) return { allowed: false, state }
  return { allowed: true, state: Object.freeze({ ...state, trialInFlight: true }) }
}

/** Records a success. Results from an older generation than `admittedGeneration` are ignored. */
export function recordCircuitSuccess(state: CircuitBreakerState, admittedGeneration?: number): CircuitBreakerState {
  if (isStale(state, admittedGeneration)) return state
  const closed = state.status === "closed"
  if (closed && state.consecutiveFailures === 0 && state.openedAt === null && !state.trialInFlight) return state
  return Object.freeze({ status: "closed", consecutiveFailures: 0, openedAt: null, trialInFlight: false, generation: generationOf(state) + (closed ? 0 : 1) })
}

/** Records a downstream failure. Results from an older generation than `admittedGeneration` are ignored. */
export function recordCircuitFailure(state: CircuitBreakerState, policy: CircuitBreakerPolicy, nowMs: number, admittedGeneration?: number): CircuitBreakerState {
  if (isStale(state, admittedGeneration)) return state
  const generation = generationOf(state) + 1
  if (state.status === "half_open") return Object.freeze({ status: "open", consecutiveFailures: state.consecutiveFailures + 1, openedAt: nowMs, trialInFlight: false, generation })
  const consecutiveFailures = state.consecutiveFailures + 1
  if (consecutiveFailures >= policy.failureThreshold) return Object.freeze({ status: "open", consecutiveFailures, openedAt: nowMs, trialInFlight: false, generation })
  return Object.freeze({ ...state, consecutiveFailures })
}

/**
 * A call was cancelled by its own caller: neutral for the circuit. A cancelled
 * half-open probe releases the probe slot without changing the status.
 */
export function releaseCircuitAdmission(state: CircuitBreakerState, admittedGeneration: number): CircuitBreakerState {
  if (isStale(state, admittedGeneration) || state.status !== "half_open" || !state.trialInFlight) return state
  return Object.freeze({ ...state, trialInFlight: false })
}

/** In-process breaker over the pure state machine. Share one instance per downstream dependency. */
export interface CircuitBreaker {
  readonly state: CircuitBreakerState
  /**
   * Returns a completion callback, or throws UnavailableError when the circuit
   * is open. Report "cancelled" when the caller itself abandoned the call; it
   * does not count as a downstream failure.
   */
  admit(): (outcome: "success" | "failure" | "cancelled") => void
}

export function createCircuitBreaker(policy: CircuitBreakerPolicy, now: () => number = Date.now): CircuitBreaker {
  validateResiliencePolicy({ circuitBreaker: policy }, { kind: "read" })
  let state = CLOSED_CIRCUIT
  return {
    get state() { return state },
    admit() {
      const decision = admitCircuit(state, policy, now())
      state = decision.state
      if (!decision.allowed) throw new UnavailableError("Circuit breaker is open")
      const generation = generationOf(decision.state)
      let settled = false
      return (outcome) => {
        if (settled) return
        settled = true
        if (outcome === "success") state = recordCircuitSuccess(state, generation)
        else if (outcome === "failure") state = recordCircuitFailure(state, policy, now(), generation)
        else state = releaseCircuitAdmission(state, generation)
      }
    },
  }
}

// --------------------------------------------------------------- bulkhead

export interface Bulkhead {
  readonly active: number
  readonly queued: number
  /** Waits for a slot (bounded queue, abortable) and returns its release function. */
  acquire(signal?: AbortSignal): Promise<() => void>
}

export function createBulkhead(maxConcurrent: number, maxQueue = 0): Bulkhead {
  validateResiliencePolicy({ bulkhead: { maxConcurrent, maxQueue } }, { kind: "read" })
  let active = 0
  const waiters: { grant: () => void; reject: (error: unknown) => void }[] = []
  const releaser = (): (() => void) => {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = waiters.shift()
      if (next) next.grant()
      else active--
    }
  }
  return {
    get active() { return active },
    get queued() { return waiters.length },
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(abortSignalError(signal))
      if (active < maxConcurrent) { active++; return Promise.resolve(releaser()) }
      if (waiters.length >= maxQueue) return Promise.reject(new UnavailableError("Bulkhead capacity exhausted"))
      return new Promise((resolve, reject) => {
        const onAbort = (): void => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(signal ? abortSignalError(signal) : new CancelledError())
        }
        // The slot passes directly from the releasing caller to this waiter.
        const waiter = { grant: () => { signal?.removeEventListener("abort", onAbort); resolve(releaser()) }, reject }
        waiters.push(waiter)
        signal?.addEventListener("abort", onAbort, { once: true })
      })
    },
  }
}

// --------------------------------------------------------------- executor

export interface ResilienceRuntime {
  readonly breaker?: CircuitBreaker
  readonly bulkhead?: Bulkhead
  readonly signal?: AbortSignal
  readonly random?: () => number
}

function retryBackoff(policy: ResiliencePolicy): BackoffPolicy | undefined {
  const retry = policy.retry
  if (!retry || retry.maxAttempts <= 1) return undefined
  const initialDelayMs = retry.backoffMs ?? 0
  return { maxAttempts: retry.maxAttempts, initialDelayMs, backoffMultiplier: 2, maxDelayMs: Math.min(MAX_BACKOFF_DELAY_MS, initialDelayMs * 2 ** Math.min(retry.maxAttempts, 30)), jitter: "equal" }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onAbort = (): void => { clearTimeout(timer); reject(signal ? abortSignalError(signal) : new CancelledError()) }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve() }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Runs one attempt. The work's own signal carries the caller's raw abort
 * reason; the executor maps what it throws to the caller (see withResilience).
 */
async function attemptWithTimeout<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number | undefined, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const onParentAbort = (): void => controller.abort(parent?.reason ?? new CancelledError())
  parent?.addEventListener("abort", onParentAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (timeoutMs === undefined) return await work(controller.signal)
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { const error = new TimeoutError("External call timed out"); controller.abort(error); reject(error) }, timeoutMs)
    })
    return await Promise.race([work(controller.signal), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    parent?.removeEventListener("abort", onParentAbort)
  }
}

/**
 * Runs an external call under a validated resilience policy: bulkhead
 * admission, circuit breaker, per-attempt timeout, and jittered retry.
 * Retries happen only when the call semantics allow it (reads and
 * idempotent mutations) and never for errors a framework marks permanent.
 */
export async function withResilience<T>(policy: ResiliencePolicy, semantics: ExternalCallSemantics, work: (signal: AbortSignal) => Promise<T>, runtime: ResilienceRuntime = {}): Promise<T> {
  const validated = validateResiliencePolicy(policy, semantics)
  if (validated.circuitBreaker && !runtime.breaker) throw new ConfigurationError("A circuit breaker policy requires a shared breaker instance")
  if (validated.bulkhead && !runtime.bulkhead) throw new ConfigurationError("A bulkhead policy requires a shared bulkhead instance")
  const backoff = semantics.kind === "non-idempotent-mutation" ? undefined : retryBackoff(validated)
  const maxAttempts = backoff?.maxAttempts ?? 1
  const release = runtime.bulkhead ? await runtime.bulkhead.acquire(runtime.signal) : undefined
  // The bulkhead slot is held until every attempt's work has settled: a
  // timed-out attempt that ignores its signal still occupies the downstream,
  // so the caller gets its TimeoutError promptly but the slot is not reused.
  let outstanding = 0
  let finished = false
  const settle = (): void => { if (finished && outstanding === 0) release?.() }
  const tracked = (signal: AbortSignal): Promise<T> => {
    outstanding++
    const running = (async () => work(signal))()
    void running.then(() => { outstanding--; settle() }, () => { outstanding--; settle() })
    return running
  }
  try {
    for (let attempt = 1; ; attempt++) {
      if (runtime.signal?.aborted) throw abortSignalError(runtime.signal)
      const complete = runtime.breaker?.admit()
      try {
        const result = await attemptWithTimeout(tracked, validated.timeoutMs, runtime.signal)
        complete?.("success")
        return result
      } catch (error) {
        // The caller's own cancellation says nothing about the downstream.
        complete?.(runtime.signal?.aborted ? "cancelled" : "failure")
        if (runtime.signal?.aborted) throw abortSignalError(runtime.signal)
        const permanent = error instanceof FrameworkCoreError && !error.retryable
        if (permanent || attempt >= maxAttempts || !backoff) throw error
        await abortableDelay(computeBackoffDelayMs(backoff, attempt, runtime.random), runtime.signal)
      }
    }
  } finally {
    finished = true
    settle()
  }
}
