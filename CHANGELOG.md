# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The project is experimental. See [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md) for known
limitations and deployment requirements.

## [0.3.0] — 2026-10-31

### Upgrading from 0.1.0

0.2.0 and 0.2.1 were never published, so this is the first upgrade from 0.1.0. Read the 0.3.0, 0.2.1 and 0.2.0
entries below; in short:

1. **Database migrations** (in `migrations/<database>/` of `@xonava/adapters`): apply `0005_job_scope_key.sql` on
   every database, `0006_byte_exact_identifiers.sql` on MySQL, and `0004_lease_records.sql` if you use the new
   fenced-lease backends. Widen the MySQL `cache_generations.scope` column to `VARCHAR(256)` if you use the
   reference table.
2. **Breaking API and behaviour changes:** list totals are opt-in (0.3.0); older-format compatibility paths are removed
   (0.3.0; a system that only ran 0.1.0 has nothing to migrate); and from 0.2.0: `fieldAccess.query` grants count only
   from unconditional allow policies; job checkpoints containing U+0000 are refused; the unimplemented
   `Root`/`Application`/`Platform`/`SystemPersistenceProvider` types are removed; a missing `If-Match` answers 428 and
   a missing `Idempotency-Key` answers `REQUIRED_HEADER_MISSING`; PostgreSQL and D1 idempotency stores throw
   `ConflictError` on lost ownership, and versioned deletes report `OPTIMISTIC_CONCURRENCY_FAILED` or `NOT_FOUND`
   consistently on all databases.
3. **Security fixes you get by upgrading:** MySQL repositories refuse every all-rows predicate in bulk writes (0.2.0),
   and MySQL in `mysqlBinaryCollation` mode no longer returns rows an ABAC scope excludes (0.2.1).

### Minor changes

- List totals are now opt-in, and cursor pages no longer count. Upgrading from 0.1.0: `ListResult.rowCount` and `OffsetPageInfo.rowCount` are now optional (`number | undefined`), and `findMany` returns no `rowCount` unless you pass `pagination: { kind: "offset", page, pageSize, includeTotal: true }`; add `includeTotal: true` wherever you read `rowCount` and handle `undefined` in your types (the PostgreSQL, MySQL and D1 repositories run no `COUNT(*)` otherwise, so plain `findMany()` calls get cheaper). Cursor pages never carry a total (use `pageInfo.hasNextPage` and `pageInfo.hasPreviousPage`); before, `rowCount` on a cursor page was the number of rows past the cursor and shrank while paging. A requested total counts only the caller's filter plus tenant/authorization scope, never the cursor predicate. Custom repositories must follow the same rule (no `rowCount` unless `includeTotal` is true); `validateQueryPlan` accepts a boolean `includeTotal` on offset pagination. New optional `ReadRepository.countUpTo(filter, limit)` is a bounded `SELECT 1 ... LIMIT limit` count, implemented by the three Drizzle repositories and passed through tenant scope and authorization plans. The HTTP list handler now enforces `queryLimits.maxCount` with that bounded probe before the page query (repositories without `countUpTo` fall back to a one-row page with a total), counts only the caller's filter and read scope (a cursor position no longer changes it), still returns `rowCount` for offset pages and omits it for cursor pages, and audit `resultCount` falls back to the page row count when there is no total. `@xonava/testing`'s repository contract now asserts an absent total, `includeTotal` totals, cursor pages without a total and, when offered, `countUpTo`; custom repositories run through `runRepositoryContractTests` must meet them.
  
  Repositories wrapped by an authorization plan pass the underlying total through unchanged when the plan's re-check keeps every row on the page, and omit it (instead of reporting the page's row count) when the re-check drops a row.
