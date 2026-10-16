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
| `npm run verify:docs` | Checks documentation links, public import paths, and canonical references |

## Database test suites

The integration, conformance, race, and crash suites run against real databases. Use a disposable database for each. The fixtures create tables and delete rows, so do not point them at data you need.

PostgreSQL reads `FRAMEWORK_TEST_PG_URL`, falling back to `DATABASE_URL`:

```sh
export FRAMEWORK_TEST_PG_URL=postgres://user:password@localhost:5432/framework_test
npm run test:framework:integration:pg
npm run test:framework:conformance:pg
npm run test:framework:race:pg
npm run test:framework:crash:pg
```

MySQL reads `FRAMEWORK_TEST_MYSQL_URL`. The fixture creates the database named in the URL if it does not exist:

```sh
export FRAMEWORK_TEST_MYSQL_URL=mysql://user:password@localhost:3306/framework_test
npm run test:framework:integration:mysql
npm run test:framework:conformance:mysql
npm run test:framework:race:mysql
npm run test:framework:crash:mysql
```

Cloudflare D1 runs locally with Miniflare and needs no URL:

```sh
npm run test:framework:integration:d1
npm run test:framework:conformance:d1
npm run test:framework:race:d1
npm run test:framework:crash:d1
```

## Release gate

`npm run verify:framework-release` is the full release gate. Maintainers run it before a release. It requires both `FRAMEWORK_TEST_PG_URL` and `FRAMEWORK_TEST_MYSQL_URL`. It runs the baseline checks, the suites for all three database providers, the differential suites at release volume, and the crash suites with 20 repetitions. It takes a long time and should run against dedicated databases.

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
2. Open the pull request into `dev`, then merge `dev` into `main`.
3. From `main`, run `npm run release:publish`. It checks the version policy, builds, publishes the packages
   that are not yet on npm, and creates the git tags. Push the tags with `git push --follow-tags`.

## Security

Do not report vulnerabilities in public issues. Follow the [security policy](SECURITY.md).
