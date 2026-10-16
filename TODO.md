# Plan

This file is the single place where remaining work is tracked. No other document, issue list, or
report keeps its own to-do list; they link here instead.

- **Adding work:** add an unchecked item to the right section. An accepted bug report or feature
  request becomes an item here, with a link to its issue.
- **Finishing work:** remove the item in the pull request that completes it. What shipped is recorded
  in the [changelog](CHANGELOG.md).
- **Other documents:** [known limitations](docs/KNOWN-LIMITATIONS.md) describes how the current release
  behaves, not what will change. It does not list planned work.

Status: **experimental**, `0.x` series. Targets before `1.0.0`: core at 9.5+, adapters at 9+.

Every item goes through the usual flow: a `<type>/<short-description>` branch cut from `dev`, a pull
request into `dev`, then `dev` into `main` (see [CONTRIBUTING.md](CONTRIBUTING.md#branches)).

## 1. First public release (`0.1.0`)

- [ ] Enable private vulnerability reporting in the repository security settings.
- [ ] Fill the repository About description and topics.
- [ ] Decide whether `dev` becomes the default branch.
- [ ] Publish `0.1.0`: date its changelog heading, `npm login`, then `npm run release:publish`.
- [ ] Smoke-test the published packages in a clean project (all entry points import; README examples
      type-check under NodeNext and Bundler).

## 2. Standalone applications (platform scope)

Platform-scoped entities (`entityScope: { kind: "platform", acknowledged: true }`) work but are covered
only by unit tests. Tenant scope is the only path proven against real databases.

- [ ] Integration suite for platform-scoped CRUD, list, query and OCC on PostgreSQL, MySQL and D1.
- [ ] HTTP routes with a fixed `platform` scope plan, end to end.
- [ ] Jobs, schedules and workflows under `platform` and `system` scope against real databases.
- [ ] Guide: "Standalone application" in `docs/guides/`, with a type-checked example.
- [ ] README: a short standalone example next to the tenant quick start.

## 3. Adapters to 9+

- [ ] MySQL inbox store and lease store (PostgreSQL and D1 have them), or document their absence.
- [ ] Real-database differential suites for the stores that have none yet: idempotency, outbox, inbox,
      lease, sequence, audit, temporal history, job progress, cache tag generations.
- [ ] HTTP adapter fuzzing (Express, Fastify, Hono): malformed bodies, headers, cursors, scopes.
- [ ] Mutation testing on core and adapters; raise weak suites.
- [ ] Independent review of adapters, then fix and re-certify.

## 4. Core to 9.5+

- [ ] Performance baselines for the hot paths (predicate compilation, ABAC evaluation, query planning,
      job claim), with a regression check in CI.
- [ ] Upgrade tests: an old node and a new node on one database, covering the rolling-deploy rules in
      known limitations (job fingerprints, list cursors, cache counter layouts, workflow signal receipts).
- [ ] Threat model for scope resolution, ABAC and the HTTP boundary, recorded in `docs/spec/security.md`.
- [ ] Dependency and code scanning in CI.
- [ ] Soak tests: long runs of jobs, schedules and workflows under lease expiry and process restarts.
- [ ] A decision on each item in section 6: implement it, or mark it out of scope in the spec with the
      reason.
- [ ] Feed defects found in pilot applications back into this file.

## 5. Continuous integration

- [ ] GitHub Actions on pull requests: lint, typecheck, build, unit tests, `verify:docs`.
- [ ] Database jobs with PostgreSQL and MySQL service containers plus D1 (Miniflare): integration,
      conformance, race and crash suites.
- [ ] Required status checks on `dev` and `main` once the jobs are stable.
- [ ] Publish from CI with npm provenance.

## 6. Not implemented yet

Each needs a design decision before work starts.

- [ ] Interactive transactions on D1 (blocked on the platform).
- [ ] Savepoints for nested operations.
- [ ] Bounded `COMMIT` on MySQL.
- [ ] Query-time evaluation of conditional allow-policy grants.
- [ ] A code formatter (style is enforced by lint only today).
- [ ] Reference production DDL (today only fixture migrations ship).
- [ ] Persistence-applied codecs, so custom fields with durable codecs can be accepted.
- [ ] `expiresAt` on list cursors.

## 7. `1.0.0`

- [ ] Sections 2 to 5 complete, and every item in section 6 either done or recorded as out of scope.
- [ ] Full release gate (`npm run verify:framework-release`) green on dedicated databases.
- [ ] Freeze the public API manifest and durable formats; drop compatibility-only fingerprint versions
      that are no longer needed.
- [ ] Add a major changeset, run `RELEASE_MAJOR=1 npm run release:version` on a `release/1.0.0` branch, update known
      limitations, and publish.
