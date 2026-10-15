# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The project is experimental. See [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md) for known
limitations and deployment requirements.

## [Unreleased] — 2.0.0-rc.2 (experimental)

### Added

- **Workflows.** Per-step retry policies that run as durable timers, with a backoff cap and attempt-based
  termination for steps that keep failing. A terminal `compensation_failed` status. The delivered signal
  is available to the resumed step as `context.signal` (deep-frozen). Signals that arrive before their
  `wait` are buffered and consumed at most once, oldest first. A bounded `concurrency` option for
  workflow claims.
- **Events.** Pure, validated outbox and inbox delivery state machines, exposed as
  `deliverOutboxMessage` and `consumeInboxMessage`. Event provenance is carried through delivery and is
  required to publish. A documented event catalogue, including an `operation.completed` event.
- **Operations and transactions.** `TransactionOptions.timeoutMs`, enforced by the database where the
  adapter reports the `transactionTimeouts` capability. `runOperationDetailed`, which reports post-commit
  outcomes to callers. An `onCommittedEffectFailure` hook. Nested operations invoked through the
  execution context join the parent transaction.
- **Resilience.** A shared `BackoffPolicy`, a circuit breaker, a bulkhead, and a `withResilience`
  executor. Retry backoff is jittered, abortable, and bounded by the deadline.
- **Errors.** `cause` chaining on framework errors. New `TIMEOUT`, `CANCELLED`, and `UNAVAILABLE` codes.
- **Sequences.** Reset boundaries in any IANA time zone (UTC by default), embedded period formats, and an
  injectable clock.
- **Cache and idempotency.** Integrity-protected cursor `expiresAt` with a rotating integrity helper. The
  `IdempotencyPort.abandon` method releases an uncommitted reservation on PostgreSQL, MySQL, and D1.
- **Jobs and schedules.** `UNKNOWN_JOB_DEFINITION` dead-lettering, bounded by
  `unknownDefinitionMaxDeferralMs`. Schedule `remainingOccurrences` bounds catch-up.
- **MySQL adapter.** Every store accepts `{ database?, tables? }`. Transaction timeouts through session
  limits and a `KILL QUERY` watchdog. A `constraintMap` option that maps duplicate-key indexes to
  `ConflictError`. An `executionHistory` option (`"required"` or `"best_effort"`).
- **Rate limiting.** More window units.
- **Telemetry.** A bounded, non-throwing structured logger. Redaction of `jwt`, `bearer`, `session`,
  `signature`, and `auth`/`otp` keys.
- **Kernel.** One `Clock` and `TimerClock` in `core/kernel`. The other clock abstractions are defined in
  terms of them.

### Changed

- **Predicates.** Incomparable operands evaluate to UNKNOWN. There is no coercion across kinds, so `"100"`
  does not equal `100`. Instants must be strict RFC 3339. Three-valued logic follows SQL semantics.
- **Workflow results.** Malformed `sleep`, `wait`, and `next` results fail with `INVALID_STEP_RESULT`
  instead of parking the instance. A `wait` or `sleep` no longer consumes a step attempt. Workflow
  configuration errors are `ConfigurationError`, not 409.
- **Jobs.** A non-serializable job result fails the job permanently. Job error text is truncated to 16 KiB
  on every store write. A job whose setup fails before its handler is released without spending an
  attempt. A failed job cannot be cancelled: every terminal status is sticky, and `cancel` returns
  `INVALID_STATE`.
- **Leases.** Lease renewals never shorten a lease, on every database. Callers that relied on a renewal to
  pull an expiry earlier must release the claim instead.
- **Claims.** `claimDue` and `claimDueSchedules` claim nothing for a limit that is not a positive safe
  integer, or for a negative or non-finite lease. Schedule claims return oldest-due first. A schedule held
  by a live claim no longer uses up another worker's claim limit.
- **D1 partitions.** Job partition keys serialize jobs only within the same scope and tenant. After the
  upgrade, jobs from different tenants that share a partition key can run at the same time.
- **MySQL.** `claimDue` stamps `startedAt` with the `now` it is given. Lease liveness stays on the database
  clock.
- **Signals.** A signal delivered to a terminal or unknown instance is not stored and returns
  `{ delivered: false, duplicate: false }`.
- **Rate limiting and errors.** Store faults are `UnavailableError`, and fail-open applies to them.
  Misconfiguration is `ConfigurationError`. Cancellations and deadlines raise `CancelledError` and
  `TimeoutError`, not raw `DOMException` values. Search cancellations and deadlines use the same
  classes.
- **Authorization errors.** `UnauthorizedError` is returned for authority that is not yet or no longer
  valid. `ForbiddenError` is returned for authority that does not cover the request. Previously these were
  `ConfigurationError` (HTTP 500). `issuedAt` allows 30 seconds of clock skew by default.
- **Operations.** A child operation's post-commit work runs only after the parent commits. A failed or
  unfinished child fails the parent. Read operations may invoke only reads.
- **Drizzle adapters.** Any non-framework error that escapes a transaction is reported as
  `PersistenceError`, with driver detail removed.
- **Retry.** Transaction retry happens only on a definite rollback, including `TransactionRolledBackError`
  at COMMIT. Idempotency-keyed requests now retry.
- **Cron.** `*/n` day fields keep their step, and day-of-month and day-of-week use the Vixie rule.
- **Retry defaults.** `retry.maxAttempts` is capped at 100, with a 100 ms default backoff.

### Fixed

