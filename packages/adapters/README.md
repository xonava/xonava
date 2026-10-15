# @xonava/adapters

Reference adapters for the `@xonava/core` contracts: PostgreSQL, MySQL, and Cloudflare D1 persistence through Drizzle, Express, Fastify, and Hono HTTP bindings, server composition, cache, and object storage.

[![npm version](https://img.shields.io/npm/v/@xonava/adapters)](https://www.npmjs.com/package/@xonava/adapters)
[![license: MIT](https://img.shields.io/npm/l/@xonava/adapters)](https://github.com/xonava/xonava/blob/main/LICENSE)
[![node >=22](https://img.shields.io/node/v/@xonava/adapters)](https://nodejs.org)

> **Experimental.** Version `2.0.0-rc.2` is a release candidate, and public APIs may still change before `2.0.0`. See [Known limitations](https://github.com/xonava/xonava/blob/main/docs/KNOWN-LIMITATIONS.md) before you adopt it.

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

## Verification

Type checking alone does not show that a database adapter meets the contract. The adapters are verified by the integration, conformance, race, and crash suites in [`@xonava/testing`](https://www.npmjs.com/package/@xonava/testing), run against real databases. Apply the required migrations and review the deployment requirements in [Known limitations](https://github.com/xonava/xonava/blob/main/docs/KNOWN-LIMITATIONS.md) before you run this release.

## Documentation

- [Adapter model](https://github.com/xonava/xonava/blob/main/docs/architecture/adapter-model.md)
- [Persistence setup](https://github.com/xonava/xonava/blob/main/docs/guides/persistence-setup.md)
- [HTTP framework adapters](https://github.com/xonava/xonava/blob/main/docs/typescript/http-adapters.md)
- [Adapter authoring](https://github.com/xonava/xonava/blob/main/docs/typescript/adapter-authoring.md)
- [Writing and testing adapters](https://github.com/xonava/xonava/blob/main/docs/guides/writing-and-testing-adapters.md)
- [Public exports](https://github.com/xonava/xonava/blob/main/docs/reference/package-exports.md)

## License

[MIT](https://github.com/xonava/xonava/blob/main/LICENSE)
