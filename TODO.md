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

## Progress

| Wave | State | Notes |
| --- | --- | --- |
| 0: quick fixes | Done (6 of 6) | |
| 1: pilot feedback and missing adapters | Done (9 of 9, plus 3 follow-ups) | All eight requests from the TanStack Start / Cloudflare pilot |
| 2: proof | In progress (8 of 13, plus 6 follow-ups) | Remaining: A8, Q2, Q4, Q5, Q6, and the wave close below; CI (Q1) deferred |
| 3: hardening and decisions | Not started (0 of 4) | |

Real-database differential suites now cover jobs, schedules, workflows, idempotency, inbox/outbox
delivery, leases, sequences, temporal history and job progress on PostgreSQL, MySQL and D1. Writing
them found and fixed 16 store and adapter defects; each fix shipped with its regression test and a
changeset. `dev` carries the pending changesets for `0.2.0`, including two required migrations
(`0005_job_scope_key`, `0006_byte_exact_identifiers` on MySQL).

**Merge rule learnt in wave 2:** before merging any change to adapter or store code, Opus runs the
complete PostgreSQL, MySQL and D1 integration suites on the branch merged with `dev`, not only the
files the subagent touched. Subagents share one database server, so they run only their own files.

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

`1.0.0` ships when every gate is green. Until CI exists (deferred, see below), the gates run locally through
the release gate and the named scripts. Each gate is created by the WP named after it.

| Gate | Target | Created by |
| --- | --- | --- |
| Unit coverage, core | lines 96, branches 90 (today 94 / 86) | Q2 |
| Unit coverage, adapters | lines 90, branches 82 (today 76 / 61) | Q2 |
| Mutation score | core ≥ 80 %, adapters `http/` and `drizzle-shared/` ≥ 70 % | Q5 |
| Real-database differential suites | every durable store on PostgreSQL, MySQL and D1 (all but cache tag generations done) | A8 |
| HTTP fuzzing | property suites over all CRUD and write handlers in DF1 | Q4 |
| Performance | hot-path benchmarks within 25 % of the recorded baseline | Q6 |
| Upgrade compatibility | N-1 suite against the previous published release | C3 |
| Soak | 30-minute crash/lease soak with no invariant violation | C4 |
| Threat model | reviewed `docs/spec/security.md` threat model | C5 |

## Wave 2: proof (Sonnet, parallel)

Every store differential follows the job-store pattern exactly:
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

### A8 Cache tag-generation differential

- [ ] Sonnet. Branch `test/tag-generation-differential`. Area `tagGeneration`.
- **Model:** advance and read tag generations through `dbTagGenerationStore.ts` and
  `mysqlTagGenerationStore.ts` under concurrent invalidation. Include the KV adapter's dual-layout
  reads (`kvCacheAdapter.ts:276-319`) against a fake KV namespace.

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
- **Acceptance:** gate thresholds in the quality table, enforced by `npm run test:mutation` with a
  failing exit code below threshold.

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

### Q2 Raise coverage floors

- [ ] Haiku per package. Branch `test/coverage-<package>`.
- **Steps:** list uncovered branches with `npm run test:coverage -w <pkg>`. Write targeted tests module
  by module until the gate is met, then raise the thresholds in the config. No test may assert only that
  code runs; each asserts an outcome.

### W2-close Close wave 2

- [ ] Opus. When A8 is merged: regenerate `scripts/verification/differentialBaseline.json` with
  `npm run verify:framework:df1 -- --update-baseline` against PostgreSQL and MySQL, review the diff, run
  the full release gate locally (`npm run verify:framework-release`), and update this file.

### B7 Follow-ups found in wave 2

Small items found by the wave 2 suites and reviews. Each is one Haiku or Sonnet package.

- [ ] Haiku. `FencedLeaseStore.acquire` and `renew` (`packages/adapters/src/drizzle-shared/fencedLeaseStore.ts`)
  throw synchronously on an invalid owner or duration; make them reject asynchronously like every other
  store method, and tighten the lease differential to expect a rejected promise.
- [ ] Haiku. `validateJobProgress` rejects an out-of-range integer in a checkpoint with a canonical-JSON
  error instead of `ConfigurationError`; map it, and add `-0` percent and a `\u0000` checkpoint string
  (PostgreSQL `jsonb`) to the job-progress differential.
- [ ] Haiku. Document in known limitations that concurrent first allocations of one MySQL sequence key
  can deadlock (InnoDB 1213) when a holder rolls back, so callers must retry the transaction; committed
  numbers stay gapless.
- [ ] Sonnet, **design gate**. Custom `projectCommittedResult` hooks receive a fresh-connection
  persistence, so on PostgreSQL and MySQL they cannot see the row the operation just wrote (built-in
  CRUD was fixed in B6). Decide whether hooks get the transaction-bound persistence or the limitation is
  documented.
- [ ] Opus, input to C5. For platform-scope routes, module entitlements (`enabledModuleKeys`, actions,
  capabilities) are not consulted; ABAC is the only authorization input. Confirm in the threat model.

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
- **Acceptance:** a 30-minute run passes.

### C5 Threat model

- [ ] Opus drafts, Sonnet completes. Branch `docs/threat-model`.
- **Steps:** add a "Threat model" section to `docs/spec/security.md`:
  - assets: tenant data, policy bundles, idempotency receipts, audit and outbox;
  - adversaries: an unauthenticated client, an authenticated user of another tenant, a malicious
    tenant administrator, a compromised worker, and an operator with database access;
  - entry points: HTTP scope resolution, cursors, idempotency keys, policy authoring, job payloads and
    object keys.

  Map each threat to the requirement that addresses it and the test that proves it, and list residual
  risks. Known inputs: write handlers parse the request body (bounded at 1 MiB by default) before CSRF,
  session and authorization checks (`docs/typescript/http-adapters.md`, method and body matrix). Every threat without a test becomes a new WP here.
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

## Deferred

Work the maintainer has postponed. It is not part of the current waves or the `1.0.0` gate until moved
back.

### Q1 Continuous integration (deferred)

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


## Repository settings (maintainer)

- [ ] Enable private vulnerability reporting.
- [ ] Fill the About description and topics.
- [ ] Decide whether `dev` becomes the default branch.

## Release `0.2.0`

- [ ] Maintainer decides when. Waves 0 and 1 and most of wave 2 are on `dev`. Promote `dev` to `main`,
  run `npm run release:version` on `release/0.2.0`, verify that the published packages install and
  import in a clean project (with vitest installed for the testing package) and that the README
  examples type-check, then publish. The release notes must call out the breaking changes listed in the
  changesets and the two required migrations (`0005_job_scope_key`, MySQL `0006_byte_exact_identifiers`).

## Release `1.0.0`

- [ ] Every quality gate green in the full local release gate on dedicated databases.
- [ ] Every C6 item decided; full release gate (`npm run verify:framework-release`) green on dedicated
      databases.
- [ ] Freeze the public API manifest and durable formats; drop compatibility-only fingerprint versions
      that are no longer needed.
- [ ] Add a major changeset, run `RELEASE_MAJOR=1 npm run release:version` on `release/1.0.0`, update
      known limitations, and publish.
