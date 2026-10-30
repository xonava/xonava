# How releases are checked

A green unit and interface suite shows shape, not provider behaviour. A release is therefore checked against real PostgreSQL, MySQL and D1 (Miniflare) with the commands below. Nothing the checks produce is committed to the repository; see [release evidence](../governance.md#release-evidence).

## Everyday checks

- `npm run lint`, `npm run typecheck`, `npm run build` and `npm test` cover the three packages.
- `npm run verify` runs the fast repository checks, each also available on its own:
  - `verify:version`: the three packages share one version and pin each other exactly (see [versioning](../governance.md#versioning)), and each package exports exactly the approved public API in `docs/governance/public-api-manifest.json`.
  - `verify:docs`: documentation links and examples.
  - `verify:generated-surface`: the built output contains no removed directories or stale references.
  - `verify:architecture`: no import cycles, no orphaned modules, no removed legacy names, standalone bundles for the independent capabilities, and one canonical JSON implementation. `verify:ownership` rejects generic module owners such as `utils` or `misc`.
  - `verify:fixtures`: the test fixtures, the published migrations and the conformance vectors agree, and no consumer code leaks into the framework-owned fixtures.
  - `verify:core-purity`: `@xonava/core` stays dependency-free (no runtime package or Node imports, no Node globals, no dependencies).
  - `verify:hardening`: the repository-wide hardening rules.
- `npm run verify:isolation` runs the D1 integration, conformance, race and crash suites to show that the framework works without any consumer application. It is slow, so it is not part of `verify`.
- `npm run bench` compares hot-path benchmarks with `benchmarks/baseline.json`; `npm run bench:update-baseline` rewrites it after a reviewed change.
- `npm run test:verification` tests the verification scripts themselves.

## Database suites

Set `FRAMEWORK_TEST_PG_URL` and `FRAMEWORK_TEST_MYSQL_URL` for PostgreSQL and MySQL. D1 runs locally in Miniflare. For each database `<db>` (`pg`, `mysql`, `d1`):

- `npm run test:integration:<db>`: repository, transaction and store behaviour.
- `npm run test:conformance:<db>`: the guarantee suite (see [capabilities](../reference/capabilities.md)).
- `npm run test:race:<db>`: concurrent writers.
- `npm run test:upgrade:<db>`: upgrade from the previous published version.
- `npm run test:crash:<db>`: forced process termination at each failpoint, with a fresh verifier process. `FRAMEWORK_CRASH_REPETITIONS` sets the repetitions.
- `npm run soak` runs the 30-minute soak.

## The release check

`npm run verify:release` is the check a release must pass. It runs lint, build, `verify`, `verify:isolation`, the unit tests and core coverage, the integration, upgrade, conformance and race suites on all three databases, the differential suites at release volume, and every crash failpoint 20 times on every database. With `FRAMEWORK_RELEASE_SOAK=1` it also runs the soak.

It fails closed: it refuses to start without both database URLs, and after the suites it re-reads what they recorded and fails unless, for this run only, the guarantee and crash records of every database are present, proven and newer than the start of the run, the crash records show at least 20 repetitions of all six failpoints with no partial commit, the differential evidence is complete, the packages are in lockstep, and the sources did not change while it ran. It never searches for evidence from earlier runs, and it rejects a run ID whose directory already exists.

The run ID is `FRAMEWORK_CONFORMANCE_RUN_ID`, or `release-<timestamp>`. The check prints a summary and writes it to `.release-check/<run id>/summary.json`; the suites write their raw records to `artifacts/framework-conformance/<run id>/`. Both directories are git-ignored. Keep them with the release, as a CI artifact or a release attachment.

The check shows that the tested cases agree on the tested databases. It does not cover your production topology, custom adapters, untested remote D1 behaviour, application policy, or advisories for dependencies (it runs offline).

## Differential suites

The differential suites compare the predicate, authorization and encoding code, the HTTP handlers (fuzzed) and each SQL compiler, repository ordering and keyset pagination against the core evaluator. `npm run verify:differentials` runs them on its own; it needs both database URLs.

- **Seed.** A release run uses the seed derived from its run ID (SHA-256 of `framework-differential:<run id>`), so every release explores new cases and any run can be replayed. The release check removes `DIFFERENTIAL_SEED`, `DIFFERENTIAL_RUN`, `DIFFERENTIAL_SCALE` and `DIFFERENTIAL_REPORT_DIR` from the environment, and the runner refuses a fixed seed in a release run. A standalone run may set `DIFFERENTIAL_SEED` (unsigned 32-bit integer).
- **Volume.** `FRAMEWORK_DIFFERENTIAL_SCALE` multiplies the core case counts (default and release minimum 5). `FRAMEWORK_DIFFERENTIAL_DB_SCALE` multiplies the real-database case counts (default and release minimum 2).
- **Required properties.** Every `forAll` or `forAllAsync` call site in the suites is required, and each needs its own passing properties. Only bare named imports of those two functions, called directly with a string or template literal name, are accepted; a call site outside the suites is refused.
- **Baseline.** `scripts/verification/differentialBaseline.json` records every call site (`file::name`) and how many properties it expanded to. The runner refuses a site that disappeared or expands to fewer properties. After a reviewed addition or removal, run `node scripts/verification/differentials.mjs --update-baseline` (not allowed in a release run), review the diff, and run the check again.
- **Replaying a failure.** A failing property prints `Replay: DIFFERENTIAL_SEED=<seed> DIFFERENTIAL_RUN=<run>` together with the exact suite command. Prefix that command with the two variables to rerun only the failing case, for example `DIFFERENTIAL_SEED=<seed> DIFFERENTIAL_RUN=<run> npm run test -w @xonava/core -- src/__tests__/differential/predicateSemantics.differential.test.ts`. Without `DIFFERENTIAL_RUN`, the same seed and scale rerun the whole suite with identical cases.
- **Output.** A release run writes its reports under `.release-check/<run id>/differentials/`. A standalone run writes to `<os tmpdir>/framework-differential-<run id>`, or to `FRAMEWORK_DIFFERENTIAL_OUTPUT_DIR`, and never into the repository.

Differential testing is randomized: a pass shows that the explored cases agree, not that all inputs do. A later failure with a new seed is a defect to fix and replay, not a reason to doubt earlier runs.
