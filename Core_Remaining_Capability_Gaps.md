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

## Second review (resolved)

A second, adversarial pass over every core module found the gaps below. Each
fix has a regression test that failed before the fix.

| Id | Gap | Resolution |
|---|---|---|
| S1 | A policy `effect` other than exactly `"allow"`/`"deny"` was accepted and treated as allow on the record path | Normalizer rejects unknown effects and non-integer priorities; only an explicit `"allow"` allows |
| S2 | Plan-constrained updates checked only the pre-image, so an update could move a row out of the actor's scope | Update data must satisfy every mandatory-predicate conjunct it touches; partial changes to a compound conjunct are forbidden |
| S3 | Nested operations ran in their own transaction and committed (with post-commit hooks) before the parent; the nesting-depth budget was never enforced | `execute` contexts expose `invoke`: a child joins the parent's transaction, its post-commit work runs only after the parent commits, a failed or unfinished child fails the parent, and depth is enforced; read operations may invoke only reads |
| S4 | A missing user attribute compiled to the literal `"undefined"` (and `null` to `0`) | Unresolved attributes make allow clauses false and deny clauses true; coercion rejects non-scalar values |
| S5 | Field-level reads leaked through nested arrays, extra paged-result keys, allowlists keyed on the trusted record, and query grants from deny policies; entities kept restricted fields filterable/sortable | Recursive projection; paged envelope allowlist; allowlists default to omit; deny-omitted fields are never re-granted; restricted fields are not filterable or sortable |
| R1 | Expired, out-of-scope, or non-permitted authority surfaced as `ConfigurationError` (500) | `UnauthorizedError` for not-yet/no-longer-valid authority, `ForbiddenError` for authority that does not cover the request; bounded clock-skew tolerance for `issuedAt` (default 30 s); expiry must follow issuance |
| R2 | The request's `signal` and `deadline` did not bound the operation | Run context combines environment and request signals and uses the earlier deadline |
| C1 | Quota denials always failed validation | Denials validated against the requested amount |
| C2 | Cron `*/n` day fields lost their step; DOM-or-DOW expressions could report no next run | Vixie day matching; calendar-date check honours day-of-week |
| C3 | Timers above 2³¹−1 ms fired after 1 ms | Job, lease, dispatcher, schedule, and resilience timeouts validated against the timer ceiling |
| C4 | Job retry backoff was uncapped and could yield an Invalid Date | 24 h default cap computed without overflow |
| C5 | Outbox/inbox claims ignored `maxAttempts`, so a crashing message was never dead-lettered | Claims dead-letter exhausted records; stores forward `maxAttempts` |
| C6 | A `queue_all` schedule with a large backlog failed every tick forever | Bounded oldest-first drain across ticks |
| C7 | Cancelling a compensating workflow overwrote its failure and refilled its retry budget | No-op in the state machine and in the PostgreSQL, MySQL, and D1 stores |
| C8 | A stalled non-idempotent workflow step was re-executed | Stall recorded durably; the next claim fails the step with `TIMEOUT` |
| C9 | Late results from older circuit-breaker generations changed state; client cancellations counted as failures | Generation-tagged admissions; cancellation is neutral |
| C10 | A failed compile wedged the definition registry; duplicate or malformed routes were accepted; dependency resolution could overflow the stack | Registry reopens on failure; method allowlist, path-template grammar, ambiguity detection; iterative resolution |
| C11 | Versioned codecs decoded old payloads with the current layout | `decode(payload, version)`; multi-version codecs must declare version-aware decoding |
| C12 | Tenant atomic batches could advance any cache-generation tag | Tenant tags use the length-prefixed tenant namespace and foreign tags are rejected; CRUD handlers build tags with it |
| P2 | Framework-error contract gaps | Cancellation and deadline raise `CancelledError`/`TimeoutError` (operations, object store, streams); predicate string values are byte-bounded; repeated signals cannot skip a retry backoff; outbox appends with a reused id and different payload conflict; telemetry redacts sensitive keys |
| P3 | Hardening | Error `details` are non-enumerable; prototype-chain lookups replaced with own-property checks; base64url accepts only canonical spellings; post-commit failures of retried attempts reach `runOperationDetailed`; `deepFreeze` freezes children of frozen parents |