- **Breaking:** the code that read or accepted data in older formats is removed. Upgrading from 0.1.0 (0.2.x was never published): 0.1.0 itself already writes every current format, so a system that only ever ran 0.1.0 has nothing to migrate. The paths below only matter for records, keys or cache counters written before 0.1.0 (earlier internal builds) that are still alive. Before upgrading, check each one that applies and let it expire or finish; after upgrading, such a record is treated as unknown rather than recognised.
  
  - HTTP idempotency (`createFrameworkWriteHandler`; the compatibility-only export `legacyFingerprintJson` is removed from `@xonava/adapters/http`, delete any import of it): an `Idempotency-Key` record stored with a version-2 fingerprint (JavaScript key order for integer-like object keys) is no longer matched. 0.1.0 writes version-3 fingerprints. A retry of such a key now answers 409 "Idempotency-Key was reused for a different mutation" instead of replaying (or resuming) the original request, and the handler no longer calls `acquire` a second time after a conflict. Before upgrading, let in-flight and recently completed keys from builds older than 0.1.0 finish or pass their retention window; clients should not retry them after the upgrade.
  - Outbox (`drizzle-shared/outbox`, used by the PostgreSQL, MySQL and D1 outbox sinks and persistence provider): an outbox row whose `event_fingerprint` starts with `v2:` is no longer accepted as the same event. Appending the same event again (same idempotency key) now throws `ConflictError` ("Outbox idempotency key was reused for a different event") instead of being a no-op. 0.1.0 writes `v3:`. Before upgrading, drain the outbox (publish and delete or archive the rows) until `SELECT count(*) FROM <outbox table> WHERE event_fingerprint LIKE 'v2:%'` returns 0, or make sure nothing re-appends those events.
  - Jobs (`jobFingerprintMatches`, `@xonava/core/execution`): only the current fingerprint (version 5) matches a stored job fingerprint; the version-3 and version-4 digests are no longer recognised. Enqueueing a job with an `idempotencyKey` that already exists with an older digest now throws `JobIdempotencyConflictError` instead of returning the existing job. This also drops the rule that treated an omitted `maxAttempts` and an explicit 3 as the same job for version-3/4 rows. 0.1.0 writes version 5. Before upgrading, let jobs from builds older than 0.1.0 that still carry an idempotency key finish or be deleted, and drain schedules that re-enqueue them.
  - KV cache tag generations (`KvCacheAdapter`): the adapter no longer reads, writes or adopts the previous counter location `__cache__:__generation__:<tag>`; the only counter is `__cachegen__:<tag>`, which 0.1.0 also writes, and `getTagGeneration` returns it (or "0" before the first invalidation) instead of a pair digest such as `h:...`. During a rolling deploy 0.1.0 instances still observe 0.3.0 invalidations, because they read both counters. A tag whose counter exists only at the old location reads as "0" again, which is safe only if no stale entry exists for it: if any instance older than 0.1.0 may have invalidated a tag, flush the KV cache (`CacheService.clear()`) or let those entries expire before upgrading. Old `__cache__:__generation__:<tag>` keys are left behind; `clear()` now removes them like any other cache key, and you may delete them. Raw cache keys that start with `__generation__:` (other than the quoted form `CacheService` builds) were rejected as reserved and are now accepted; `__tag__:` and `__revision__:` stay reserved.
  - `legacyJavaScriptOrderJsonString` (`@xonava/core/serialization`, marked `@internal`) is removed. Nothing in the framework uses it. If you imported it to recompute older fingerprints, use `JSON.stringify(canonicalizeValue(value))`, which is what it returned.
  - Tests and tooling: `@xonava/testing` no longer ships the N-1 upgrade suite (`integration/upgrade/`, the `test:upgrade:pg|mysql|d1` scripts) or the `xonava-core-prev` / `xonava-adapters-prev` dev dependencies, because there is no published 0.2.x to compare with. Remove any CI step that runs `test:upgrade:*`. The KV tag generation differential tests in `@xonava/testing` now model a single counter.

## [0.2.1] — 2026-10-30

### Patch changes

- Fix MySQL scope parity for negated equality. With `mysqlBinaryCollation: true`, MySQL could return rows an ABAC read scope should exclude, for scopes combining negations and case-differing equality (for example `NOT owner = 'U1' OR (owner = 'U1' AND NOT owner <> 'u1')`), because its equality propagation compared the literals case-insensitively under the connection collation; text literals now carry `utf8mb4_0900_bin` explicitly.
- Removes unused internal code from `@xonava/adapters` (two helpers in the HTTP write handler and a write-only map in the in-memory cache adapter). No behaviour change.

## [0.2.0] — 2026-10-30

### Minor changes

