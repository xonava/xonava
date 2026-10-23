# Contributing

This repository is a TypeScript npm workspace with three packages: `packages/core`, `packages/adapters`, and `packages/testing`. Before changing code, read the [architecture rules](docs/architecture.md#contributor-rules). They define where code belongs and what it must not import.

## Prerequisites

- Node.js 22 or later.
- npm. The repository uses npm workspaces and commits `package-lock.json`.

## Setup

```sh
npm install
```

## Everyday checks

| Command | What it does |
| --- | --- |
| `npm run build` | Cleans generated output, builds every workspace, and verifies the generated surface |
| `npm run typecheck` | Type-checks every workspace |
| `npm run lint` | Lints every workspace with zero warnings allowed |
| `npm test` | Runs the unit suites of every workspace. It needs no database. |
| `npm run test:coverage -w @xonava/core` | Runs core unit tests with coverage thresholds |
| `npm run test:mutation` | Stryker mutation testing of core and adapters. Enforcing: exits non-zero below the gate (core 80 %, adapters 70 %). Expected to fail until the per-module mutation work lands, so it is not part of `npm test` or any verify script |
| `npm run verify:docs` | Checks documentation links, public import paths, and canonical references |
| `npm run bench` | Runs the hot-path benchmarks and fails when one is more than 25 % slower than `benchmarks/baseline.json`. Not part of `npm test`. |

There is no code formatter: ESLint enforces the rules that matter, and adopting a formatter would rewrite every file. Follow the style of the file you are editing.

Mutation testing runs one package at a time (`npm run test:mutation -w @xonava/core`) and mutates in place, so do not run two mutation runs, or edit `src/`, in the same checkout at the same time. To measure one module without enforcing the gate, run `XONAVA_MUTATION_BREAK=0 npm run test:mutation -w @xonava/core -- --mutate "src/query/**/*.ts,!src/**/__tests__/**"`. Results are cached in the gitignored `.stryker-tmp/incremental.json` and the JSON report is `.stryker-tmp/reports/mutation.json`. If a run is killed, `git checkout -- src` removes any leftover mutation.

Tests that depend on elapsed time scale their budgets and vitest timeouts by `XONAVA_TIMING_SCALE` (default 1, 4 under `--coverage`), so run tests on a loaded machine with `XONAVA_TIMING_SCALE=4`.

## Performance benchmarks

Hot-path benchmarks are vitest `bench` files: predicate evaluation, ABAC decisions, read-scope and query-budget compilation in `packages/core/src/__tests__/bench/`, SQL predicate and cursor compilation for every dialect in `packages/adapters/src/__tests__/bench/`, and a D1 (Miniflare) job claim in `packages/testing/bench/`. `npm run bench` runs them all and compares the median time of each benchmark with `benchmarks/baseline.json` (`scripts/verification/verifyBenchmarks.mjs`).

- The gate fails a benchmark more than 25 % slower than its baseline. A failing benchmark is measured once more and the faster median counts, so a noisy moment on a shared machine does not fail the gate.
- Baseline numbers depend on the machine. The baseline records its CPU and Node version, and `npm run bench` warns when they differ. On a different machine, or after an intentional performance change, run `npm run bench:update-baseline` (three runs, median of medians) and review the diff.
- Run benchmarks on an idle machine. `--threshold 0.4` loosens the gate for one run.

## Database test suites

The integration, conformance, race, and crash suites run against real databases. Use a disposable database for each. The fixtures create tables and delete rows, so do not point them at data you need.

PostgreSQL reads `FRAMEWORK_TEST_PG_URL`, falling back to `DATABASE_URL`:

```sh
export FRAMEWORK_TEST_PG_URL=postgres://user:password@localhost:5432/framework_test
npm run test:framework:integration:pg
npm run test:framework:upgrade:pg
npm run test:framework:conformance:pg
npm run test:framework:race:pg
npm run test:framework:crash:pg
```

MySQL reads `FRAMEWORK_TEST_MYSQL_URL`. The fixture creates the database named in the URL if it does not exist:

```sh
export FRAMEWORK_TEST_MYSQL_URL=mysql://user:password@localhost:3306/framework_test
npm run test:framework:integration:mysql
npm run test:framework:upgrade:mysql
npm run test:framework:conformance:mysql
npm run test:framework:race:mysql
npm run test:framework:crash:mysql
```

Cloudflare D1 runs locally with Miniflare and needs no URL:

```sh
npm run test:framework:integration:d1
npm run test:framework:upgrade:d1
npm run test:framework:conformance:d1
npm run test:framework:race:d1
npm run test:framework:crash:d1
```

## Soak testing

`npm run soak` runs the job, schedule and workflow dispatchers for `SOAK_MINUTES` (default 30) per database while worker processes are killed at random. It runs against D1 (local Miniflare) and, when `FRAMEWORK_TEST_PG_URL` and `FRAMEWORK_TEST_MYSQL_URL` are set, PostgreSQL and MySQL, one after the other. A database whose URL is not set is reported as not run. The soak is not part of `npm test`.

Each run gets a private database (a D1 instance, a `soak_*` PostgreSQL schema or a `framework_soak_*` MySQL database), so it can share a server with other suites. It starts `SOAK_WORKERS` worker processes (default 3) that dispatch jobs, materialize schedules and advance workflows with a 4 s lease and a clock offset by up to +-300 ms. The test process keeps adding jobs, workflow instances and signals, and every few seconds kills one worker (sometimes all but one) with `SIGKILL` and starts a replacement. After the load it stops the chaos, drains the system and checks, exactly:

- no job, partition or workflow instance is executed twice concurrently, and no attempt starts twice;
- every job reaches a terminal status, and attempts, handler runs, statuses and terminal history rows agree;
- no schedule occurrence is lost or duplicated: each schedule has exactly the minute occurrences from its first one up to the one before its `next_run_at`;
- every workflow instance reaches a terminal status, workflow signals are consumed at most once (a receipt resumes exactly one wait), and none is lost.

Any violation fails the run. Evidence is written to `artifacts/framework-conformance/<run>/soak/<adapter>-soak.json` with the counts (jobs, kills, terminal statuses, occurrences, signals) and durations; local runs are git-ignored. On D1 the database lives in the test process and the workers reach it over HTTP, as Workers reach the real service, because two processes cannot open one D1 database file.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SOAK_MINUTES` | `30` | Load duration per database (use `1` or `2` while developing). |
| `SOAK_ADAPTERS` | all configured | Comma list of `d1`, `pg`, `mysql`. Naming an adapter whose URL is missing is an error. |
| `SOAK_WORKERS` | `3` | Worker processes. |
| `SOAK_SEED` | random | Seed for the workload and the kill schedule (printed in the evidence). |
| `SOAK_LEASE_MS`, `SOAK_SKEW_MS` | `4000`, `300` | Lease length and the clock offset bound (at most a quarter of the lease). |
| `SOAK_KILL_MIN_MS`, `SOAK_KILL_MAX_MS` | `3000`, `9000` | Interval between kills. |
| `SOAK_SCHEDULES` | `6` | Every-minute schedules. |
| `SOAK_SLOW_FACTOR` | `0.7` | How long "slow" jobs work, as a multiple of the lease. They outlast several heartbeats and must stay below 1: the job timeout equals the lease, so a longer job is timed out and dead-lettered by design. |
| `SOAK_JOB_INTERVAL_MIN_MS`, `SOAK_JOB_INTERVAL_MAX_MS` | `300`, `1300` | Gap between enqueued jobs (about 1.2 jobs/s). |
| `SOAK_DRAIN_TIMEOUT_MS` | `180000` | How long the drain may take before the run fails. |

The defaults are chosen so the workers keep up with the producer on a shared four-core machine (the not-terminal backlog stays in the single digits to low tens); a drain that times out with pending jobs means the load was too high for the machine, so the run fails and the evidence records the backlog samples and the stuck jobs' lease rows. The heavier settings (`SOAK_SLOW_FACTOR=2.5`, a 100-700 ms job interval, about 2.5 jobs/s, with many jobs dead-lettered by timeout) were also run on D1 for 3 and for 30 minutes and drained in under two seconds with no violation, so the defaults are a choice of load and not a workaround for a stall. Unit tests in `packages/testing/tests/soakInvariants.test.ts` prove that every invariant checker reports a synthetic violation.

The soak is a `1.0.0` quality gate (see TODO.md). It is an optional step of `npm run verify:framework-release`: set `FRAMEWORK_RELEASE_SOAK=1` to run the full 30-minute soak on all three databases (about 1.5 hours) before the certification manifest is built; without it the release prints that the soak was skipped.

## Release gate

`npm run verify:framework-release` is the full release gate. Maintainers run it before a release. It requires both `FRAMEWORK_TEST_PG_URL` and `FRAMEWORK_TEST_MYSQL_URL`. It runs the baseline checks, the suites for all three database providers (including the N-1 upgrade compatibility suite), the differential suites at release volume, and the crash suites with 20 repetitions. It takes a long time and should run against dedicated databases.

It writes evidence under `artifacts/framework-conformance/`. That directory is tracked governance output; see [artifact retention](docs/governance.md#certification-artifact-retention).

## Branches

- `main` holds released, certified code. It only receives merges from `dev`.
- `dev` is the integration branch. Every change lands here first through a pull request.
- Work happens on short-lived branches cut from `dev`, named `<type>/<short-description>` in kebab case:
  `feat/` (new capability), `fix/` (bug fix), `docs/`, `test/`, `refactor/`, `perf/`, `chore/` (tooling,
  dependencies, repository housekeeping), and `release/<version>` when preparing a release. Example:
  `fix/mysql-schedule-retire`.
- External contributors fork the repository, create the working branch in their fork from `dev`, and open
  the pull request against `xonava/xonava`'s `dev` branch.
- Working branches are deleted automatically when their pull request merges.
- When `dev` is complete and passes the release gate above, a maintainer opens a pull request from `dev` to
  `main`.

Branch protection:

| Branch | Rules |
| --- | --- |
| `main` | Changes only through a pull request; no force pushes; cannot be deleted |
| `dev` | No force pushes; cannot be deleted |

## Pull requests

- Planned work is tracked only in [TODO.md](TODO.md). Remove an item in the pull request that completes it, and add new work there rather than in other documents.
- Target `dev`, not `main`. Only `dev` merges into `main`.
- Public behavior changes need tests and applicable conformance coverage.
- Normative behavior belongs in [`docs/spec`](docs/spec/README.md), not only in code comments.
- Changes to public import paths need an API and version decision. See [compatibility and versioning](docs/governance.md#compatibility-and-versioning).
- Run `npm run verify:docs` after changing documentation.

## Versioning and releases

The versioning policy is in [governance](docs/governance.md#versioning). Versions and the changelog are
managed with [Changesets](https://github.com/changesets/changesets).

**In a pull request.** If the change affects users of a published package, run `npm run changeset`, pick the
affected packages and the bump, and write a one- or two-sentence summary for the changelog. Commit the
generated file under `.changeset/`. While the version is `0.x`, choose `minor` for a breaking change and
start the summary with `**Breaking:**`; choose `patch` for everything else. Never choose `major` during
`0.x`. Changes that do not affect package users (tests, internal docs, tooling) need no changeset. Do not
edit package versions or `CHANGELOG.md` by hand.

**Cutting a release** (maintainers):

1. On a `release/<version>` branch from `dev`, run `npm run release:version`. It consumes the changesets,
   bumps all three packages to the same version, writes the `CHANGELOG.md` entry, and refreshes the lockfile.
2. Point the upgrade compatibility aliases at the release being replaced (see below), then run
   `npm run verify:framework-release`.
3. Open the pull request into `dev`, then merge `dev` into `main`.
4. From `main`, run `npm run release:publish`. It checks the version policy, builds, publishes the packages
   that are not yet on npm, and creates the git tags. Push the tags with `git push --follow-tags`.

**Upgrade compatibility alias.** The N-1 upgrade suite (`packages/testing/integration/upgrade/`) runs the previous
published release against the current code on the same databases: data written by one must be read by the other
(job, outbox and HTTP idempotency fingerprints, list cursors, KV tag-generation layouts, workflow
`resume_signal_id` receipts). The previous release is installed from npm under the aliases `xonava-core-prev` and
`xonava-adapters-prev` in the `devDependencies` of `packages/testing`, pinned to an exact version, for example
`"xonava-core-prev": "npm:@xonava/core@0.1.0"`. `release:version` must bump both aliases to the release being
replaced, that is the version the packages had before the bump, so a release candidate is always tested against what
users run today:

1. After `npm run release:version`, set both aliases in `packages/testing/package.json` to the previous version
   (`npm:@xonava/core@<previous>` and `npm:@xonava/adapters@<previous>`).
2. Run `npm install` to update `package-lock.json`, and check that `npm ci` still works.
3. Run the upgrade suites (`npm run test:framework:upgrade:d1`, `:pg`, `:mysql`). Where a format changed on purpose
   since that release, the suite asserts the documented behaviour (see
   [known limitations](docs/KNOWN-LIMITATIONS.md#rolling-deployment-order)); update those assertions together with the changeset that
   introduced the change, never by loosening a test.

The suite belongs to the release gate: `verify:framework-release:local` runs the D1 and database-free tests, and the
baseline runs PostgreSQL and MySQL.

## Security

Do not report vulnerabilities in public issues. Follow the [security policy](SECURITY.md).
