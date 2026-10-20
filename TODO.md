# Plan

This file is the single place where remaining work is tracked. No other document, issue list, or
report keeps its own to-do list; they link here instead.

- **Adding work:** add a work package to the right wave. An accepted bug report or feature request
  becomes a work package here, with a link to its issue.
- **Finishing work:** delete the work package in the pull request that completes it. What shipped is
  recorded in the [changelog](CHANGELOG.md) through a changeset.
- **Other documents:** [known limitations](docs/KNOWN-LIMITATIONS.md) describes how the current release
  behaves, not what will change. It does not list planned work.

Status: **experimental**. `0.1.0` is published on npm. Target for `1.0.0`: core and adapters both above
9.5, measured by the [quality gates](#quality-gates) below rather than by opinion.

## How to run this plan

Each work package (WP) is written to be handed to one subagent. The orchestrating session (Opus) owns
design gates, review and merging; subagents implement.

**Model assignment**

- **Haiku:** mechanical work with an exact recipe: mirror an existing file, edit docs, change config,
  fix a named line. The WP lists every file to touch.
- **Sonnet:** implementation that needs reasoning across several files, new tests, or a new adapter.
  The WP fixes the design; Sonnet does not change public API shapes beyond what the WP states.
- **Opus:** design gates (marked **Design gate**), reviews, conflict resolution, baseline regeneration,
  and every merge.

**Every WP follows the same procedure**

1. Branch from the latest `dev`: `git fetch origin dev && git checkout -B <branch> origin/dev`.
2. Read every file listed under *Files* before editing. Follow the surrounding style; do not reformat.
3. Implement exactly the *Steps*. If a step is impossible as written, stop and report why instead of
   improvising.
4. Add the tests listed under *Acceptance*. A behaviour change without a test is not done.
5. Run the *Verify* commands plus the standard set: `npm run lint`, `npm run typecheck`, `npm test`,
   `npm run verify:docs`, `npm run test:verification`. Report the exact output of any failure.
6. If package users see the change, run `npm run changeset` (rules in
   [CONTRIBUTING.md](CONTRIBUTING.md#versioning-and-releases)) and delete the WP from this file.
7. Commit with a descriptive message, push, and open a pull request into `dev`. Do not merge.
8. Opus reviews the diff for blatant issues, fixes or sends it back, adds missing tests, and merges.

**Environments.** D1 suites run anywhere (Miniflare). PostgreSQL and MySQL suites need
`FRAMEWORK_TEST_PG_URL` and `FRAMEWORK_TEST_MYSQL_URL`; a subagent without them writes the suite, runs it
on D1, and states in the pull request that PostgreSQL and MySQL were not run. Opus or the maintainer
runs them before the wave closes.

**Parallelism.** WPs in the same wave touch disjoint files unless *Depends on* says otherwise and can
run at the same time. Files shared by many WPs (`scripts/verification/differentialBaseline.json`,
`docs/governance/public-api-manifest.json`, `scripts/verification/approvedFrameworkExports.json`) are
edited only by the WP that owns them or by Opus at wave close.

## Quality gates

`1.0.0` ships when every gate is green in CI. Each gate is created by the WP named after it.

| Gate | Target | Created by |
| --- | --- | --- |
| Unit coverage, core | lines 96, branches 90 (today 94 / 86) | Q2 |
| Unit coverage, adapters | lines 90, branches 82 (today 76 / 61) | Q2 |
| Mutation score | core ≥ 80 %, adapters `http/` and `drizzle-shared/` ≥ 70 % | Q5 |
| Real-database differential suites | every durable store on PostgreSQL, MySQL and D1 | A2–A8 |
| HTTP fuzzing | property suites over all CRUD and write handlers in DF1 | Q4 |
| Performance | hot-path benchmarks within 25 % of the recorded baseline | Q6 |
| Upgrade compatibility | N-1 suite against the previous published release | C3 |
| Soak | 30-minute crash/lease soak with no invariant violation | C4 |
| Threat model | reviewed `docs/spec/security.md` threat model | C5 |
| CI | every gate above runs on pull requests or nightly | Q1 |

## Wave 1: pilot feedback and missing adapters

Source: feedback from a TanStack Start application on Cloudflare (D1, R2, KV, Drizzle) against `0.1.0`.
Request IDs R1–R8 refer to that feedback.

### F1 Public, application-safe error contract (feedback R2)

- [ ] Sonnet. Branch `feat/public-error-contract`. **Design gate:** Opus approves the spec diff first.
- **Today:** `FrameworkCoreError.safeMessage` and `publicCode` always come from the registry in
  `packages/core/src/domain/errors.ts:36-62`. A `BusinessRuleError` always answers "Business rule
  violation". Missing headers are plain `ValidationError`s (`createFrameworkWriteHandler.ts:320`) or 409
  `ConflictError`s ("Version is required", `crudHandlers/update.ts:424`, `delete.ts:76`).
- **Design:**
  1. New class `PublicBusinessError extends BusinessRuleError` in `errors.ts`:
     `constructor(input: { publicCode: string; publicMessage: string; fields?: readonly string[] }, details?: unknown)`.
     `publicCode` must match `/^[A-Z][A-Z0-9_]{2,63}$/` and must not equal any registry code.
     `publicMessage` is 1–200 characters with no control characters. `fields` has at most 20 entries,
     each 1–200 characters. Invalid input throws `ConfigurationError`. The instance's `safeMessage` and
     `publicCode` are the supplied values; `code` stays `BAD_REQUEST`, so the status stays 400.
  2. Two new registry codes, added to the code union, the registry, `docs/spec/errors.md` and the
     HTTP status map: `REQUIRED_HEADER_MISSING` ("A required request header is missing", status 400) and
     `PRECONDITION_REQUIRED` ("A precondition header is required", status 428). Each takes
     `safeMetadata: { header: "<Header-Name>" }`.
  3. Classes `RequiredHeaderMissingError(header)` and `PreconditionRequiredError(header)`.
  4. `createFrameworkErrorHandler` adds `details` only for these three cases: `{ fields }` for
     `PublicBusinessError`, `{ header }` for the two header errors. Every other error keeps today's body.
  5. Missing `Idempotency-Key` throws `RequiredHeaderMissingError("Idempotency-Key")`. Missing `If-Match`
     on update and delete throws `PreconditionRequiredError("If-Match")` (status changes 409 → 428).
- **Rules for the spec:** public business errors must never be used for authentication or
  authorization failures; 401, 403 and 404 stay fixed so they cannot reveal existence.
- **Files:** `packages/core/src/domain/errors.ts`, `docs/spec/errors.md`, `packages/adapters/src/http/handleFrameworkCoreError.ts`,
  `createFrameworkWriteHandler.ts`, `crudHandlers/update.ts`, `crudHandlers/delete.ts`, and the error and
  handler tests listed in the error tests (`errors.test.ts`, `errorTaxonomy.test.ts`,
  `handleFrameworkCoreError.test.ts`).
- **Acceptance:** a thrown `PublicBusinessError` returns its code, message and fields; constructor
  validation rejects bad input; an unknown error still returns the generic 500; a `ForbiddenError`
  still returns the fixed message; a missing idempotency key returns `REQUIRED_HEADER_MISSING` with
  `details.header`; a missing `If-Match` returns 428. ER1 certification still passes
  (`node scripts/verification/verifyER1Certification.mjs`). Changeset: minor (the 409 → 428 change is
  breaking, so the summary starts with `**Breaking:**`).

### F2 Business-action writes (feedback R1)

- [ ] Sonnet. Branch `feat/business-action-writes`. **Depends on:** F1 (same files).
  **Design gate:** Opus approves the spec diff first.
- **Today:** ABAC policies already accept any action listed in the module catalog
  (`abacPolicySchema.ts:585`), and module admission (`frameworkAuthorization.ts:56`) and
  `enforceAbacWrite` (`abacWrite.ts:143`) take any action string. Only three places are fixed to CRUD:
  the handler's `action` type (`createFrameworkWriteHandler.ts:136`), `AbacAuthorizer.assertWrite`
  (`abacAuthorizer.ts`), and the route-binding keys (`CrudRouteBindings`, `frameworkAdapterDeps.ts:29`;
  `CrudRouteKey`, `defineEntity.ts:21`).
- **Design:**
  1. `action` becomes `"create" | "update" | "delete" | BusinessActionName`, where a business action is
     a string matching `/^[a-z][a-zA-Z0-9_-]{0,63}$/` that is not `read`, `manage`, `create`, `update`
     or `delete`. Checked at construction.
  2. New optional `routeKey?: string` argument. It defaults to `action` and must exist in
     `requestNormalization.routeBindings`; otherwise `ConfigurationError` at construction. Widen the
     route-binding map type to `CrudRouteBindings & Readonly<Record<string, CompiledRouteBindingRef>>`.
  3. Widen `assertWrite`'s action to `string` and remove the cast at `createFrameworkWriteHandler.ts:301`.
     A business action is admitted by its own grant only: no implicit `update`, and `manage` keeps its
     current meaning.
  4. New CRUD update option `protectedFields?: readonly string[]`. A generic update whose changed
     fields intersect it is refused with `ForbiddenError`, so ordinary updates cannot perform a business
     operation. Documented as the way to reserve fields for business actions.
  5. Idempotency scope and rate-limit keys already include the action; keep them, and add a test that
     proves it.
- **Spec:** add a "Business actions" section to `docs/spec/operations.md` and a pointer from
  `docs/spec/security.md`.
- **Acceptance:** new test file `packages/adapters/src/http/__tests__/businessActionWrites.test.ts`
  covering:
  - an `approve`-only grant succeeds without `update`;
  - an `update`-only grant cannot run `approve`;
  - a deny on `approve` wins;
  - field write restrictions apply to `approve`;
  - `protectedFields` blocks a generic update of a reserved field;
  - an idempotent retry of `approve` replays, and a key reused for `update` conflicts;
  - a rollback in the business action leaves no audit or outbox rows;
  - revoking the grant (a new bundle digest) refuses the next call;
  - construction fails for `action: "read"` and for a missing route binding.

  Changeset: minor.

### F3 Committed-response helper (feedback R3)

- [ ] Sonnet. Branch `feat/committed-response-helper`. **Depends on:** F2.
- **Today:** built-in CRUD uses `buildCommittedReadResponse` and `loadReadableMutationRecord`
  (`crudHandlers/shared.ts:362-454`), which are not public. Custom handlers rebuild them.
- **Design:** export `readCommittedRecord(args)` from `@xonava/adapters/http`, a thin public wrapper
  over the same internals, returning a discriminated result:
  `{ kind: "record", record }`, `{ kind: "outside-read-scope" }`, `{ kind: "revision-unavailable" }`
  (the durable version differs from the committed one), or `{ kind: "deleted" }`. It applies the
  read scope, field overrides and projection exactly as built-in CRUD does, and never substitutes a
  newer revision. Rewire `create.ts`, `update.ts` and `recoverCommittedResponse` to use it, so there is
  one path.
- **Acceptance:** tests showing initial and recovered responses project identically; a newer
  revision yields `revision-unavailable`, not the newer record; a deleted record yields `deleted`;
  existing `writeReadScope.test.ts` passes unchanged. Document the recipe in
  `docs/typescript/http-adapters.md`. Changeset: minor.

### F4 Method and body matrix (feedback R4, part 2)

- [ ] Haiku. Branch `docs/http-method-body-matrix`.
- **Steps:** add a table to `docs/typescript/http-adapters.md` with one row each for list, detail,
  create, update, delete and custom write handlers, and columns for whether the operation reads a body,
  the behaviour for an empty body, a JSON body without a schema (`BODY_NOT_ACCEPTED` 415), a non-JSON
  content type (`UNSUPPORTED_MEDIA_TYPE` 415), malformed JSON (`INVALID_JSON` 400) and an oversize body
  (413). The facts are in `packages/adapters/src/http/requestBody.ts:86-108`; GET handlers never read a
  body.
- **Acceptance:** add one regression test per row to `requestBody.test.ts` so the table is enforced.

### F5 Ownership guide for non-staff users (feedback R7)

- [ ] Sonnet. Branch `docs/ownership-guide`.
- **Steps:** write `docs/guides/ownership.md`: an owner-only "orders" entity for customer accounts,
  using a trusted session, tenant scope, a deny-by-default bundle with an `userAttr: "user.id"`
  ownership condition, compiled list filtering, response projection, and update and delete
  authorization. Explain what `skipCapabilityCheck` skips (only capability-key checks; module action
  and ABAC collection checks still run, see `packages/core/src/entity/capabilityCheck.ts`), and that
  removing a capability string does not prove the bundle denies access. Add the code samples to the
  documentation-example test (`packages/testing/tests/documentationExamples.test.ts`) so they
  type-check.
- **Acceptance:** `npm run verify:docs` and the documentation-example test pass.

### F6 Cloudflare R2 object store and the object-store contract suite (feedback R8)

- [ ] Sonnet. Branch `feat/r2-object-store`.
- **Today:** `ObjectStore` (`packages/core/src/object-store/objectStore.ts`) has only an in-memory
  adapter, which ignores checksums, `metadata` and `version`. No contract suite exists, although the
  spec (`docs/spec/object-store.md`, certification O1) lists the requirements. Miniflare
  3.20250718.3, already pinned in `packages/testing`, supports `r2Buckets` and `getR2Bucket`.
- **Steps:**
  1. **Contract suite** in `packages/testing/src/contracts/object-store/` modelled on
     `src/contracts/cache-adapter`. It takes a factory and covers: round trip for bytes and streams,
     absence on `get`/`head`/`delete`, metadata and content-type fidelity, custom metadata, `sha256`
     checksum accepted and a mismatched checksum rejected, length mismatch rejected, early stream
     cancellation, an aborted signal before I/O, an expired deadline, hostile keys (empty, 1,025
     characters, NUL), and that provider failures surface as `UnavailableError` without provider text.
     Export it as `@xonava/testing/contracts/object-store`. A new subpath changes the governance files:
     `packages/testing/package.json` exports, `scripts/verification/approvedFrameworkExports.json`,
     `docs/governance/public-api-manifest.json`, and the `publicIndexes` list in
     `scripts/verification/verifyFrameworkHardening.mjs`.
  2. **In-memory store:** make it pass the suite: verify `sha256` checksums, keep `metadata`, honour
     `version` on reads.
  3. **R2 adapter** `R2ObjectStore` in `packages/adapters/src/storage/r2ObjectStore.ts`, exported from
     `@xonava/adapters/storage`. Type the binding structurally with a local `declare class R2Bucket`
     exactly as `kvCacheAdapter.ts:5-15` does for KV; do not add `@cloudflare/workers-types`. Map
     `contentType` to `httpMetadata.contentType`, `metadata` to `customMetadata`, a `sha256` checksum to
     R2's `sha256` put option, and R2's `version` and `etag` to the result. A versioned `get` or `head`
     returns `null` when the current version differs. Signed URLs are not available through the
     binding, so `signUpload` and `signDownload` are omitted; document that.
  4. **Tests:** run the contract suite against the in-memory store in unit tests, and against R2 in
     `packages/testing/integration/d1/r2ObjectStore.integration.test.ts` using `new Miniflare({ r2Buckets:
     ["BUCKET"] })` and `getR2Bucket("BUCKET")`.
- **Acceptance:** the suite passes for both stores. Changeset: minor.

### F7 Durable upload guide

- [ ] Sonnet. Branch `docs/durable-uploads`. **Depends on:** F6.
- **Steps:** write `docs/guides/durable-uploads.md` describing the reservation → upload → finalize
  protocol on top of `ObjectStore` and `defineAttachment` (`packages/core/src/storage/attachment.ts`):
  - a reservation row written in the operation transaction;
  - the object put under a reservation-derived key;
  - finalization that reconciles provider metadata with `head`;
  - a cleanup job that deletes objects whose reservation expired unfinalized and never deletes a
    referenced object;
  - idempotent retry at every step.

  State plainly that the database and the object store are not atomic, and say where authorization and
  size and type limits run. Include a type-checked example.
- **Acceptance:** `npm run verify:docs` passes; the example is in the documentation-example test.

### F8 Supporting-read recipe and module catalog (feedback R5, R6)

- [ ] Opus. **Design gate only:** decide whether R5 (catalog introspection) and R6 (supporting reads)
  become APIs or stay documented application patterns. Record the decision here as new WPs or as a
  "not planned" note in the spec.

### A1 Concrete lease backends for PostgreSQL and D1

- [ ] Sonnet. Branch `feat/pg-d1-lease-backends`.
- **Today:** MySQL ships `MySqlAtomicLeaseBackend` and `createMySqlLeaseStore`
  (`packages/adapters/src/drizzle-mysql/mysqlAtomicBackends.ts:19,34`). PostgreSQL and D1 export only
  `createDrizzlePgLeaseStore(backend)` and the D1 equivalent, with no backend, so users must write one.
- **Steps:**
  1. Add `PgAtomicLeaseBackend` next to `pgAtomicRecordBackend.ts` and `D1AtomicLeaseBackend` next to
     `d1AtomicRecordBackend.ts`. Implement `AtomicLeaseBackend`
     (`drizzle-shared/fencedLeaseStore.ts:5`) with the same semantics as the MySQL class: lease time on
     the database clock, a fenced revision, configurable table names.
  2. Add convenience factories `createPgLeaseStore` and `createD1LeaseStore`.
  3. Add `lease_records(resource_key, lease, revision)` tables to the PostgreSQL and D1 fixture
     migrations as new numbered files, and list them in the migration table in known limitations.
- **Acceptance:** port the MySQL lease cases from `packages/testing/integration/mysql/ev1.integration.test.ts`
  and `configurableTables.integration.test.ts` to `pg/` and `d1/`. Changeset: minor.

## Wave 2: proof (Sonnet, parallel)

Every A2–A8 suite follows the job-store pattern exactly:
- `packages/testing/integration/shared/<area>StoreDifferential.ts` holds a driver interface, a lockstep
  runner and `define*` functions;
- `<area>StoreDifferentialModel.ts` holds a pure reference model with `generateOps`, `shrinkOps` and
  `describeOps`;
- per-database runners `pg|mysql|d1/<area>StoreDifferential.integration.test.ts` each use an isolated
  schema created in `beforeAll`.

Properties use `forAllAsync` from `packages/core/src/__tests__/differential/harness.ts`, imported by
name with no alias, with at least 50 base runs (`DF1_MIN_BASE_RUNS`). Opus regenerates
`scripts/verification/differentialBaseline.json` with `npm run verify:framework:df1 -- --update-baseline`
when the wave closes.

### A2 Idempotency store differential

- [ ] Sonnet. Branch `test/idempotency-differential`. Area `idempotency`.
- **Model:** acquire, renew, complete, abandon, expiry and replay, compared with each adapter's
  `drizzleIdempotencyStore.ts`. Include concurrent acquire races and fingerprint conflicts.

### A3 Inbox and outbox delivery differential

- [ ] Sonnet. Branch `test/delivery-differential`. Area `delivery`.
- **Model:** the fenced delivery state machine (`drizzle-shared/fencedDeliveryStateMachine.ts`) over each
  database's atomic record backend: claim, acknowledge, fail, retry, fence takeover, and D1's
  `acknowledgeBatch`.

### A4 Lease differential

- [ ] Sonnet. Branch `test/lease-differential`. Area `lease`. **Depends on:** A1.
- **Model:** acquire, renew, release, expiry on the database clock, fence monotonicity, and concurrent
  takeover.

### A5 Sequence differential

- [ ] Sonnet. Branch `test/sequence-differential`. Area `sequence`.
- **Model:** reuse the core sequence model in `packages/core/src/__tests__/differential/primitive*.differential.test.ts`
  against the real `drizzleSequenceStore.ts`, including reset boundaries across time zones and
  concurrent allocation without gaps or duplicates.

### A6 Temporal history differential

- [ ] Sonnet. Branch `test/temporal-differential`. Area `temporal`.
- **Model:** append revisions and snapshots, then reconstruct point-in-time state; compare with the
  core temporal model, including deletes, restores and pages larger than the limit.

### A7 Job progress differential

- [ ] Sonnet. Branch `test/job-progress-differential`. Area `jobProgress`.
- **Model:** reuse `packages/core/src/__tests__/differential/jobProgress.differential.test.ts` against
  each `drizzleJobProgressStore.ts`.

### A8 Cache tag-generation differential

- [ ] Sonnet. Branch `test/tag-generation-differential`. Area `tagGeneration`.
- **Model:** advance and read tag generations through `dbTagGenerationStore.ts` and
  `mysqlTagGenerationStore.ts` under concurrent invalidation. Include the KV adapter's dual-layout
  reads (`kvCacheAdapter.ts:276-319`) against a fake KV namespace.

### S1 Standalone applications: platform scope end to end

- [ ] Sonnet, with an Opus **design gate** on step 1. Branch `feat/platform-scope-proof`.
- **Today:** platform-scoped entities are unit-tested only, and `RootPersistenceProvider.resolvePlatform`
  (`packages/core/src/persistence/provider.ts:138`) is declared but implemented by no adapter.
- **Steps:**
  1. Report how a platform-scoped entity is persisted today through each adapter's
     `drizzlePersistenceProvider.ts`, and propose either implementing `RootPersistenceProvider` in the
     three adapters or removing it from the public surface. Opus decides.
  2. Add `packages/testing/integration/shared/platformScope.ts` with CRUD, list, query and OCC cases for
     an entity with `entityScope: { kind: "platform", acknowledged: true }`, modelled on
     `mysql/repository.integration.test.ts`, plus per-database runners.
  3. An HTTP test with a fixed `platform` scope plan, end to end through `createCrudHandlers`.
  4. Jobs, schedules and a workflow run under `platform` and `system` scope against D1, PostgreSQL and
     MySQL.
  5. A "Standalone application" guide in `docs/guides/` and a short README example, both type-checked.
- **Acceptance:** suites pass on all three databases. Changeset only if step 1 changes the API.

### Q4 HTTP fuzzing

- [ ] Sonnet. Branch `test/http-fuzzing`.
- **Steps:** property suites in `packages/adapters/src/http/__tests__/fuzz/` using `forAllAsync`, over
  the CRUD and write handlers built with `httpCrudFixture.ts`. Generate hostile:
  - bodies: wrong types, huge strings, deep nesting, prototype keys such as `__proto__`, invalid UTF-8;
  - headers: duplicate and oversize values, bad `If-Match` and `Idempotency-Key`;
  - query strings: repeated parameters, malformed filters, forged and truncated cursors;
  - scope inputs.

  Invariants:
  - no 500 except for injected faults;
  - no response contains internal error text or stack frames;
  - every 4xx code is in the documented set;
  - no write occurs without a 2xx;
  - all three framework adapters (Express, Fastify, Hono) return the same status and code for the same
    input.

  Register the suite directory as a DF1 core suite in `scripts/verification/differentialCertification.mjs`,
  because DF1 refuses `forAll` call sites outside its suites.
- **Acceptance:** suites pass at DF1 release volume (`FRAMEWORK_DIFFERENTIAL_SCALE=5`). Every defect
  found is fixed in the same pull request with a regression test.

### Q5 Mutation testing

- [ ] Sonnet for setup, then Haiku per module. Branch `test/mutation-setup`, then
  `test/mutation-<module>`.
- **Setup:** add `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` as root dev dependencies,
  with one config per package that mutates `src/**/*.ts` minus tests. Add `npm run test:mutation -w <pkg>
  -- --mutate <glob>` so a module can run alone. Record the baseline score per module in the pull request.
- **Per module** (`domain`, `query`, `operation`, `execution`, `workflow`, `events`, `entity`, then
  adapters `http` and `drizzle-shared`): for each surviving mutant, add a test that kills it, or mark it
  equivalent with a one-line reason in `stryker-equivalent.md` next to the config. Stop when the module
  meets the gate.
- **Acceptance:** gate thresholds in the quality table; a nightly CI job (Q1) enforces them.

### Q6 Performance baselines

- [ ] Sonnet. Branch `perf/baselines`.
- **Steps:** add vitest `bench` files:
  - `packages/core/src/__tests__/bench/` for predicate evaluation (`evaluatePredicate.ts`), ABAC record
    decisions (`abacDecision.ts`), read-scope compilation (`abacReadScope.ts`) and query budget
    compilation (`queryBudget.ts`);
  - `packages/adapters/src/__tests__/bench/` for SQL predicate compilation (`drizzle-shared/predicateCompiler.ts`,
    every dialect) and cursor predicates;
  - a D1-backed job claim benchmark in `packages/testing`.

  Add `npm run bench` and `scripts/verification/verifyBenchmarks.mjs`, which compares results with a
  committed `benchmarks/baseline.json` and fails on a regression above 25 %.
- **Acceptance:** the baseline is recorded in the pull request; the verifier fails when a benchmark is
  artificially slowed (check by hand, then revert).

### Q1 Continuous integration

- [ ] Sonnet. Branch `chore/ci-workflows`.
- **Steps:** add these workflows:
  - `.github/workflows/ci.yml`, on pull requests to `dev` and `main`: Node 22, `npm ci`, lint,
    typecheck, build, `npm test`, `verify:docs`, `test:verification`, `verify:framework-version`, and
    the D1 integration suite;
  - `.github/workflows/databases.yml`, on pull requests and nightly: PostgreSQL 16 and MySQL 8 service
    containers running integration, conformance, race and crash suites;
  - `.github/workflows/nightly.yml`: coverage, mutation (Q5), benchmarks (Q6) and DF1 at release
    volume;
  - `.github/workflows/codeql.yml`;
  - `.github/dependabot.yml` for npm and GitHub Actions, weekly;
  - `.github/workflows/release.yml`, manual dispatch on `main`: `npm run release:publish` with
    `NPM_CONFIG_PROVENANCE=true` and the `NPM_TOKEN` secret.
- **Note:** pushing workflow files needs a token with the `workflow` scope. If the push is refused,
  hand the files to the maintainer.
- **Acceptance:** CI green on the pull request. Then the maintainer makes `ci` a required check on
  `dev` and `main`.

### Q2 Raise coverage floors

- [ ] Haiku per package. Branch `test/coverage-<package>`.
- **Steps:** list uncovered branches with `npm run test:coverage -w <pkg>`. Write targeted tests module
  by module until the gate is met, then raise the thresholds in the config. No test may assert only that
  code runs; each asserts an outcome.

## Wave 3: hardening and decisions

### C3 N-1 upgrade compatibility suite

- [ ] Sonnet. Branch `test/upgrade-compatibility`.
- **Steps:** in `packages/testing`, add dev dependencies aliasing the previous published release, for
  example `"xonava-core-prev": "npm:@xonava/core@0.1.0"` and `"xonava-adapters-prev":
  "npm:@xonava/adapters@0.1.0"`. In `packages/testing/integration/upgrade/`, test each pair of an old
  writer with a new reader and a new writer with an old reader on D1 (and PostgreSQL and MySQL when
  configured):
  - job fingerprints (`packages/core/src/execution/jobFingerprint.ts:15-84`);
  - list cursors (`packages/core/src/query/cursorCodec.ts`);
  - KV tag-generation layouts (`kvCacheAdapter.ts:25-34`);
  - workflow `resume_signal_id` receipts (`workflowDispatcher.ts:326-337`);
  - outbox and HTTP idempotency fingerprints (`drizzle-shared/outbox.ts:10`, `http/idempotency.ts:10`).

  Document in CONTRIBUTING that `release:version` must bump the alias to the release being replaced.
- **Acceptance:** the suite passes against `0.1.0` and becomes part of the release gate.

### C4 Soak testing

- [ ] Sonnet. Branch `test/soak`.
- **Steps:** add `npm run soak`, which runs the job, schedule and workflow dispatchers against D1 (and
  PostgreSQL and MySQL when configured) for `SOAK_MINUTES` (default 30). It uses short leases, random
  worker kills via the crash harness (`packages/testing/crash/processHarness.ts`) and random clock skew
  within lease tolerance. It checks:
  - no job runs twice concurrently;
  - every job reaches a terminal status;
  - no schedule occurrence is lost or duplicated;
  - workflow signals are consumed at most once.

  Write evidence like the crash suites.
- **Acceptance:** a 30-minute run passes; the nightly CI runs 10 minutes.

### C5 Threat model

- [ ] Opus drafts, Sonnet completes. Branch `docs/threat-model`.
- **Steps:** add a "Threat model" section to `docs/spec/security.md`:
  - assets: tenant data, policy bundles, idempotency receipts, audit and outbox;
  - adversaries: an unauthenticated client, an authenticated user of another tenant, a malicious
    tenant administrator, a compromised worker, and an operator with database access;
  - entry points: HTTP scope resolution, cursors, idempotency keys, policy authoring, job payloads and
    object keys.

  Map each threat to the requirement that addresses it and the test that proves it, and list residual
  risks. Every threat without a test becomes a new WP here.
- **Acceptance:** reviewed by Opus.

### C6 Decisions on items not implemented

- [ ] Opus. **Design gate.** For each item, record "build" with a new WP, or "out of scope" with the
  reason in the relevant spec file, then delete it from this list.
  - **Interactive transactions on D1.** Blocked by the platform. Expected: out of scope.
  - **Savepoints for nested operations.** Today nested operations join the parent transaction
    (`operationPipeline.ts:100-152`) and adapters reject nested transactions
    (`drizzle-pg/drizzlePersistenceProvider.ts:154`). Candidate: opt-in savepoints on PostgreSQL and
    MySQL.
  - **Bounded `COMMIT` on MySQL.** Expected: out of scope (server limitation).
  - **Query-time evaluation of conditional allow grants.** `collectQueryGrants`
    (`packages/core/src/domain/fieldAccess.ts:340`) ignores conditions. Candidate: compile the condition
    into the field-grant predicate.
  - **A code formatter.** Adopting one rewrites every file, so run it in a single dedicated pull request
    if accepted.
  - **Reference production DDL.** Candidate: publish the fixture migrations as
    `packages/adapters/migrations/<database>/` with a generator check.
  - **Persistence-applied codecs.** Rejected today at `packages/core/src/entity/validateEntity.ts:114`.
    Candidate: apply `durableCodec` in each adapter's `drizzleRepository.ts` row mapping.

## Repository settings (maintainer)

- [ ] Enable private vulnerability reporting.
- [ ] Fill the About description and topics.
- [ ] Decide whether `dev` becomes the default branch.
- [ ] After Q1 merges, require the `ci` check on `dev` and `main`.

## Release `0.2.0`

- [ ] When waves 0 and 1 are merged: run `npm run release:version` on `release/0.2.0`, verify that
  the published packages install and import in a clean project (with vitest installed for the testing
  package) and that the README examples type-check, then publish.

## Release `1.0.0`

- [ ] Every quality gate green in CI for two consecutive weeks.
- [ ] Every C6 item decided; full release gate (`npm run verify:framework-release`) green on dedicated
      databases.
- [ ] Freeze the public API manifest and durable formats; drop compatibility-only fingerprint versions
      that are no longer needed.
- [ ] Add a major changeset, run `RELEASE_MAJOR=1 npm run release:version` on `release/1.0.0`, update
      known limitations, and publish.