## Final pass (resolved)

A last review covered the second-review fixes themselves, the less-reviewed
modules, and cross-cutting resource and error-contract hygiene.

| Gap | Resolution |
|---|---|
| Nested `invoke` failed inside any routed request (route bound to the parent) | Route binding is asserted for the root operation only |
| The S2 update check rejected compare-and-set fact transitions and over-rejected OR/NOT predicates | Exact post-image rewrite: written fields are decided by the new data and the residual predicate over unwritten fields is added to the WHERE clause; fact equalities remain pre-image guards |
| Cache instances sharing a backend stopped sharing entries after any invalidation | Backend tag generations are the shared fence; the local epoch advances only when the backend cannot |
| Temporal reconstruction accepted a snapshot for another resource, and revision-0 snapshots with state | Snapshot identity and revision-0 state checked |
| Aggregate snapshots rejected shared (non-cyclic) references | Active-path cycle detection |
| Read-model joins never matched `Date` keys; snapshot tokens unchecked on partial results | Value-keyed Date joins; tokens checked for every successful source |
| Raw abort reasons (DOMException) surfaced as 500 from resilience and retry backoff | All caller-visible aborts are `CancelledError`/`TimeoutError` |
| Bulkhead slots were released while timed-out work kept running | Slot released when the work settles |
| Delivery and inbox work ran after a shutdown that arrived during claim | Already-aborted parent stops the work before it starts |
| Outbox payload comparison fell back to key-order-dependent JSON | Key-sorted fallback |
| Workflow lease/step timeouts were unbounded | Timer ceiling enforced |
| Rate-limit store faults and misconfiguration were 400s and skipped fail-open | Store faults `UnavailableError` (fail-open applies); misconfiguration `ConfigurationError` |
| Search cancellation, deadlines, and provider faults were 400s; results re-checked against the deadline | `CancelledError`/`TimeoutError`/`ConfigurationError`; no post-result deadline check |
| Unvalidated schedule/dispatcher options | Validated before any claim |
| Without `AbortSignal.any` the environment signal was dropped | Manual combination with listener cleanup on dispose |

## Adapter review (resolved)

A full review of `packages/adapters` against the core contracts, with fixes
tested on real PostgreSQL 16, MySQL 8.4, and Miniflare D1.

| Area | Gap | Resolution |
|---|---|---|
| PostgreSQL jobs | Lost-lease check read `affectedRows` (undefined in node-postgres), so stale workers' transitions reported success | Uses `rowCount` |
| PG/D1 jobs | Execution history keyed by column names (written NULL / transition never applied on D1); PG `cancel` history SQL invalid | Property-keyed history values; valid cancel |
| PG/D1 jobs | Duplicate idempotent enqueue threw a raw driver error with SQL | `ON CONFLICT DO NOTHING` + existing-row replay |
| All engines | A job whose lease expired on its final attempt stayed `running` forever (MySQL also wedged its partition) | Claim dead-letters exhausted expired jobs |
| PG/MySQL | Partition serialization crossed tenants; PG blocked siblings starved other jobs | Tenant-scoped sibling checks; single-statement `SKIP LOCKED` claim with per-partition candidates |
| D1 | Constraint and busy errors never classified (D1 has no codes); batch errors leaked table/column names | Message-based SQLite classification; sanitized batch errors with conflict mapping |
| D1 | A stale versioned write in an atomic batch matched 0 rows while audit/outbox/idempotency items committed | Versioned writes assert one affected row |
| D1 | Atomic outbox rows lacked provenance; a transient fence-check failure was cached forever | Provenance and scope on atomic writes; cache cleared on failure |
| MySQL | Conditional update not atomic; reads leaked raw errors; signals to missing instances "delivered"; lease reads used the app clock | Filter in the UPDATE; normalized errors; instance check; DB clock |
| Errors | PG 57014/55P03 and MySQL 3024 surfaced as generic errors; repository reads leaked SQL | `TimeoutError`; normalized reads; sanitized history errors |
| HTTP | CRUD list ignored declared sort/filter allowlists (any field queryable without a bundle) | Compiled, classification-filtered allowlists; undeclared means none |
| HTTP | Retried idempotent DELETE/UPDATE returned 404 | Idempotency acquire precedes record lookup |
| HTTP | Create checked ABAC before `transformInput` | Re-enforced on the transformed record in both pipelines |
| Idempotency | A pre-commit failure held the key "in progress" until the lease lapsed | Optional `IdempotencyPort.abandon` releases only an uncommitted, owned reservation (PG, MySQL, D1; tenant wrapper forwards it) |
| Cache | `clear()` reset tag generations; KV rejected TTLs under 60 s; unbounded in-memory/KV growth; KV vs in-memory value types differed | Monotonic generations; TTL envelope; bounded LRU and tag lists; shared tagged codec |
| Rate limit | In-memory buckets never evicted | Bounded store that fails closed at capacity |
| Server | `authorizedRepository` allowed queries on hidden fields without a bundle; persistence router checked only the scope kind | Hidden fields rejected; full scope compared |

