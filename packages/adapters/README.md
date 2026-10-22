# @xonava/adapters

Reference adapters for the `@xonava/core` contracts: PostgreSQL, MySQL, and Cloudflare D1 persistence through Drizzle, Express, Fastify, and Hono HTTP bindings, server composition, cache, and object storage.

[![npm version](https://img.shields.io/npm/v/@xonava/adapters)](https://www.npmjs.com/package/@xonava/adapters)
[![license: MIT](https://img.shields.io/npm/l/@xonava/adapters)](https://github.com/xonava/xonava/blob/main/LICENSE)
[![node >=22](https://img.shields.io/node/v/@xonava/adapters)](https://nodejs.org)

> **Experimental.** Xonava is in its `0.x` series: a minor release may contain breaking changes until `1.0.0`. Pin an exact version. See [Known limitations](https://github.com/xonava/xonava/blob/main/docs/KNOWN-LIMITATIONS.md) before you adopt it.

Provider-specific behavior lives here, not in [`@xonava/core`](https://www.npmjs.com/package/@xonava/core), which is installed automatically as a dependency.

## Install

```sh
npm install @xonava/adapters drizzle-orm
```

Requires Node.js 22 or later. The package is ESM only.

`drizzle-orm` is a required peer dependency. Everything else is an optional peer, so install only what the subpaths you import need:

| Subpath | Install alongside `@xonava/adapters` |
| --- | --- |
| `./drizzle-pg` | `drizzle-orm pg` (TypeScript users also add `@types/pg`) |
| `./drizzle-mysql` | `drizzle-orm mysql2` |
| `./drizzle-d1` | `drizzle-orm` (needs a Cloudflare runtime that provides a D1 binding) |
| `./express` | `express` (TypeScript users also add `@types/express`) |
| `./fastify` | `fastify` |
| `./hono` | `hono` |
| `./cache`, `./storage`, `./http`, `./server` | nothing beyond `drizzle-orm` |

For example, PostgreSQL with Hono:

```sh
npm install @xonava/adapters drizzle-orm pg hono
npm install -D @types/pg
```

Supported peer ranges: `drizzle-orm` ^0.45.2, `pg` ^8.16.3, `mysql2` ^3.24.4, `express` ^5, `@types/express` ^5, `fastify` ^5, `hono` ^4.

## Usage

### Bind compiled CRUD handlers to Hono

`handlers` is the result of `CRUD(definition, runtime)` from `@xonava/adapters/http`, where `definition` is a compiled `defineEntity()` result. Fastify and Express work the same way. See the [HTTP framework guide](https://github.com/xonava/xonava/blob/main/docs/typescript/http-adapters.md) for both.

```ts
import { Hono } from "hono";
import type { HttpCrudHandlers, HttpHandler } from "@xonava/adapters/http";
import { createHonoCrudApp, createHonoHandler } from "@xonava/adapters/hono";

declare const handlers: HttpCrudHandlers; // the result of CRUD(definition, runtime) from @xonava/adapters/http
declare const writeHandler: HttpHandler;  // for example from createFrameworkWriteHandler()

const app = new Hono();
app.route("/people", createHonoCrudApp(handlers));
app.post("/action", createHonoHandler(writeHandler));

export default app;
```

### Create a PostgreSQL persistence provider

Register each entity with its Drizzle table and column map, then create the provider. The MySQL and D1 entry points follow the same shape.

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import type { EntityDescriptor } from "@xonava/core/persistence";
import { createDrizzlePersistenceProvider, DrizzleEntityRegistry } from "@xonava/adapters/drizzle-pg";

interface Person { id: string; name: string }

const people = pgTable("people", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
});

declare const person: EntityDescriptor<Person>; // from your entity definition

const registry = new DrizzleEntityRegistry().register(person, people, {
  id: people.id,
  name: people.name,
});

const db = drizzle(new Pool({ connectionString: process.env.DATABASE_URL }));
export const persistence = createDrizzlePersistenceProvider({ db, registry });
```

### Use the in-memory cache and rate-limit store

Useful for development and tests. They are scoped to one process.

```ts
import { InMemoryCacheAdapter, InMemoryRateLimitStore } from "@xonava/adapters/cache";
import { CacheService } from "@xonava/core/cache";
import { checkRateLimit } from "@xonava/core/rate-limit";

const cache = new CacheService({ adapter: new InMemoryCacheAdapter(), defaultTtlMs: 30_000 });
await cache.set("account:42", { enabled: true });

const decision = await checkRateLimit({
  store: new InMemoryRateLimitStore(),
  key: "tenant:t1:user:u1",
  limit: 100,
  windowMs: 60_000,
});
```

## Entry points

| Import | Purpose |
| --- | --- |
| `@xonava/adapters` | Deliberately small shared adapter surface |
| `@xonava/adapters/http` | HTTP parsing, handler, and error integration, including `CRUD()` |
| `@xonava/adapters/server` | Server-side composition and finalization |
| `@xonava/adapters/fastify` | Fastify 5 bindings for Fetch handlers and compiled CRUD routes |
| `@xonava/adapters/hono` | Hono 4 bindings for Fetch handlers and compiled CRUD routes |
| `@xonava/adapters/express` | Express 5 bindings for Fetch handlers and compiled CRUD routes |
| `@xonava/adapters/drizzle-pg` | PostgreSQL persistence and durability implementation |
| `@xonava/adapters/drizzle-mysql` | MySQL persistence and durability implementation |
| `@xonava/adapters/drizzle-d1` | Cloudflare D1 persistence and durability implementation |
| `@xonava/adapters/cache` | Reference cache adapters and cache-backed rate-limit stores |
| `@xonava/adapters/storage` | Reference object storage |

Only the paths in the package `exports` map are public. Do not deep-import `src` or `dist`.

## Reference migrations

The package ships the reference DDL for each database under `node_modules/@xonava/adapters/migrations/<postgres|mysql|d1>/`. The files are numbered; apply them in order. They are byte-identical copies of the migrations the `@xonava/testing` suites run against (a repository check fails when they differ).

| Database | Files | Re-running |
| --- | --- | --- |
| PostgreSQL | `0001` to `0005` | Every file is idempotent and safe to re-run. `0002` holds a lock on `workflow_signals` while it backfills. |
| MySQL | `0001` to `0006` | `0001` is **not** safe to re-run on a database with data: it drops and recreates `audit`, `outbox`, `idempotency`, `jobs`, `job_executions`, `job_progress` and `schedules`. `0002`, `0004`, `0005` and the `scope_hash` statements of `0006` add columns or keys that MySQL cannot guard, so apply them once. `0003` and the `MODIFY` statements of `0006` are safe to re-apply. |
| D1 | `0001` to `0005` | `0001`, `0003` and `0004` use `IF NOT EXISTS` and are safe to re-run. `0002` and `0005` add columns, which SQLite cannot guard, so apply them once. |

The `@xonava/testing` fixtures guard the statements that cannot be re-run: the MySQL fixture applies `0002` only while `workflow_signals.seq` is missing, `0004` only while `jobs_partition_head_idx` is missing, `0005` only while `jobs.scope_key` is missing, and the `scope_hash` statements of `0006` only while that column is missing. The D1 fixture treats a `duplicate column name` error on a file's first statement as already applied. A production migration tool must do the same (or record applied files) because the files themselves do not guard those statements.

The table, schema and column names in the files are fixture defaults (the PostgreSQL files use the schema `framework_test`). The store factories let you change them through their `schema`, `tables` and column-map options; rename them in the files you apply to match. Read [Known limitations](https://github.com/xonava/xonava/blob/main/docs/KNOWN-LIMITATIONS.md#apply-the-migrations-first) for which migrations are required.

## Verification

Type checking alone does not show that a database adapter meets the contract. The adapters are verified by the integration, conformance, race, and crash suites in [`@xonava/testing`](https://www.npmjs.com/package/@xonava/testing), run against real databases. Apply the required migrations and review the deployment requirements in [Known limitations](https://github.com/xonava/xonava/blob/main/docs/KNOWN-LIMITATIONS.md) before you run this release.

## Documentation

- [Adapter model](https://github.com/xonava/xonava/blob/main/docs/architecture.md#adapter-model-and-framework-neutrality)
- [Persistence setup](https://github.com/xonava/xonava/blob/main/docs/guides/persistence-setup.md)
- [HTTP framework adapters](https://github.com/xonava/xonava/blob/main/docs/typescript/http-adapters.md)
- [Adapter authoring](https://github.com/xonava/xonava/blob/main/docs/typescript/adapter-authoring.md)
- [Writing and testing adapters](https://github.com/xonava/xonava/blob/main/docs/guides/writing-and-testing-adapters.md)
- [Public exports](https://github.com/xonava/xonava/blob/main/docs/reference/package-exports.md)

## License

[MIT](https://github.com/xonava/xonava/blob/main/LICENSE)
