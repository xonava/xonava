# Contributing

This repository is a TypeScript npm workspace with three packages: `packages/core`, `packages/adapters`, and `packages/testing`. Before changing code, read the [architecture rules](docs/architecture/contributing.md). They define where code belongs and what it must not import.

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

It writes evidence under `artifacts/framework-conformance/`. That directory is tracked governance output; see [artifact retention](docs/governance/artifact-retention.md).

## Pull requests

- Public behavior changes need tests and applicable conformance coverage.
- Normative behavior belongs in [`docs/spec`](docs/spec/README.md), not only in code comments.
- Changes to public import paths need an API and version decision. See [compatibility and versioning](docs/governance/compatibility-and-versioning.md).
- Run `npm run verify:docs` after changing documentation.

## Security

Do not report vulnerabilities in public issues. Follow the [security policy](SECURITY.md).
