# @SCOPE/adapters

Reference technology integrations for the public core contracts: PostgreSQL, MySQL, Cloudflare D1, HTTP framework bindings, server composition, cache, and object storage. Provider-specific behavior lives here, not in `@SCOPE/core`.

## Install

```sh
npm install @SCOPE/adapters
```

Requires Node.js 22 or later. The database drivers (`drizzle-orm`, `pg`, `mysql2`) are regular dependencies and install with the package.

The HTTP framework packages are optional peer dependencies. Install only the ones you use:

```sh
npm install express@^5 @types/express@^5   # ./express (TypeScript users also need @types/express)
npm install fastify@^5                     # ./fastify
npm install hono@^4                        # ./hono
```

`@SCOPE/adapters/drizzle-d1` needs no extra package. It is meant to run in a Cloudflare runtime that provides a D1 database binding.

## Subpath exports

| Import | Purpose |
| --- | --- |
| `@SCOPE/adapters` | Deliberately small shared adapter surface |
| `@SCOPE/adapters/http` | HTTP parsing, handler, and error integration, including `CRUD()` |
| `@SCOPE/adapters/server` | Server-side composition and finalization |
| `@SCOPE/adapters/fastify` | Fastify 5 bindings for Fetch handlers and compiled CRUD routes |
| `@SCOPE/adapters/hono` | Hono 4 bindings for Fetch handlers and compiled CRUD routes |
| `@SCOPE/adapters/express` | Express 5 bindings for Fetch handlers and compiled CRUD routes |
| `@SCOPE/adapters/drizzle-pg` | PostgreSQL persistence and durability implementation |
| `@SCOPE/adapters/drizzle-mysql` | MySQL persistence and durability implementation |
| `@SCOPE/adapters/drizzle-d1` | Cloudflare D1 persistence and durability implementation |
| `@SCOPE/adapters/cache` | Reference cache adapters and cache-backed rate-limit stores |
| `@SCOPE/adapters/storage` | Reference object storage |

Only the paths in the package `exports` map are public. Do not deep-import `src` or `dist`.

## Example

`handlers` is the result of `CRUD(definition, runtime)` from `@SCOPE/adapters/http`, where `definition` is a compiled `defineEntity()` result. See the [HTTP framework guide](https://github.com/Suriyaprakash-Somu/engine/blob/main/docs/typescript/http-adapters.md) for the Fastify and Express equivalents.

```ts
import { Hono } from 'hono'
import { createHonoCrudApp, createHonoHandler } from '@SCOPE/adapters/hono'

const app = new Hono()
app.route('/people', createHonoCrudApp(handlers))
app.post('/action', createHonoHandler(writeHandler))
export default app
```

## Verification

Database adapters are verified by the integration, conformance, race, and crash suites in `@SCOPE/testing`, run against real databases. Typechecking alone does not show that an adapter meets the contract. See the [persistence setup guide](https://github.com/Suriyaprakash-Somu/engine/blob/main/docs/guides/persistence-setup.md) and the [adapter authoring guide](https://github.com/Suriyaprakash-Somu/engine/blob/main/docs/typescript/adapter-authoring.md).

## Documentation

- [Adapter model](https://github.com/Suriyaprakash-Somu/engine/blob/main/docs/architecture/adapter-model.md)
- [Adapter authoring](https://github.com/Suriyaprakash-Somu/engine/blob/main/docs/typescript/adapter-authoring.md)
- [HTTP framework adapters](https://github.com/Suriyaprakash-Somu/engine/blob/main/docs/typescript/http-adapters.md)
- [Persistence setup](https://github.com/Suriyaprakash-Somu/engine/blob/main/docs/guides/persistence-setup.md)
- [Public exports](https://github.com/Suriyaprakash-Somu/engine/blob/main/docs/reference/package-exports.md)

## License

MIT
