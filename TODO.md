# Plan

The working plan for Xonava. It lists what is left to do and in what order. It is not a promise of
dates. Finished items are removed; what shipped is recorded in the [changelog](CHANGELOG.md), and gaps
that users must know about today stay in [known limitations](docs/KNOWN-LIMITATIONS.md).

Status: **experimental**, `2.0.0-rc.2`. Target: core and adapters both at enterprise grade (9.5+)
before `2.0.0`.

Every item goes through the usual flow: a `<type>/<short-description>` branch cut from `dev`, a pull
request into `dev`, then `dev` into `main` (see [CONTRIBUTING.md](CONTRIBUTING.md#branches)).

## 1. First public release (`next` tag)

- [ ] Enable private vulnerability reporting in the repository security settings.
- [ ] Fill the repository About description and topics.
- [ ] Decide whether `dev` becomes the default branch.
- [ ] Publish the three packages: `npm login`, then `npm run build && npm publish --workspaces --tag next`.
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

## 4. Continuous integration

- [ ] GitHub Actions on pull requests: lint, typecheck, build, unit tests, `verify:docs`.
- [ ] Database jobs with PostgreSQL and MySQL service containers plus D1 (Miniflare): integration,
      conformance, race and crash suites.
- [ ] Required status checks on `dev` and `main` once the jobs are stable.
- [ ] Publish from CI with npm provenance.

## 5. Not implemented yet

Moved from known limitations. Each needs a design decision before work starts.

- [ ] Interactive transactions on D1 (blocked on the platform).
- [ ] Savepoints for nested operations.
- [ ] Bounded `COMMIT` on MySQL.
- [ ] Query-time evaluation of conditional allow-policy grants.
- [ ] A code formatter (style is enforced by lint only today).
- [ ] Reference production DDL (today only fixture migrations ship).
- [ ] Persistence-applied codecs, so custom fields with durable codecs can be accepted.
- [ ] `expiresAt` on list cursors.

## 6. `2.0.0`

- [ ] Sections 2 to 4 complete, and every item in section 5 either done or recorded as out of scope.
- [ ] Full release gate (`npm run verify:framework-release`) green on dedicated databases.
- [ ] Freeze the public API manifest and durable formats; drop compatibility-only fingerprint versions
      that are no longer needed.
- [ ] Update the changelog and known limitations, cut `release/2.0.0`, publish with the `latest` tag.
