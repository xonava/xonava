# Known limitations

> **Project status: experimental.** Xonava is in its `0.x` series. Public APIs, persistence schemas,
> and wire formats may change in any minor release before `1.0.0`. Read this page before adopting the release or planning an upgrade. Behaviour changes
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
[release checks guide](guides/release-checks.md).

## Deployment requirements

### Apply the migrations first

The reference schema ships in the package as `@xonava/adapters/migrations/<postgres|mysql|d1>/` (files in
`node_modules/@xonava/adapters/migrations/`), copies of the fixture migrations (MySQL `0001` without the fixture's `DROP TABLE` resets) under
`packages/testing/fixtures/<database>/migrations/` (`npm run verify:fixtures` enforces this). The table, schema and
column names in them are fixture defaults that the store factories let you change; rename them in the files you apply, or
port the migrations to your own schema. Apply them before you deploy the new adapters. Apply the files in order; the
adapters README lists which files are safe to re-run (the published MySQL `0001` omits the fixture's table resets and is safe to re-run).

| Database   | Migration                              | Required                                                                                      |
|------------|----------------------------------------|-----------------------------------------------------------------------------------------------|
| PostgreSQL | `0002_workflow_signal_buffering.sql`   | Yes                                                                                           |
| PostgreSQL | `0003_job_partition_head_index.sql`    | Yes; without it each job claim candidate rescans the jobs table                                |
| PostgreSQL | `0004_lease_records.sql`               | Only if you use `createPgLeaseStore` / `PgAtomicLeaseBackend`                                  |
| PostgreSQL | `0005_job_scope_key.sql`               | Only for jobs and schedules with a non-default `platformKey` / `systemKey`; map the column as `scopeKey` |
| MySQL      | `0002_workflow_signal_buffering.sql`   | Yes                                                                                           |
| MySQL      | `0003_schedule_next_run_nullable.sql`  | Yes; without it a schedule with no future occurrence cannot retire                             |
| MySQL      | `0004_job_partition_head_index.sql`    | Yes; without it each job claim candidate rescans the jobs table                                |
| MySQL      | `0005_job_scope_key.sql`               | Yes; the job and schedule stores read and write `scope_key`                                    |
| MySQL      | `0006_byte_exact_identifiers.sql`      | Yes; without it keys differing by case or trailing space collide and non-ASCII sequence/temporal scopes fail; also widens `cache_generations.scope` to `VARCHAR(256)` so cache tags of up to 256 bytes fit |
| D1         | `0002_workflow_signal_buffering.sql`   | Yes                                                                                           |
| D1         | `0003_job_partition_head_index.sql`    | Yes; without it each job claim candidate rescans the jobs table                                |
| D1         | `0004_lease_records.sql`               | Only if you use `createD1LeaseStore` / `D1AtomicLeaseBackend`                                  |
| D1         | `0005_job_scope_key.sql`               | Only for jobs and schedules with a non-default `platformKey` / `systemKey`; map the column as `scopeKey` |

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
- **MySQL `0006` rebuilds every framework table** (`MODIFY` of identifier columns to `utf8mb4_0900_bin`, plus a new
  primary key on `sequences` and `temporal_*`). Plan a maintenance window; each table is locked for writes while it
  rebuilds. The `MODIFY` statements are safe to re-apply; the `sequences` / `temporal_*` statements add `scope_hash`
  and must run once. Comparison becomes stricter (case-sensitive, no padding), so existing rows cannot start to
  violate a unique key and the migration cannot fail on a duplicate; the pre-check is therefore informational. The
  old collation already merged `K`/`k` and `'a'`/`'a '` into one row, so no duplicate exists to find, but those
  merged rows are now distinct identities. To see where callers relied on the merge, look for spellings that
  differ only by case or padding, for example ``SELECT `scope`, `key` FROM idempotency WHERE `key` <> TRIM(`key`)
  OR `scope` <> TRIM(`scope`)`` (padded identifiers) and ``SELECT LOWER(`key`), COUNT(*) FROM idempotency GROUP BY
  LOWER(`scope`), LOWER(`key`) HAVING COUNT(DISTINCT `key`) > 1`` (the second returns rows only on a database that
  was already case-sensitive). Clients must send each identity in one spelling, as before.
- **MySQL `0003` is safe to re-apply.** PostgreSQL and D1 already allow a `NULL` `next_run_at`.
- **The workflow migration backfills existing receipts** as consumed at their delivery time, in
  delivery order. Otherwise old receipts would become pending and wake future waits.
- **`0005_job_scope_key.sql` adds a nullable `scope_key` column** to `jobs` and `schedules`. It holds the
  `platformKey` / `systemKey` of platform and system rows, `NULL` for tenant rows and for the framework
  defaults (`default`, `framework`). Add a `scopeKey` entry to the job and schedule column maps on PostgreSQL
  and D1. Without the column, the PostgreSQL and D1 stores still work for default-key jobs and refuse to
  enqueue a non-default key with a `ConfigurationError` (they never store it under the default). MySQL
  `0005` also rebuilds `jobs` to redefine the generated `active_partition_tenant` column
  (`COALESCE(tenant_id, scope_key, '')`), so plan a maintenance window; apply it once.
- **The job partition-head index** covers `(partition_key, scope, tenant_id, status)`. It is partial on
  `partition_key IS NOT NULL` on PostgreSQL and D1.

### Rolling deployment order

Migrate, drain the old nodes, then deploy the new code. Receipts that old nodes insert after the
migration receive a `seq` and stay pending, so a later `wait` for the same name consumes them. On D1,
rows written by old nodes have a `NULL` `seq`.

Instances that resumed before the migration have no `resume_signal_id`. They fall back to the latest
receipt by name, which is the previous behaviour.

During a rolling deploy, expect these transitional effects:

- **Platform and system keys.** Apply `0005_job_scope_key.sql` before deploying; old code ignores the
  nullable column, so migrating first is safe. Rows written before the fix, and default-key rows written by
  new workers, have `scope_key = NULL` and decode to `default` / `framework` on every version. A job with a
  non-default key written by a new worker is read by an old worker as the default key, so its
  `executionScope` is wrong there (claims, leases and fencing are unaffected, because they never read the
  key). Old workers also treat all platform (or all system) jobs that share a partition key as one
  partition, which only serializes more than new workers do and never runs two jobs of one key at once.
  Drain old workers before enqueueing non-default keys.

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

- **MySQL sequence first allocation can deadlock.** Concurrent first allocations of one `sequences` key
  can deadlock (InnoDB error 1213) when the transaction holding the key rolls back. The database aborts one
  caller, so callers must retry the whole transaction. Committed numbers stay gapless and unique; a rolled-back
  allocation restores the counter.
- **No savepoints.** A failed nested operation fails its parent, but its own writes are not rolled back
  individually. The parent's whole transaction rolls back.
- **Driver errors.** Drizzle adapters report any non-framework error that escapes a transaction as
  `PersistenceError`, with driver detail removed. Business code should throw framework errors (for
  example `BusinessRuleError`) so its own failures reach the caller.
- **Telemetry redaction is broad by design.** The `token` pattern also matches keys such as `maxTokens`.
- **Deadlines.** Database-enforced deadlines are available only where the adapter reports the
  `transactionTimeouts` capability.

## Authorization

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
- **List cursors** do not expire unless the list handler sets the opt-in `cursorTtlMs`.
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
- **Job checkpoints and U+0000.** A job checkpoint whose strings or keys contain U+0000 is refused with a
  `ConfigurationError` on every database, because PostgreSQL `jsonb` cannot store it. Unlike failure text, a
  checkpoint is not replaced, so the resumed state is never silently altered. Checkpoints MySQL or D1 stored
  before this rule still read back, so their jobs resume; only new writes are refused.
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

## Tooling

- **npm 10 crash on the Vitest peer.** npm 10.9 can crash with `Cannot read properties of null (reading 'edgesOut')` while it resolves the `vitest` 4 peer of `@xonava/testing`. `--legacy-peer-deps` avoids the crash, but it also skips the peer, so install `vitest` explicitly.

## Not implemented

Planned work, including features that are not implemented yet, is tracked only in the
[plan](../TODO.md).
