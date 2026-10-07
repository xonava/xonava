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
| G15 | Sequences reset only at UTC boundaries, had no period token, and no injectable clock | IANA time-zone resets (default UTC), embedded period formats, injectable clock |
| G16 | Rate-limit `fail-open` was silently ignored on atomic limiters | Contradictory configuration rejected; more window units |
| G18 | `hash` masking was an unsalted digest; `partial` revealed most of short values | HMAC-SHA256 with an environment masking key (fails closed without one); `partial` reveals at most the last four characters of 8+ character values |
| G19 | Cursors had no expiry or key rotation | Integrity-protected `expiresAt`; rotating integrity helper |
| G21 | Fingerprint domain separators were unconstrained | Separator grammar that makes domain ‖ value provably unambiguous; existing digests unchanged |
| G23 | Plan-constrained query re-check dropped every row whose projection omitted a predicate field | Rows without predicate fields trust the pushed-down filter; complete rows are still re-checked |
| N1 | Four clock abstractions | One `Clock` / `TimerClock` in `core/kernel`; the others are defined in terms of it |
| H1 | ESLint had three rules | Type-aware rules on core production code (floating/misused promises, `any`, non-Error throws, loose equality, type-only imports) |
| H2 | Few property tests | Generator-based properties for predicates, canonical JSON, cache keys, cursors, and workflow state |

## Adapter phase (resolved, verified on PostgreSQL 16, MySQL 8.4, and SQLite/D1)

| Gap | Resolution |
|---|---|
| Temporal history could never advance past creation on PostgreSQL or MySQL (CHECK evaluated before ON CONFLICT) | Guarded update + create-only insert; rejections are `ConflictError` |
| Every `contains`/`startsWith`/`endsWith` predicate was a syntax error on MySQL (`ESCAPE '\'`) | MySQL escapes with `!` |
| Predicate results depended on column collation (PostgreSQL ICU ordering, MySQL `_ci` equality) | Dialect-aware compilation; 1500-predicate differential test passes on all three engines and both collation modes |
| COMMIT-time serialization failures escaped as raw driver errors and were never retried | `TransactionRolledBackError` classification; proven with a real serializable write-skew retried to success |
| MySQL rejected `accessMode`, so transactional reads always failed | Access mode passed through |
| No database-enforced deadline | PostgreSQL `SET LOCAL statement_timeout`; `TIMEOUT` mapping |
| Unknown job types consumed attempts | `JobStore.release` on all stores |
| Outbox provenance not persisted | Framework-owned `provenance` column |
| PostgreSQL stores hard-coded the `framework_test` schema | Validated schema/table options with production defaults |

## Remaining

- A code formatter is still not configured; style is enforced only by lint.
- Commit-outcome classification is proven on PostgreSQL and MySQL; D1 has no interactive transactions.
