import { CancelledError, ConfigurationError, FrameworkCoreError, TimeoutError, UnavailableError } from "../domain/errors"
import { computeBackoffDelayMs, type BackoffPolicy } from "./backoff"
import { validateResiliencePolicy, type CircuitBreakerPolicy, type ExternalCallSemantics, type ResiliencePolicy } from "./resilience"

// ------------------------------------------------------- circuit breaker
// Pure state machine (portable): closed -> open after `failureThreshold`
// consecutive failures; open -> half-open after `resetAfterMs`; half-open
// admits exactly one trial call, which closes the circuit on success or
// re-opens it on failure.

export interface CircuitBreakerState {
  readonly status: "closed" | "open" | "half_open"
  readonly consecutiveFailures: number
  readonly openedAt: number | null
  readonly trialInFlight: boolean
}

export const CLOSED_CIRCUIT: CircuitBreakerState = Object.freeze({ status: "closed", consecutiveFailures: 0, openedAt: null, trialInFlight: false })

export function admitCircuit(state: CircuitBreakerState, policy: CircuitBreakerPolicy, nowMs: number): { readonly allowed: boolean; readonly state: CircuitBreakerState } {
  if (state.status === "closed") return { allowed: true, state }
  if (state.status === "open") {
    if (state.openedAt !== null && nowMs - state.openedAt >= policy.resetAfterMs) return { allowed: true, state: Object.freeze({ ...state, status: "half_open", trialInFlight: true }) }
    return { allowed: false, state }
  }
  if (state.trialInFlight) return { allowed: false, state }
  return { allowed: true, state: Object.freeze({ ...state, trialInFlight: true }) }
}

export function recordCircuitSuccess(_state: CircuitBreakerState): CircuitBreakerState {
  return CLOSED_CIRCUIT
}

export function recordCircuitFailure(state: CircuitBreakerState, policy: CircuitBreakerPolicy, nowMs: number): CircuitBreakerState {
  if (state.status === "half_open") return Object.freeze({ status: "open", consecutiveFailures: state.consecutiveFailures + 1, openedAt: nowMs, trialInFlight: false })
  const consecutiveFailures = state.consecutiveFailures + 1
  if (consecutiveFailures >= policy.failureThreshold) return Object.freeze({ status: "open", consecutiveFailures, openedAt: nowMs, trialInFlight: false })
  return Object.freeze({ ...state, consecutiveFailures })
}

/** In-process breaker over the pure state machine. Share one instance per downstream dependency. */
export interface CircuitBreaker {
  readonly state: CircuitBreakerState
  /** Returns a completion callback, or throws UnavailableError when the circuit is open. */
  admit(): (outcome: "success" | "failure") => void
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
      let settled = false
      return (outcome) => {
        if (settled) return
        settled = true
        state = outcome === "success" ? recordCircuitSuccess(state) : recordCircuitFailure(state, policy, now())
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
      if (signal?.aborted) return Promise.reject(signal.reason ?? new CancelledError())
      if (active < maxConcurrent) { active++; return Promise.resolve(releaser()) }
      if (waiters.length >= maxQueue) return Promise.reject(new UnavailableError("Bulkhead capacity exhausted"))
      return new Promise((resolve, reject) => {
        const onAbort = (): void => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(signal?.reason ?? new CancelledError())
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
  return { maxAttempts: retry.maxAttempts, initialDelayMs, backoffMultiplier: 2, maxDelayMs: Math.min(7 * 24 * 60 * 60 * 1000, initialDelayMs * 2 ** Math.min(retry.maxAttempts, 30)), jitter: "equal" }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onAbort = (): void => { clearTimeout(timer); reject(signal?.reason ?? new CancelledError()) }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve() }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

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
  try {
    for (let attempt = 1; ; attempt++) {
      if (runtime.signal?.aborted) throw runtime.signal.reason ?? new CancelledError()
      const complete = runtime.breaker?.admit()
      try {
        const result = await attemptWithTimeout(work, validated.timeoutMs, runtime.signal)
        complete?.("success")
        return result
      } catch (error) {
        complete?.("failure")
        const permanent = error instanceof FrameworkCoreError && !error.retryable
        if (permanent || runtime.signal?.aborted || attempt >= maxAttempts || !backoff) throw error
        await abortableDelay(computeBackoffDelayMs(backoff, attempt, runtime.random), runtime.signal)
      }
    }
  } finally {
    release?.()
  }
}
