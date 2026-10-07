# Resilience

## Scope and requirements

Core defines and validates SDK-neutral timeout, retry, circuit-breaker, and bulkhead policy values for external-port implementations. It does not expose or implement a generic network client. A provider that executes one of these policies MUST keep it bounded and explicit. Retry MUST consider idempotency and retryability; it MUST NOT blindly repeat an unsafe mutation. Backoff and attempt limits MUST respect the enclosing deadline/budget. A fallback MUST NOT silently weaken authorization, durability, or consistency guarantees.

Attempt counting, delay calculation, jitter source, eligible error categories, and terminal outcome MUST be deterministic under the declared clock/randomness inputs. Circuit state transitions and observation windows MUST be concurrency-safe per key. Cancellation stops future attempts and scheduled delay.

## Errors and conformance

Invalid core policy values fail validation. G1 core conformance covers bounds, idempotency guards, and defensive immutable policy snapshots. Execution semantics—including eligible errors, exhaustion, deadline/cancellation, circuit races, fallback restrictions, and telemetry safety—MUST be certified by each provider that claims to execute those policies; G1 alone does not make that provider-level claim.

Traceability: `packages/core/src/resilience`; G1 resilience certification coverage.

## Executable primitives (normative behaviour)

- **Backoff policy** (`BackoffPolicy`): serializable `{ maxAttempts, initialDelayMs, backoffMultiplier, maxDelayMs, jitter }`. The delay after failed attempt `n` is `min(maxDelayMs, initialDelayMs × backoffMultiplier^(n−1))`; `jitter: "equal"` yields `base/2 + random × base/2`. It is shared by workflows, consumers, and the resilience executor.
- **Circuit breaker**: pure state machine. `closed` opens after `failureThreshold` consecutive failures; `open` admits a single half-open trial after `resetAfterMs`; the trial's success closes the circuit and its failure re-opens it. An open circuit fails fast with `UNAVAILABLE` without calling the dependency.
- **Bulkhead**: at most `maxConcurrent` calls in flight and `maxQueue` waiting; excess callers fail fast with `UNAVAILABLE`; a waiter that is cancelled leaves the queue immediately and never holds a slot.
- **Executor** (`withResilience`): bulkhead admission, then per attempt a breaker check, a per-attempt timeout (`TIMEOUT`, with the attempt's abort signal fired), and jittered retry. It retries only reads and idempotent mutations, never non-idempotent mutations and never errors a framework marks non-retryable. Cancellation stops backoff immediately. Timers, listeners, and bulkhead slots are always released.
