# Xonava

**A TypeScript server framework built from a language-neutral specification, with PostgreSQL, MySQL and Cloudflare D1 behaving the same way.**

[![npm](https://img.shields.io/npm/v/@xonava/core?label=%40xonava%2Fcore)](https://www.npmjs.com/package/@xonava/core)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node >=22](https://img.shields.io/badge/node-%3E%3D22-339933)](https://nodejs.org)
[![status: experimental](https://img.shields.io/badge/status-experimental-orange)](docs/KNOWN-LIMITATIONS.md)

Xonava gives backend services the parts that are tedious to get right: entities with tenant scoping and optimistic concurrency, authorization enforced inside queries, transactions, transactional outbox and inbox events, durable jobs, schedules and workflows, caching, rate limiting and resilience. Each capability is a separate subpath of `@xonava/core`, which has no runtime dependencies, so you import only what you use and add the rest later. Reference adapters connect the contracts to PostgreSQL, MySQL, Cloudflare D1, Express, Fastify and Hono. The packages are native ES modules and require Node.js 22 or later.

> **Experimental.** This is the `2.0.0-rc.2` release candidate. APIs, persistence schemas and wire formats may change before `2.0.0`, and the repository ships no production DDL. Read [Known limitations](docs/KNOWN-LIMITATIONS.md) before adopting it.

## Why Xonava

- **Use one capability or all of them.** `@xonava/core` has zero runtime dependencies. Capabilities live on subpaths such as `@xonava/core/cache` and `@xonava/core/workflow`, need no global container or import-time registration, and tree-shake independently. The root export is deliberately small.
- **Specification first.** Semantics are written in a [language-neutral specification](docs/spec/README.md) with a separate [TypeScript profile](docs/typescript/README.md). When prose and behavior disagree, the disagreement is treated as a defect.
- **The same behavior on three databases.** PostgreSQL, MySQL 8 and Cloudflare D1 are covered by integration, conformance, race and crash/replay suites. Differential suites compare each adapter's SQL compilation, ordering and keyset pagination with core's reference evaluator. Intentional differences, such as D1 having no interactive transactions, are [documented](docs/KNOWN-LIMITATIONS.md).
- **Authorization inside the query.** ABAC policies compile into query predicates and field allowlists, so fields a caller cannot read are also not filterable, sortable or searchable. Writes are checked against the pre-image and the post-image.
- **Durable side effects.** Events are appended to a transactional outbox in the business transaction. Consumers use an inbox and fenced claims. Jobs, schedules and workflows are stored in your database, with bounded retries, leases, durable timers and idempotent, buffered signals. Exactly-once delivery to external systems is not assumed.
- **Operations with explicit guarantees.** An operation declares its kind, validation, authorization, atomicity and budget. Optimistic concurrency, idempotency keys and audit records are part of the contract rather than conventions.
- **Resilience primitives.** Rate limiting, quota contracts, jittered and abortable retry, a circuit breaker and a bulkhead.
- **Bring your own HTTP framework.** Handlers are Fetch-based. Thin bindings mount them on Express 5, Fastify 5 or Hono 4 without changing authorization, validation or concurrency behavior.

## Install

Requires Node.js 22 or later.

```sh
# Core contracts and semantics only
npm install @xonava/core

# PostgreSQL
npm install @xonava/core @xonava/adapters drizzle-orm pg

# MySQL 8
npm install @xonava/core @xonava/adapters drizzle-orm mysql2

# Cloudflare D1 (the D1 binding comes from the Workers runtime)
npm install @xonava/core @xonava/adapters drizzle-orm

# HTTP framework bindings: install the one you use
npm install hono          # or: fastify, or: express @types/express

# Conformance suites for your own adapters or tests
npm install -D @xonava/testing vitest
```

`drizzle-orm` is a required peer dependency of `@xonava/adapters`. `pg`, `mysql2`, `express`, `fastify`, `hono` and the matching `@types` packages are optional peers: install only the ones you use.

## Quick start

This defines a tenant-scoped entity, backs it with PostgreSQL, and serves list, detail, create, update and delete routes with Hono. It uses the PostgreSQL install above plus `npm install hono zod`; entity schemas are written with [Zod](https://zod.dev). The table must exist; the repository ships no production DDL, and the reference schema is in the fixture migrations under `packages/testing/fixtures/`.

**1. Define the entity.** Routes that update or delete require a version field, which provides optimistic concurrency.

```ts
import { z } from "zod";
import { defineEntity } from "@xonava/core/entity";

type Project = { id: string; tenantId: string; name: string; version: number };

const body = z.object({ name: z.string().min(1) });

export const projects = defineEntity<Project, z.infer<typeof body>, z.infer<typeof body>>({
  moduleKey: "tenant.projects",
  entity: {
    name: "project",
    primaryKey: "id",
    tenantField: "tenantId",
    versionField: "version",
    fields: {
      id: { type: "string" },
      tenantId: { type: "string" },
      name: { type: "string" },
      version: { type: "number" },
    },
  },
  entityScope: { kind: "tenant" },
  policy: { customCapabilityKey: "projects" },
  validation: { createBody: body, updateBody: body, idParams: z.object({ id: z.string() }) },
});
```

**2. Create a persistence provider.**

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { DrizzleEntityRegistry, createDrizzlePersistenceProvider } from "@xonava/adapters/drizzle-pg";
import { projects } from "./entity.js";

const projectTable = pgTable("projects", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
  version: integer("version").notNull(),
});

const registry = new DrizzleEntityRegistry().register(projects, projectTable, {
  id: projectTable.id,
  tenantId: projectTable.tenantId,
  name: projectTable.name,
  version: projectTable.version,
});

const db = drizzle(new Pool({ connectionString: process.env.DATABASE_URL }));
export const persistence = createDrizzlePersistenceProvider({ db, registry });
```

**3. Mount the routes.**

```ts
import { Hono } from "hono";
import { CRUD, type CrudRuntime } from "@xonava/adapters/http";
import { createHonoCrudApp } from "@xonava/adapters/hono";
import { projects } from "./entity.js";
import { persistence } from "./persistence.js";

// Trusted-boundary wiring you own: session and scope resolution, CSRF, ABAC bundles, cache.
declare const rest: Omit<CrudRuntime, "createPersistence">;

const handlers = CRUD(projects, { ...rest, createPersistence: () => persistence });

const app = new Hono();
app.route("/projects", createHonoCrudApp(handlers));

export default app;
```

`rest` is the part Xonava deliberately does not guess: who the caller is, which tenant they act for, and which policies apply. See [HTTP framework adapters](docs/typescript/http-adapters.md) for the runtime contract, and the same page for Fastify and Express.

**Capabilities also work alone.** Each one takes the implementation it needs as an argument:

```ts
import { CacheService, type CacheAdapter } from "@xonava/core/cache";
import { checkRateLimit, type AtomicRateLimitStore } from "@xonava/core/rate-limit";

declare const adapter: CacheAdapter;
declare const store: AtomicRateLimitStore;

const cache = new CacheService({ adapter, defaultTtlMs: 30_000 });
await cache.set("account:42", { enabled: true });
const account = await cache.get<{ enabled: boolean }>("account:42");

const decision = await checkRateLimit({ store, key: "tenant:t1:user:u1", limit: 100, windowMs: 60_000 });
```

For custom business logic, declare an operation with `createOperation` and run it with `runOperation`; see [create an operation](docs/guides/create-an-operation.md).

## Packages

| Package | Contents |
| --- | --- |
| [`@xonava/core`](https://www.npmjs.com/package/@xonava/core) ([README](packages/core/README.md)) | Capability contracts and semantics. No runtime dependencies. |
| [`@xonava/adapters`](https://www.npmjs.com/package/@xonava/adapters) ([README](packages/adapters/README.md)) | PostgreSQL, MySQL and D1 persistence through Drizzle, Express, Fastify and Hono bindings, cache and object storage. |
| [`@xonava/testing`](https://www.npmjs.com/package/@xonava/testing) ([README](packages/testing/README.md)) | Contract and conformance suites for repositories, persistence providers, caches, predicates and ABAC. |

## Capabilities

Every row is an import path of `@xonava/core`. The [export reference](docs/reference/package-exports.md) lists the full surface, and the [capability catalog](docs/reference/capabilities.md) maps each one to its specification and certification suite.

| Area | Subpaths |
| --- | --- |
| Domain, entities, queries, persistence | `domain` (errors, principals, predicates, ABAC), `entity` (definitions, scope, lifecycle), `query` (plans, budgets, cursors, search), `persistence` (providers, repositories, bulk and streaming) |
| Operations, transactions | `operation` (operations, services, budgets, deadlines), `aggregate` (consistency boundaries across entities) |
| Events, execution | `events` (outbox, inbox, audit, idempotency, leases), `workflow` (state machine, timers, signals, compensation), `execution` (jobs and schedules) |
| Protection | `cache`, `rate-limit`, `resilience` (retry, circuit breaker, bulkhead), `quota` |
| Security, operations support | `security` (scope resolution, authorized plans), `secrets`, `feature-flags`, `health`, `telemetry` |
| Data and time | `temporal` (revisions, point-in-time), `sequence` (scoped numbering), `business-calendar`, `serialization` (canonical JSON, codecs), `storage` and `object-store` (attachments, objects) |
| Modeling and wiring | `rules` (versioned, effective-dated), `read-model`, `bootstrap` (readiness and runtime plan), `kernel` (validation, clocks) |

## Supported backends

| Kind | Supported | Import |
| --- | --- | --- |
| Database | PostgreSQL | `@xonava/adapters/drizzle-pg` |
| Database | MySQL 8 | `@xonava/adapters/drizzle-mysql` |
| Database | Cloudflare D1 | `@xonava/adapters/drizzle-d1` |
| HTTP framework | Express 5 | `@xonava/adapters/express` |
| HTTP framework | Fastify 5 | `@xonava/adapters/fastify` |
| HTTP framework | Hono 4 | `@xonava/adapters/hono` |
| Cache, storage | Reference adapters | `@xonava/adapters/cache`, `@xonava/adapters/storage` |

Typechecking an adapter does not show that it meets the contract. Behavior is checked by the suites in [`@xonava/testing`](packages/testing/README.md); see [persistence setup](docs/guides/persistence-setup.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [Documentation index](docs/README.md)
- [Getting started](docs/guides/getting-started.md) and [using capabilities independently](docs/guides/independent-capabilities.md)
- [Architecture overview](docs/architecture/overview.md) and [principles](docs/architecture/principles.md)
- [Specification](docs/spec/README.md) and [TypeScript profile](docs/typescript/README.md)
- Guides: [persistence setup](docs/guides/persistence-setup.md), [events, jobs and workflows](docs/guides/events-and-workflows.md), [create an operation](docs/guides/create-an-operation.md), [transactions and OCC](docs/guides/transactions-and-occ.md), [understanding errors](docs/guides/understanding-errors.md)
- Reference: [public exports](docs/reference/package-exports.md), [capability catalog](docs/reference/capabilities.md), [certification matrix](docs/reference/certification-matrix.md)
- [Compatibility and versioning policy](docs/governance/compatibility-and-versioning.md)

## Project status

Xonava is experimental. The `2.0.0-rc.2` release candidate has passed its core, API and architecture gates and the PostgreSQL, MySQL and D1 integration, conformance, race and crash/replay suites. That evidence comes from local multi-backend runs and does not cover your production topology, custom adapters or your own policies; see the [certification matrix](docs/reference/certification-matrix.md).

Before deploying, read [Known limitations](docs/KNOWN-LIMITATIONS.md). It lists required database migrations, the MySQL UTC session requirement, accepted differences between databases, and what is not implemented: interactive transactions on D1, savepoints for nested operations, and a bounded `COMMIT` on MySQL. Notable changes are in the [changelog](CHANGELOG.md). Until `2.0.0`, pin exact versions.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the build and test commands, and the database suites, and the [architecture rules](docs/architecture/contributing.md) for where code belongs. Branch from `dev` and open pull requests against `dev`, not `main`. Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Report vulnerabilities privately, not in public issues. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Suriyaprakash Somu
