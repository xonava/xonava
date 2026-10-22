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
| 2: proof | In progress | Done: everything except Q5 per module (`query` 86.2 % and `operation` 81.3 % done); CI (Q1) deferred |
| 3: hardening and decisions | In progress | Done: C3, C5, C6, C7, C9. In flight: C4 soak, C8 conditional query grants |

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
| Soak | 30-minute crash/lease soak with no invariant violation | C4 |
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
  | core `domain` | 3 of 31 files | 62.6 % |
  | core `operation` | full | 81.3 % (done) |
  | core `execution` | `dispatcher.ts` only | 65.4 % |
  | core `workflow` | 3 of 10 | 82.9 % |
  | core `events` | 10 of 15 | 75.7 % |
  | core `entity` | 5 of 12 | 67.5 % |
  | adapters `http` | 3 of 22 | 73.6 % |
  | adapters `drizzle-shared` | 5 of 14 | 68.0 % |

- **Per module** (`domain`, `query`, `operation`, `execution`, `workflow`, `events`, `entity`, then
  adapters `http` and `drizzle-shared`): measure the whole module first, then for each surviving mutant
  add a test that kills it, or mark it equivalent with a one-line reason in `stryker-equivalent.md` next
  to the config. Stop when the module meets the gate.
- `events/durability/auditRedaction.ts` cannot be mutated yet: its 60 000-string and 200 kB linear-time
  tests time out under instrumentation. Give those tests a lighter variant under mutation first.
- **Acceptance:** `npm run test:mutation` exits 0 for core (≥ 80 %) and adapters (≥ 70 %).

## Wave 3: hardening and decisions

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

### C8 Conditional allow policies stop granting query access

- [ ] Sonnet. Branch `fix/conditional-query-grants`. **Breaking.** Decided in C6.
- **Defect:** `collectQueryGrants` (`packages/core/src/domain/fieldAccess.ts`) takes `fieldAccess.query` from every allow
  policy without looking at its condition. An allow policy whose condition can never hold for the caller (for example
  `department = 'x'`) still lifts a mask's query denial, so the caller can filter, sort and search a masked field over
  every row, which reveals its values. This contradicts the rule in `docs/spec/domain.md` that a record-less decision
  is granted only by an unconditional allow.
- **Fix:** a query grant counts only when the policy's `compiledConditions` is always true (the same test the global
  capability decision uses). Update `docs/spec/domain.md` with a MUST sentence, remove the entry from
  `docs/KNOWN-LIMITATIONS.md`, and add a `minor` changeset starting with **Breaking:** that tells users to move such
  grants to an unconditional policy. Compiling the condition into a query predicate is out of scope for `1.0`.
- **Acceptance:** unit tests in `fieldAccess.test.ts` for a statically false, a resource-dependent and an always-true
  condition; an ABAC differential property that a query grant never lifts a denial the record decision would keep for
  some row; an HTTP test (`list` with a filter on the masked field) that now answers 403.


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
- [ ] Full release gate (`npm run verify:framework-release`) green on dedicated
      databases.
- [ ] Freeze the public API manifest and durable formats; drop compatibility-only fingerprint versions
      that are no longer needed.
- [ ] Add a major changeset, run `RELEASE_MAJOR=1 npm run release:version` on `release/1.0.0`, update
      known limitations, and publish.