## MySQL parity (resolved)

| Feature | Implementation |
|---|---|
| Database/table configuration | Every MySQL store accepts `{ database?, tables? }`; identifiers are validated and backtick-quoted; defaults unchanged |
| Transaction timeouts | Session `max_execution_time`/`innodb_lock_wait_timeout` lowered for the transaction and restored before release, plus a `KILL QUERY` watchdog at the deadline; timeouts surface as `TimeoutError` and never commit |
| `constraintMap` | Duplicate-key index names mapped to `ConflictError` `details.field`; driver messages and values never copied |
| Execution history | `executionHistory: "required" \| "best_effort"` (MySQL defaults to `required`); claim dead-letters write history |

## Fresh audit (resolved)

A fresh, file-by-file audit of every core module found 12 high, 19 medium and
about 14 low findings, each proven by a failing test. All are fixed; each fix
has a regression test that failed first.

| Area | Fixed |
|---|---|
| Authorization (ABAC) | Fields hidden by a read allowlist are no longer filterable/sortable/searchable (`fields` is now required); field writes are checked against the pre-image and the post-image; conditional denies block global capability checks; a deny or higher-tier policy whose condition is UNKNOWN (null) now matches on update/delete record paths, agreeing with the query scope (on create, UNKNOWN caused by a field the request omits is ignored, since the database supplies it; an explicit null still fails closed); equal-priority read allowlists intersect, independent of order; bundle/module mismatch is refused; policy date/datetime literals are strict RFC 3339 |
| Operations | Nested post-commit work never throws after commit (with `deferredExecution: false`); a failing parent cancels and awaits running children before the transaction ends, and a joined child's persistence fails closed once the parent's `execute` ends (infrastructure sinks keep the raw transaction provider); the deferred-effect budget is counted once; `createOperationContext` no longer fixes a deadline at creation; `createOperationInvoker` works in request-bound environments; run contexts are disposed on every path |
| Resilience | A retry never starts while a timed-out attempt still holds the bulkhead slot (`UNAVAILABLE`); caller aborts are prompt; `retry.maxAttempts` is capped at 100 with a 100 ms default backoff |
| Jobs and schedules | Registry upcasters are honoured; unrunnable jobs are deferred without spending attempts and dead-lettered (`UNKNOWN_JOB_DEFINITION`) after 24 h; stalled jobs are fenced; the lease is held until the retry/dead-letter write commits; the definition's `maxAttempts` applies when the enqueue omits it; misfire `skip` fires once and overlap applies to every policy; `remainingOccurrences` bounds catch-up (`occurrencesFired`); failing schedules back off (5 s doubling to 15 min) instead of starving others |
| Workflows | `wait`/`sleep` no longer consume step attempts; upcast variables are persisted with the new `workflowVersion`; shutdown hands back unstarted claims, commits steps that finish within the grace period, and fences abandoned code |
| Persistence and events | Tenant-scoped batches reject outbox records scoped to another tenant or to platform/system; tenant-brand registration is no longer public; projected tenant reads work; consumers retry optimistic-concurrency conflicts; non-integer/invalid retry delays are normalised instead of becoming 0 ms |
| Entities, queries, serialization | Application scope columns are protected and injected from the trusted scope; tenant and application entities refuse other request scopes; `queryLimits` compile into a valid query budget and unknown keys are rejected; explicit audit maps merge with classification redaction (stricter wins); cache prefixes/tags default to `module:namespace:name`; `custom` fields with durable codecs fail closed until codecs are applied by persistence; idempotency fingerprints the raw request; default sorts respect classification; spec constants are frozen |
| Cache and infrastructure | `delete`/`set` fence in-flight lookups; correctness-critical `delete`/`has` surface backend errors; the 10,000-rule limit is reachable and errors are `ConfigurationError`; default rule conflict groups cannot collide; temporal page size follows `maxRevisions`; quota keys encode principal kind; telemetry redacts `jwt`, `bearer`, `session`, `signature`, and `auth`/`otp` segments; health checks accept a signal and deadline; resetting sequences must declare `periodFormat` (no silent default that could repeat identifiers or change an existing series' format) |

## Differential test suites (resolved)

Seeded, replayable property/differential suites now check core invariants
over thousands of generated cases per run (`packages/core/src/__tests__/differential`;
`DIFFERENTIAL_SCALE`, `DIFFERENTIAL_SEED`, `DIFFERENTIAL_RUN`). Every failure
was triaged against the spec; real bugs were fixed with a named regression test.

| Suite | Checks | Bugs found and fixed |
|---|---|---|
| Predicate semantics | Kleene laws, simplifier soundness, missing ≡ NULL, instant spellings, operator laws, depth limits, post-image rewrite end to end, validation and round trips | `in []` on an array field was UNKNOWN; `includesAll` depended on NULL position; the depth limit was skipped under short-circuiting; RFC 3339 years 0000–0099 were rejected; an `undefined` patch value made the post-image check fail open |
| ABAC authorization | record decision ≡ query scope (all actions, capabilities) against an independent oracle; collection vs rows; global ⇒ record; order independence; deny monotonicity; read plan ⇒ query denials ⇒ projection; pre/post-image writes; digest tamper detection; normalization | global capabilities were looser than record decisions under a conditional higher-tier allow; a deny read map with `"*"` left fields queryable (`"*"` is now reserved); record-dependent field writes were not flagged for optimistic concurrency; policies using `in` were always rejected |
| Encodings and isolation | round trips, injectivity across every key builder, canonical JSON against an RFC 8785 model, mutation agreement with `JSON.parse`, cursor tamper/binding, fingerprint domain separation, sequence periods | canonical JSON ordered integer-like keys like JavaScript, not RFC 8785; envelopes without a payload were accepted; cursors accepted a non-string direction; BC dates collided with AD periods; lone surrogates raised raw `URIError`; tenant idempotency scopes accepted leading zeros; default entity cache tags could parse as tenant tags (now under `entity:`); entity idempotency namespaces ignored the entity namespace; list cursors were not bound to the entity, search, or projection; list/detail cache scope keys were not injective; KV `clear()` left tagged values |

## Remaining

- A code formatter is still not configured; style is enforced only by lint.
- Commit-outcome classification is proven on PostgreSQL and MySQL; D1 has no interactive transactions.
- A failed nested operation fails its parent, but its writes are not individually rolled back (no savepoints): the parent's whole transaction rolls back instead.
- Query grants from conditional allow policies are honoured without evaluating their conditions at query time; only deny-sourced grants are dropped.
- Some dispatcher and schedule option checks (claim limit, lease, timeouts, `maxQueueAllOccurrences`) still raise `ValidationError` rather than `ConfigurationError`; these are worker configuration, never request input.
- MySQL transaction timeouts rely on `KILL QUERY` (same MySQL user or CONNECTION_ADMIN) and need a pooled client; a single-connection client gets session limits only and `transactionTimeouts: false`. COMMIT itself is not bounded.
- Job dead-lettering on claim is a separate statement from the claim (safe and idempotent; not in one transaction) and writes no execution-history row.
- Behaviour change: entities that declare no sortable/filterable/searchable columns now reject client sorting, filtering, and search.
- Telemetry redaction is intentionally broad (`token` also matches keys such as `maxTokens`).
- If an ABAC policy condition itself references a soft-delete field, plan-constrained soft deletes are refused, because the update would leave the policy's scope.
- `custom` entity fields with durable codecs are rejected until the persistence mapping applies codecs on write and read.
- Two entities that set the same explicit cache prefix are not detected (defaults are namespaced by module).
- During a rolling deploy, workers on older code read the "use the definition's maxAttempts" sentinel as a very large budget for jobs enqueued without `maxAttempts`.
- Behaviour change: tenant entities now refuse non-tenant request scopes; platform tooling that needs cross-tenant access must use a platform-scoped entity or an explicit operation.
- Behaviour change: resetting sequences without an explicit `periodFormat` now fail validation (`ConfigurationError`) instead of formatting without the period.
- Behaviour change: policy `datetime` literals must be RFC 3339 with an offset and `date` literals real `YYYY-MM-DD` dates; stored policies with looser literals stop loading.
- Behaviour change: idempotency fingerprints cover the raw request (body, path, query), so a retry that differs only in fields the schema would strip is a conflict.
- Unknown job definitions are held for at most 24 hours from their first deferral before being dead-lettered (`unknownDefinitionMaxDeferralMs`).
- Drizzle adapters report any non-framework error escaping a transaction as `PersistenceError` (sanitising driver detail); business code should throw framework errors (for example `BusinessRuleError`) to surface its own failures.
- Behaviour change: default entity cache prefixes/tags are now `entity:module:namespace:name` and list/detail cache scope keys changed (one cold cache); explicit cache tags may not start with `tenant:`.
- Behaviour change: a global capability is denied when a higher-priority conditional allow could take over its tier (matches the record path).
- Behaviour change: canonical JSON orders integer-like object keys per RFC 8785; fingerprints of such objects change once.
- A lowest-tier allow with a read map narrows readable fields even when a higher tier decides the row (read maps are allowlists).
- KV cache: plain value keys still share `__cache__:` with tag lists and revisions; keys are built by `buildKey`, but a raw key such as `__tag__:x` is not rejected.
- List cursors carry no `expiresAt`; tenant idempotency scope has two encodings (`fscope:v1:` and `tenant:N:`).
- The RFC 3339 parser rejects lowercase `t`/`z` and leap second `:60`; an unknown operator evaluates FALSE (validated inputs never reach it).
- ABAC `datetime` literals are canonical RFC 3339 UTC instants. A `datetime` column must hydrate as a `Date` (or that exact canonical string); a column that stores datetimes as text in another format compares as text and a date-time equality policy will not match it. `date` literals stay `YYYY-MM-DD` and match both string and `Date` hydration.
- Trusted scopes (ABAC and structural) are exempt from the caller's query budget by identity brand; a cloned scope loses the brand and is charged to the caller (fails closed).
- ABAC `date` fields on write accept only `YYYY-MM-DD` strings or `Date` objects. A `Date` that is not UTC midnight is evaluated as that instant; if the database casts it to a calendar date, a date-equality deny can be bypassed. JSON request bodies cannot produce `Date` values, so this only affects server-side hooks that write Dates; rejecting them would break drivers that hydrate DATE as local-midnight Dates.
- Fingerprint versions were bumped for the RFC 8785 key-order change (outbox `v3`, jobs `4`, HTTP idempotency `v3`); stored previous-version fingerprints are still recognised through the compatibility-only legacy serializer, which should be removed with those versions. Rate-limit windows restart and old list cursors are refused (400, "restart from the first page") once after the deploy.
- KV cache tag generations are read from and written to both the old and new counter layouts during the rolling upgrade; drop the old layout one release after every instance is upgraded.
- Process: the third-round fixes (MySQL years 0000–0999 bound natively, KV single-counter generations in the steady state, PostgreSQL lower date limit) are covered by regression tests and certification but have not had an independent review of their own.
