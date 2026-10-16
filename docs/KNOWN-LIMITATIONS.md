# Known limitations

> **Project status: experimental.** Framework 2.0 is published as a release candidate
> (`2.0.0-rc.2`). Public APIs, persistence schemas, and wire formats may still change before
> `2.0.0`. Read this page before adopting the release or planning an upgrade. Behaviour changes
> are listed in the [changelog](../CHANGELOG.md).

This page lists what the framework does not do, where its database adapters differ on purpose, and
what a deployment must do before it runs this release.

## Certification scope

Release evidence comes from local multi-backend runs against PostgreSQL, MySQL, and D1 (Miniflare
SQLite). It does not certify:

- production topology;
- custom adapters;
- external advisories that were not assessed offline.

A green unit or interface suite is not evidence of provider behaviour. See the
[certification guide](guides/certification.md).

## Deployment requirements

### Apply the migrations first

The repository ships no production DDL. The reference schema is the fixture migrations under
`packages/testing/fixtures/<database>/migrations/`. Port the migrations below to your own schema or
table names, and apply them before you deploy the new adapters.

| Database   | Migration                              | Required                                                                                      |
|------------|----------------------------------------|-----------------------------------------------------------------------------------------------|
| PostgreSQL | `0002_workflow_signal_buffering.sql`   | Yes                                                                                           |
| PostgreSQL | `0003_job_partition_head_index.sql`    | Yes; without it each job claim candidate rescans the jobs table                                |
| MySQL      | `0002_workflow_signal_buffering.sql`   | Yes                                                                                           |
| MySQL      | `0003_schedule_next_run_nullable.sql`  | Yes; without it a schedule with no future occurrence cannot retire                             |
| MySQL      | `0004_job_partition_head_index.sql`    | Yes; without it each job claim candidate rescans the jobs table                                |
| D1         | `0002_workflow_signal_buffering.sql`   | Yes                                                                                           |
| D1         | `0003_job_partition_head_index.sql`    | Yes; without it each job claim candidate rescans the jobs table                                |

The workflow migration is not optional. `commit()` writes `resume_signal_id` on every workflow
transition, so an un-migrated workflow table breaks every workflow commit, not only signal delivery.

### Migration operations

- **Apply each statement exactly once.** MySQL `0002` is not idempotent after a partial failure, and
  the D1 files must be applied exactly once.
- **PostgreSQL `0002` is safe to re-run**, but it holds an exclusive lock on `workflow_signals`
  during its backfill and unique-index build.
- **MySQL `0002` rebuilds tables** through `MODIFY` statements. Plan a maintenance window.
- **Create PostgreSQL indexes with `CREATE INDEX CONCURRENTLY`** in production. It cannot run inside a
  transaction or a `DO` block.
- **MySQL `0003` is safe to re-apply.** PostgreSQL and D1 already allow a `NULL` `next_run_at`.
- **The workflow migration backfills existing receipts** as consumed at their delivery time, in
  delivery order. Otherwise old receipts would become pending and wake future waits.
- **The job partition-head index** covers `(partition_key, scope, tenant_id, status)`. It is partial on
  `partition_key IS NOT NULL` on PostgreSQL and D1.

### Rolling deployment order

Migrate, drain the old nodes, then deploy the new code. Receipts that old nodes insert after the
migration receive a `seq` and stay pending, so a later `wait` for the same name consumes them. On D1,
rows written by old nodes have a `NULL` `seq`.

Instances that resumed before the migration have no `resume_signal_id`. They fall back to the latest
receipt by name, which is the previous behaviour.

During a rolling deploy, expect these transitional effects:

- **Job fingerprints.** Job fingerprint version 5 is not matched by workers on version 4. An older
  worker that re-enqueues a job without an explicit `maxAttempts`, written by a newer worker, receives
  `JobIdempotencyConflictError` until the deploy completes. Schedule occurrences back off and retry.
- **Unknown job definitions.** Workers on older code read the "use the definition's `maxAttempts`"
  sentinel as a very large attempt budget for jobs enqueued without `maxAttempts`.
