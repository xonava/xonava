# Resilience

## Scope and requirements

Core defines and validates SDK-neutral timeout, retry, circuit-breaker, and bulkhead policy values for external-port implementations. It does not expose or implement a generic network client. A provider that executes one of these policies MUST keep it bounded and explicit. Retry MUST consider idempotency and retryability; it MUST NOT blindly repeat an unsafe mutation. Backoff and attempt limits MUST respect the enclosing deadline/budget. A fallback MUST NOT silently weaken authorization, durability, or consistency guarantees.

Attempt counting, delay calculation, jitter source, eligible error categories, and terminal outcome MUST be deterministic under the declared clock/randomness inputs. Circuit state transitions and observation windows MUST be concurrency-safe per key. Cancellation stops future attempts and scheduled delay.

## Errors and conformance

Invalid core policy values fail validation. G1 core conformance covers bounds, idempotency guards, and defensive immutable policy snapshots. Execution semantics—including eligible errors, exhaustion, deadline/cancellation, circuit races, fallback restrictions, and telemetry safety—MUST be certified by each provider that claims to execute those policies; G1 alone does not make that provider-level claim.

Traceability: `packages/core/src/resilience`; G1 resilience certification coverage.