- **Authorization.** Fields hidden by a read allowlist are no longer filterable, sortable, or searchable.
  Field writes are checked against both the pre-image and the post-image. Conditional deny policies block
  global capability checks. Equal-priority read allowlists intersect, regardless of order. Restricted fields are not filterable or sortable.
  A missing user attribute no longer compiles to the literal `"undefined"`, and a `null` no longer compiles
  to `0`. Deny-omitted fields are not re-granted. Recursive projection covers nested arrays. Paged results
  allow only the envelope keys.
- **Query and HTTP.** CRUD list endpoints honour only declared sort and filter allowlists. A retried
  idempotent `DELETE` or `UPDATE` no longer returns 404. Create-time ABAC checks run again
  on the transformed record.
- **Workflows.** A stalled non-idempotent step fails with `TIMEOUT` instead of re-executing. Cancelling a
  compensating workflow no longer overwrites its failure. Compensation failures are terminal. Failure text
  is sanitized and bounded.
- **Jobs and schedules.** Stale workers' transitions are detected on PostgreSQL. Exhausted expired claims
  are dead-lettered on all engines. A repeated enqueue of an idempotent job no longer throws a raw driver
  error. `renewLease` no longer shortens a lease. Failing schedules back off from 5 s to 15 min instead of
  starving other schedules. Timers above 2³¹−1 ms are rejected instead of firing after 1 ms.
- **Circuit breaker and retry.** Results from older circuit-breaker generations are ignored. Client
  cancellations are not counted as failures. A retry never starts while a timed-out attempt still holds the
  bulkhead slot.
- **Persistence and events.** Tenant-scoped batches reject outbox records scoped to another tenant or to
  the platform. Outbox appends that reuse an id with a different payload conflict. Consumers retry
  optimistic-concurrency conflicts.
- **Cache.** `delete` and `set` fence in-flight lookups. Monotonic tag generations survive `clear()`. The
  in-memory cache and KV store hold bounded LRU and tag lists. KV TTLs under 60 s are accepted.
- **Serialization and IDs.** Canonical JSON handles lone surrogates and key order. Cursors are bound to the
  entity, search, and projection they were issued for. Sequence and temporal identities reject non-strings.
- **Telemetry and secrets.** `hash` masking uses HMAC-SHA256 with an environment masking key, and fails
  closed without one. `partial` masking reveals at most the last four characters.
- **Rate limiting.** Atomic limiters reject `fail-open` as contradictory configuration. In-memory buckets
  are held in a bounded store that fails closed at capacity.
- **Adapters.** The MySQL conditional update is atomic. Lost-lease checks use `rowCount` on PostgreSQL.
  Versioned writes in D1 atomic batches assert one affected row. PostgreSQL 57014 and 55P03 map to
  `TimeoutError`, and MySQL 3024 maps the same way. Repository reads no longer leak SQL.
- **Entities.** Scope columns are protected and injected from the trusted scope. Tenant and application
  entities refuse other request scopes. Explicit audit maps merge with classification redaction, and the
  stricter rule wins.

### Breaking

These changes require action when you upgrade. Read [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md)
for the deployment steps.

- **Migrations are required.** Apply the workflow signal-buffering migration on PostgreSQL, MySQL, and D1.
  Apply the MySQL schedule `next_run_at` nullable migration. Apply the job partition-head index migration on
  all three databases. The repository ships no production DDL, so port the fixtures to your schema before
  you deploy.
- **Rolling deploy order.** Migrate, drain the old nodes, then deploy.
- **MySQL sessions must run in UTC.** TIMESTAMP comparisons depend on the session time zone.
- **Signal identifiers are globally unique.** A signal whose id was already used for another instance is
  dropped and returns `duplicate: true`.
- **Entity access.** Tenant entities refuse non-tenant request scopes. Platform tooling that needs
  cross-tenant access must use a platform-scoped entity or an explicit operation.
- **Sorting, filtering, and search.** Entities with no sortable, filterable, or searchable columns reject
  client sorting, filtering, and search.
- **Sequences.** Resetting a sequence without an explicit `periodFormat` fails validation. Local years above
  9999 are rejected.
- **Policy literals.** `datetime` literals must be RFC 3339 with an offset. `date` literals must be real
  `YYYY-MM-DD` dates. Stored policies with looser literals stop loading.
- **Global capabilities.** A global capability is denied when a higher-priority conditional allow could take
  over its tier. This matches the record path.
- **Canonical JSON.** Integer-like object keys are ordered per RFC 8785, not as JavaScript orders them.
  Fingerprints of such objects change once.
- **Idempotency fingerprints** cover the raw request (body, path, and query). A retry that differs only in
  fields the schema would strip is now a conflict. Job fingerprint version is 5.
- **Cache keys.** Default entity cache prefixes are now `entity:module:namespace:name`. List and detail cache
  scope keys changed, so the first read after upgrade is cold. Explicit cache tags may not start with
  `tenant:`. Registering two compiled entities with the same explicit cache prefix fails.
- **KV cache.** Raw keys under `__tag__:`, `__revision__:`, or `__generation__:` are rejected.
- **Schedules.** Lifecycle instants must be ISO dates or date-times with `Z` or an offset. An Invalid Date
  passed to the schedule calculator throws.
- **Rules and aggregates.** Rule effective instants reject expanded years. Aggregate, rule, and entity module
  keys must be strings.
- **Rate limits.** Numeric limits and windows must be safe integers.
- **Temporal stores.** A page larger than the requested limit is rejected.
- **Configuration errors.** Worker configuration errors (dispatcher, registry, retry policy, schedule lease,
  `maxQueueAllOccurrences`) raise `ConfigurationError`.
- **Deploy window.** Rate-limit windows restart once after the deploy. Old list cursors are refused once with
  HTTP 400. Job fingerprint version 5 is not matched by workers on version 4 during the rollout.