- **Rate-limit windows** restart once after the deploy.
- **List cursors** issued before the deploy are refused once, with HTTP 400 ("restart from the first
  page").
- **KV cache counters.** Tag generations are read from and written to both the old and new counter
  layouts during the upgrade. Drop the old layout one release after every instance is upgraded.

### MySQL session time zone

MySQL `TIMESTAMP` columns compare in the session time zone, so every MySQL session must run in UTC.
`assertMySqlUtcSession` checks one connection. The adapter does not own your connection pool, so make
every pooled connection use a UTC session (for example, set `time_zone` to `'+00:00'` when a connection
opens). `DATE` and `DATETIME` columns are not affected.

### Globally unique signal identifiers

Workflow signal identifiers are deduplicated across all instances and tenants. Use globally unique
identifiers such as UUIDs. A signal whose identifier was already used for another instance returns
`duplicate: true` and is dropped.

### Entity cache prefixes

Duplicate explicit cache prefixes are detected for entities registered with a Drizzle registry, either
as compiled definitions or in the bootstrap `config.cache.keyPrefix`. `CRUD()` resources wired without a
registry, or registered as bare descriptors, must call `assertUniqueEntityCachePrefixes` themselves.

## Accepted differences between databases

These differences are intentional. The differential suites accept exactly these behaviours.

- **D1 claim read-back.** D1 reads a claimed job back in a separate statement after the claim `UPDATE`.
  A `cancel` that lands between the two can leave the claim result without a job whose attempt it
  consumed. The job ends `cancelled` either way.
- **Transactions on D1.** D1 has no interactive transactions. Commit-outcome classification is proven
  on PostgreSQL and MySQL only.
- **MySQL transaction timeouts.** Timeouts use a session `max_execution_time` and
  `innodb_lock_wait_timeout`, plus a `KILL QUERY` watchdog at the deadline. The watchdog needs the same
  MySQL user or `CONNECTION_ADMIN`, and a pooled client. A single-connection client gets session limits
  only, with `transactionTimeouts: false`. `COMMIT` itself is not bounded by the timeout.
- **Execution history.** `executionHistory` accepts `"required"` or `"best_effort"`. MySQL defaults to
  `"required"`. Set the option explicitly when comparing deployments.
- **PostgreSQL text.** PostgreSQL `text` cannot hold U+0000. The job store replaces each U+0000 in
  failure text with U+FFFD instead of failing the write. MySQL and D1 do not need this replacement.
- **PostgreSQL cursors.** String-mode cursor values of `infinity` and `-infinity` compare as text.
- **Column types in authorization.** `datetime` policy literals are compared as canonical UTC instants.
  A `datetime` column must hydrate as a `Date`, or as that exact canonical string. A column that stores
  datetimes as text in another format compares as text, so a date-time equality policy does not match
  it. `date` literals stay `YYYY-MM-DD` and match both string and `Date` hydration.
- **Unknown schedule scope.** A schedule row whose `scope` is missing or invalid makes
  `claimDueSchedules` raise `ValidationError` while the claimed rows are mapped. Other schedules in the
  same batch keep their leases until those leases expire. They run late, not twice.

## Operations and transactions

- **No savepoints.** A failed nested operation fails its parent, but its own writes are not rolled back
  individually. The parent's whole transaction rolls back.
- **Driver errors.** Drizzle adapters report any non-framework error that escapes a transaction as
  `PersistenceError`, with driver detail removed. Business code should throw framework errors (for
  example `BusinessRuleError`) so its own failures reach the caller.
- **Telemetry redaction is broad by design.** The `token` pattern also matches keys such as `maxTokens`.
- **Deadlines.** Database-enforced deadlines are available only where the adapter reports the
  `transactionTimeouts` capability.

## Authorization

- **Query grants from conditional allow policies** are honoured without evaluating their conditions at
  query time. Only grants that come from deny policies are dropped.
- **Read allowlists in the lowest tier.** A lowest-tier allow with a read map narrows the readable
  fields even when a higher tier decides the row, because read maps are allowlists.
- **Soft deletes.** If an ABAC policy condition references a soft-delete field, plan-constrained soft
  deletes are refused, because the update would leave the policy's scope.
- **Date fields on write.** ABAC `date` fields accept only `YYYY-MM-DD` strings or `Date` objects. A
  `Date` that is not UTC midnight is evaluated as that instant. If the database casts it to a calendar
  date, a date-equality deny can be bypassed. JSON request bodies cannot produce `Date` values, so this
  affects only server-side hooks that write `Date`s. Write `date` values as `YYYY-MM-DD` strings in those
  hooks.
- **Trusted scopes.** Trusted ABAC and structural scopes are exempt from the caller's query budget by
  identity brand. A cloned scope loses the brand and is charged to the caller, which fails closed.
- **RFC 3339 parsing.** The parser rejects lowercase `t` and `z` and the leap second `:60`. An unknown
  operator evaluates to `FALSE`; validated inputs never reach it.

## Entities, queries, and idempotency

- **Custom fields with durable codecs** are rejected until persistence applies the codecs on write and
  read.
- **List cursors** carry no `expiresAt`.
- **Tenant idempotency scopes** have two encodings, `fscope:v1:` and `tenant:N:`. Both are recognised.
- **Legacy fingerprints.** Stored job fingerprints of versions 4 and 3 are still recognised through
  compatibility-only constructions. Version 3 and 4 digests cannot tell an omitted `maxAttempts` from an
  explicit 3.

## Jobs and schedules

- **Lease expiry while queued.** A claimed job that waits behind a slow earlier job in the same batch can
  lose its lease before it starts. Its attempt was counted at claim time.
- **Dead-lettering on claim.** Dead-lettering an exhausted claim is a separate statement from the claim.
  It is safe and idempotent, but not part of the same transaction, and it writes no execution-history
  row.
- **Schedule backoff.** Failure backoff grows with the time since the previous failure, not with a
  failure count.
- **Unknown job definitions** are held for at most `unknownDefinitionMaxDeferralMs` (24 hours by default)
  from their first deferral, then dead-lettered.

## Workflows

- **Pending receipts of terminal instances.** Pending signal receipts of an instance that later becomes
  terminal or is cancelled are retained and never consumed.
- **Buffered signals** are kept pending and consumed, at most once and oldest first, by the next `wait`
  for that name. Consumption is atomic with that `wait`'s commit.

## Cache and rate limiting

- **KV generation pairs.** Generation pairs that concurrent invalidations have diverged stay diverged,
  fenced and bounded, until the next advance.
- **Rate-limit memory.** The in-memory rate-limit store is bounded. At capacity it fails closed rather
  than evicting buckets.

## Not implemented

Features that are not implemented yet are tracked in the [plan](../TODO.md#5-not-implemented-yet).
