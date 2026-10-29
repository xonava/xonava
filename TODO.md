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
| 2: proof | In progress | Done: everything except Q5 per module (`query` 86.2 %, `operation` 81.3 %, `workflow` 92.4 % and `domain` 86.8 % done); CI (Q1) deferred |
| 3: hardening and decisions | Done (C3–C9) | Soak (C4) runs with `npm run soak`, optional in the release gate via `FRAMEWORK_RELEASE_SOAK=1` |

Real-database differential suites now cover jobs, schedules, workflows, idempotency, inbox/outbox
delivery, leases, sequences, temporal history, job progress and cache tag generations on PostgreSQL,
MySQL and D1, and HTTP fuzz suites cover the CRUD and write handlers through Express, Fastify and Hono.
Writing them found and fixed 20 store and adapter defects; each fix shipped with its regression test and a
changeset. `dev` carries the pending changesets for `0.2.0`, including two required migrations
(`0005_job_scope_key`, `0006_byte_exact_identifiers` on MySQL).

**Merge rule learnt in wave 2:** before merging any change to adapter or store code, Opus runs the
complete PostgreSQL, MySQL and D1 integration suites on the branch merged with `dev`, not only the
files the subagent touched. Subagents share one database server, so they run only their own files.
Run D1 gates with no other agent loading the machine (see B8).

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
| Unit coverage, core | lines 96, branches 90 (met: 96.28 / 90.54, enforced) | Q2 |
| Unit coverage, adapters | lines 90, branches 82 (met: 94.5 / 85.9, enforced) | Q2 |
| Mutation score | core ≥ 80 %, adapters `http/` and `drizzle-shared/` ≥ 70 % (today 61–83 %, see Q5) | Q5 |
| Real-database differential suites | every durable store on PostgreSQL, MySQL and D1 (met) | A2–A8 |
| HTTP fuzzing | property suites over all CRUD and write handlers in DF1 (met) | Q4 |
| Performance | hot-path benchmarks within 25 % of the recorded baseline (met: `npm run bench`) | Q6 |
| Upgrade compatibility | N-1 suite against the previous published release (met: `test:framework:upgrade:*`, in the release gate) | C3 |
| Soak | 30-minute crash/lease soak with no invariant violation (met on D1, PostgreSQL and MySQL) | C4 |
| Threat model | reviewed `docs/spec/security.md` threat model (met) | C5 |

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

### Q5 Mutation testing, per module

- [ ] Haiku per module. Branch `test/mutation-<module>`. The setup is on `dev`: `npm run test:mutation -w
  <pkg> -- --mutate "<glob>"`, with `XONAVA_MUTATION_BREAK=0` to measure without failing. Mutation runs
  in place, so never run two in one checkout or edit `src/` meanwhile (see CONTRIBUTING).
- **Baseline** (only `query` ran in full; the rest are samples of files):

  | Module | Scope | Score |
  | --- | --- | --- |
  | core `query` | full | 86.2 % (done) |
  | core `domain` | full | 86.8 % (done) |
  | core `operation` | full | 81.3 % (done) |
  | core `execution` | full | 85.0 % (done; `types.ts` 68.0 % is the weakest file) |
  | core `workflow` | full | 92.4 % (done, no new tests needed) |
  | core `events` | full except `auditRedaction.ts` | 92.0 % (done) |
  | core `entity` | full | 93.0 % (done) |
  | adapters `http` | full | 89.7 % (done; `scopeResolution.ts` 96.1 %, `trustedClientIp.ts` 90.7 %) |
  | adapters `drizzle-shared` | full | 88.1 % (done) |
  | core `security` | full | 94.9 % (done; added after the plan) |
  | core `serialization` | full | 93.4 % (done; added after the plan) |
  | adapters `drizzle-pg` | full | 97.3 % (done; added after the plan) |
  | adapters `drizzle-mysql` | full | 95.0 % (done; added after the plan; found and fixed the all-row guard bug) |
  | adapters `drizzle-d1` | full | 96.2 % (done; added after the plan; 76.3 % baseline, no bug found) |

- **Per module** (`domain`, `query`, `operation`, `execution`, `workflow`, `events`, `entity`, then
  adapters `http` and `drizzle-shared`): measure the whole module first, then for each surviving mutant
  add a test that kills it, or mark it equivalent with a one-line reason in `stryker-equivalent.md` next
  to the config. Stop when the module meets the gate.
- `events/durability/auditRedaction.ts` cannot be mutated yet: its 60 000-string and 200 kB linear-time
  tests time out under instrumentation. Give those tests a lighter variant under mutation first.
- **Acceptance:** `npm run test:mutation` exits 0 for core (≥ 80 %) and adapters (≥ 70 %).

## Wave 3: hardening and decisions

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

## Release `0.3.0`: repository clean-up

- [ ] After 0.2.0: follow `CLEANUP.md` (remove work tracking, run evidence, ID-named certification gates,
      compatibility code and work-item references). That change also deletes this file and `CLEANUP.md`.

- [ ] List row counts (breaking, `0.3.0` minor; do it before the clean-up deletes this file). Every `findMany`
      runs `SELECT COUNT(*) … WHERE <filter>` and then the page query, one after the other.
      - **Core** (`packages/core/src/query/queryPlan.ts`): `ListResult.rowCount` is required and `QueryOptions` has
        no way to skip the total, so every adapter must count. Make the total optional (for example an
        `includeTotal` option on offset pagination) and say that cursor pages carry `hasNextPage`/`hasPreviousPage`,
        not a total.
      - **Adapters** (`drizzle-pg/drizzleRepository.ts:271`, `drizzle-mysql/drizzleRepository.ts:41`,
        `drizzle-d1/drizzleRepository.ts:239`): the count scans every matching row on every page, cursor pages
        included; on cursor pages it counts only the rows past the cursor (the cursor predicate is in the count's
        WHERE), so `rowCount` shrinks while paging; and the two queries run in separate statements, so they can
        disagree under concurrent writes. Skip the count for cursor pages and when no total is asked for.
      - **Adapters, HTTP** (`http/crudHandlers/list.ts:276`): the `maxCount` limit is checked only after both
        queries ran. Use a bounded count (`SELECT 1 … LIMIT maxCount + 1`) before the page query.
      - Tests: all three repositories plus the PostgreSQL, MySQL and D1 integration suites; the repository
        contract in `@xonava/testing` gets cases for an absent total and for cursor pages.

## Release `1.0.0` (not planned yet)

- [ ] Not before the clean-up. Freezing the public API manifest and durable formats and the major changeset are
      decided later; the compatibility fingerprints are already removed in 0.3.0.