- `createAbacBundle` now returns `VerifiedAbacPolicyBundle` (no `assertVerifiedAbacBundle` needed), `InvalidPolicyConfigurationError` carries `missingFields`, and the new `assertAbacPoliciesMatchCatalog` pre-flight reports policy/catalog mismatches (unknown action, condition field, fieldAccess read/write/query field) before any request is served.
- Business-action writes: `createFrameworkWriteHandler` accepts a named business action (for example `approve`) with an optional `routeKey`, authorized by its own ABAC grant and never implied by `update`. `CRUD()` gains `update.protectedFields` to reserve fields for business actions, and `AbacAuthorizer.assertWrite` takes any action string.
- Add `readCommittedRecord()` to `@xonava/adapters/http`: re-reads a row a custom write handler just committed under the caller's read scope, field-read overrides and projection, and reports `record`, `outside-read-scope`, `revision-unavailable` or `deleted`. Built-in create and update (and their idempotent recovery) now use the same code path.
- Add `resolveEndpointRequestContext` and `admitModuleAction` to `@xonava/adapters/http` so hand-written endpoints build the trusted request context and run module admission exactly as CRUD handlers do. The five CRUD keys in `FrameworkRequestNormalization.routeBindings` are now optional; a CRUD handler whose enabled route has no binding fails at construction with a `ConfigurationError` naming the key.
- The package now ships the reference DDL for PostgreSQL, MySQL and D1 under `migrations/<database>/`, byte-identical to the migrations the test fixtures apply.
- **Breaking:** a `fieldAccess.query` grant now lifts a mask or omit query denial only when it comes from an unconditional allow policy; grants from conditional allow policies are ignored, because queries are not evaluated per row and the grant exposed masked values. Move such grants to an unconditional policy.
- **Breaking:** job checkpoints whose strings or keys contain U+0000 are now refused with a `ConfigurationError` on every database, because PostgreSQL `jsonb` cannot store them (checkpoints already stored on MySQL or D1 still read back); canonical-JSON refusals such as integers beyond the safe range are reported as `ConfigurationError` too. Fenced lease `acquire` and `renew` now reject their promise on invalid input instead of throwing synchronously.
- Job and schedule stores now round-trip the exact `platformKey` / `systemKey` of platform and system execution scopes instead of returning `default` / `framework`. A migration is needed: apply `0005_job_scope_key.sql` (adds a nullable `scope_key` column to `jobs` and `schedules`; MySQL also redefines the active-partition generated column), and map `scopeKey` in the PostgreSQL and D1 column maps. Jobs of different keys no longer share a partition head, and rows without a key still decode to the defaults.
- Add `PgAtomicLeaseBackend` / `createPgLeaseStore` and `D1AtomicLeaseBackend` / `createD1LeaseStore`, concrete fenced-lease backends with database-clock lease time and configurable table names (new `lease_records` table, fixture migration `0004_lease_records.sql`).
- **Breaking:** removes the unimplemented `RootPersistenceProvider`, `ApplicationPersistenceProvider`, `PlatformPersistenceProvider` and `SystemPersistenceProvider` types from `@xonava/core/persistence`. No adapter implemented or consumed them; `ScopedPersistenceProvider` and the tenant-scoped provider types are unchanged.
- **Breaking:** a missing `If-Match` on a versioned update or delete now answers 428 `PRECONDITION_REQUIRED` instead of 409, and a missing required `Idempotency-Key` answers `REQUIRED_HEADER_MISSING` with `details.header`. Adds `PublicBusinessError` for application-authored, caller-safe business error codes, messages and fields, plus `RequiredHeaderMissingError` and `PreconditionRequiredError`.
- Add `R2ObjectStore` (Cloudflare R2 binding) to `@xonava/adapters/storage`, make `InMemoryObjectStore` verify sha256 checksums and honour versions and custom metadata, and add the `@xonava/testing/contracts/object-store` contract suite. `ObjectMetadata` gains an optional `metadata` field.
- **Breaking:** the PostgreSQL and D1 idempotency stores now throw `ConflictError` (as MySQL and the commit fence already did) instead of a plain `Error` when `renew`, `complete`, `ackClaimedInvalidation` or `completeClaimedInvalidation` lose ownership. A versioned `delete`/`deleteWhere` on an existing row with a stale version is now `OPTIMISTIC_CONCURRENCY_FAILED` and on a missing row `NOT_FOUND` on all three databases (previously PostgreSQL and D1 `delete` answered `NOT_FOUND` for a stale version, and MySQL/PostgreSQL/D1 `deleteWhere` answered `OPTIMISTIC_CONCURRENCY_FAILED` for a missing row).

### Patch changes

