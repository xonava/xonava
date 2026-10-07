# Core — Engineering Gap Register

This register tracks engineering gaps in `packages/core` found by a full
review of the core source, with the status of each. It replaces the earlier
capability gap analysis, whose four "remaining" capabilities (rules,
temporal history, aggregates, sequences) are all implemented.

Principles every fix follows: core has zero runtime dependencies; semantics
are defined as pure, language-neutral functions with spec text and, where
practical, conformance vectors, so core can be ported; runtime runners are
thin, optional, and leak-free; behaviour is safe for simple single-worker
deployments and scales with explicit concurrency and capability flags.

## Resolved

| Id | Gap | Resolution |
|---|---|---|
| G1 | Predicate evaluator treated incomparable values as equal (`lte(amount, 100)` matched `NaN` or `"abc"`) | Incomparable operands are UNKNOWN; no cross-kind coercion (`"100"` ≠ `100`); strict RFC 3339 instants; code-point string order; depth guard |
| G2 | NULL semantics differed per operator and between the evaluator and SQL | SQL-native three-valued logic everywhere; compiler keeps UNKNOWN until the root; 87 conformance vectors; 1500-predicate differential test against real SQLite |
| G3 | Workflow `retry` had no cap or backoff; poison and timed-out steps looped forever; compensation failures looped; failure causes lost | Serializable per-step retry policies as durable timers; attempt-based poison termination; terminal `compensation_failed`; sanitized failure record; no compensation while a step may still run |
| G5 | Signal payloads never reached the resumed step | Delivered signal (deep-frozen) passed as `context.signal` via optional `WorkflowStore.getSignal` |
| G6 | Outbox/inbox delivery rules lived only inside an adapter; no runners; event provenance lost | Pure validated delivery state machines in `core/events`; `deliverOutboxMessage` / `consumeInboxMessage`; provenance carried and required to publish |
| G7 | `core/resilience` validated policies but nothing executed them; four incompatible retry models | Shared `BackoffPolicy`; circuit-breaker state machine; bulkhead; `withResilience` executor |
| G8 | Transaction retry blocked whenever an outbox record or commit marker existed (so idempotency-keyed requests never retried); backoff ignored cancellation and deadlines | Retry on definite rollback only (`TransactionRolledBackError` at COMMIT included); jittered, abortable, deadline-bounded backoff |
| G9 | Post-commit failures behaved differently per pipeline and were invisible to `runOperation` callers | One contract: never thrown after commit; reported via telemetry, `onCommittedEffectFailure`, and `runOperationDetailed` |
| G10 | Deadlines were cooperative only | `TransactionOptions.timeoutMs` + `transactionTimeouts` capability; pipeline passes the remaining deadline |
| G12 | Dispatchers dropped every structured log field; no latency/outcome signal | Bounded non-throwing structured logger; `operation.completed` event; documented event catalogue |
| G13 | Unknown job definitions were failed permanently (rolling-deploy hazard) | Deferred to another worker; dead-lettered only when the attempt budget is exhausted |
| G14 | Rule tie-breaking used locale-dependent `localeCompare` | Code-point ordering |
| G17 | No error `cause`; no timeout/cancellation/unavailable codes; workflow configuration errors reported as 409 | `cause` chaining; `TIMEOUT`, `CANCELLED`, `UNAVAILABLE`; workflow option errors are configuration errors |
| G22 | Workflow claims ran strictly serially | Bounded `concurrency` option |
| H3 | No protection against runtime import cycles or layer inversion | Core test guards a cycle-free runtime graph and foundation-layer independence |

## Open in core

| Id | Gap | Notes |
|---|---|---|
| N1 | Four clock abstractions and raw `new Date()` defaults in ~12 places | Unify on one `Clock` port; mostly API consolidation |
| G15 | Sequences: caller-supplied `at` selects the period; UTC-only resets; no period token in formats; no block allocation | Use `core/business-calendar` time zones; inject the clock |
| G16 | Rate limit `fail-open` silently ignored unless `best-effort`; minimal time-window units | Validate the combination explicitly |
| G18 | `hash` masking is an unsalted digest (reversible for low-entropy values); `partial` reveals first/last characters | Keyed masking through a secret port |
| G19 | Cursors have no key id (rotation) or expiry; offset pages have no `hasNext` | Versioned cursor format v2 |
| G21 | Fingerprint domain separator is not length-prefixed | New fingerprint format version; never change v1 in place |
| G23 | Plan-constrained `findMany` post-filters rows, so page counts can disagree | Rely on pushdown; report filtered counts |
| H1 | ESLint has three rules; no formatter | Add type-aware rules (`no-floating-promises`, `no-misused-promises`) and a formatter |
| H2 | Few property/fault-injection tests outside the areas above | Extend the generator-based tests to cache keys, cursors, and job dispatch |

## Adapter phase (found while fixing core)

- PostgreSQL locale collation and MySQL `_ci` collations break predicate parity for string ordering and equality; port the D1 differential test to both and use binary collation.
- Workflow stores are hard-coded to the `framework_test` schema.
- `JobStore` needs a `release()` that does not consume an attempt, so unknown job definitions can be deferred for free.
- PostgreSQL and MySQL workflow-store SQL changes (failure column, compensation wake gating, `getSignal`, cancellation rules) need their integration suites run against real servers.
- Providers should raise `TransactionRolledBackError` for serialization failures and deadlocks reported at COMMIT, declare and enforce `transactionTimeouts`, and hydrate DECIMAL columns into typed values.
- Outbox sinks should persist the record's provenance.