- A request body sent to an operation that accepts none is refused with 415 `BODY_NOT_ACCEPTED` ("This operation does not accept a request body") instead of a misleading `UNSUPPORTED_MEDIA_TYPE`.
- Built-in CRUD create and update now read the response row through the operation's own transaction, so PostgreSQL and MySQL return the created or updated row instead of a bare CREATED_OUTSIDE_READ_SCOPE / UPDATED_OUTSIDE_READ_SCOPE acknowledgement.
- D1 `acknowledgeBatch` now applies the core acknowledgement transition, reports an unobserved record as a conflict, and re-evaluates the fence when the record changes concurrently (a lost race is a stale claim, a concurrent lease renewal no longer fails the acknowledgement); the MySQL atomic record backend retries deadlocked transitions up to 12 times instead of 3, so concurrent claimers no longer fail with a raw deadlock error.
- `projectCommittedResult` hooks now read through the writing transaction, so they see the row just written on PostgreSQL and MySQL.
- A valid session for another scope on a route with a fixed scope (for example a tenant user calling a platform route) is now refused with 403 `ForbiddenError` instead of a 500 configuration error, so callers can no longer trigger server errors on such routes.
- Validation errors thrown by schemas from another zod installation are answered with 400 VALIDATION_ERROR instead of 500.
- MySQL idempotency store: responses that are JSON `null` or a JSON string now replay correctly (they previously never replayed), and a concurrent first acquire that hits an InnoDB deadlock is retried instead of failing.
- Job progress stores: a write now returns the row it wrote rather than a concurrent writer's later one (MySQL and D1), the PostgreSQL and D1 stores reject a first progress write that names a sequence other than 0 with a conflict as MySQL already did, and the MySQL store reads `percent` without losing precision.
- Fenced leases keep their fencing token across `release`: the next grant after a release now continues the sequence instead of restarting at 1, so the token is strictly increasing for a resource whether the previous lease was released or expired. The MySQL lease backend now retries a transition that InnoDB aborts with a deadlock or lock-wait timeout, as the MySQL record backend already did, instead of surfacing the error to a caller racing for the same lease.
- CRUD list handlers accept an opt-in `cursorTtlMs`; their cursors then carry an integrity-protected expiry and an expired cursor is refused with the stale-cursor 400.
- A request with no trusted session (`resolveTrustedSession` returned `undefined`) on an authenticated route without an anonymous principal now answers 401 UNAUTHORIZED instead of 500.
- The MySQL repository now refuses every predicate that matches all rows in `deleteWhere`, `updateManyWhere`, `updateOneWhere` and `findOneWhere`, as the PostgreSQL and D1 repositories already did. It previously recognised only a literal `true` predicate, so `Predicate.alwaysTrue()` (an empty `and`), `Predicate.not(Predicate.alwaysFalse())` or an `or` containing an always-true branch ran as `WHERE (1 = 1)` and updated or deleted every row.
- MySQL sequence and temporal stores now compare scope ids byte-for-byte (utf8mb4_0900_bin plus a SHA-256 `scope_hash` key); apply `0006_byte_exact_identifiers.sql` before upgrading.
- Fix three defects found by HTTP fuzzing: Fastify idempotent update and delete requests with path parameters were refused with 400, the Fastify CRUD plugin answered oversized bodies and unparseable Content-Type values with Fastify's own error codes instead of `REQUEST_BODY_TOO_LARGE` and `UNSUPPORTED_MEDIA_TYPE`, and a request body too large to fingerprint for `Idempotency-Key` caused a 500 instead of a 400.
- MySQL cache tag generations: the reference `cache_generations.scope` column is now `VARCHAR(256)` (it was `VARCHAR(100)`), so tags of up to the 256-byte maximum no longer fail every advance with "Data too long". Existing tables get the new width from `0006_byte_exact_identifiers.sql`.
- The `vitest` peer dependency range is widened to `^4.1.7 || ^5.0.0`. The published contract suites now declare their sequential groups with `describe(name, { concurrent: false }, ...)`, which runs sequentially on both Vitest 4.1 and Vitest 5 (`describe.sequential` is no longer available in Vitest 5's types).

## [0.1.0] — 2026-10-16

First public release, experimental. Internal builds before it were numbered `2.0.0-rc.N`; that numbering
is retired, and the sections below describe the changes since those builds. From here on, each entry is
generated from changesets by `npm run release:version`.

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
- **Kernel.** One `Clock` and `TimerClock` in `@xonava/core/kernel`. The other clock abstractions are defined in
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
