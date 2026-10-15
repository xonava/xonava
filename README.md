# Framework reference implementation

A TypeScript server framework built from a language-neutral specification. Each capability (caching, rate limiting, persistence, queries, events, operations, jobs and schedules, workflows, and more) is a separate subpath of `@xonava/core`, so an application imports only what it uses. Reference adapters connect those capabilities to PostgreSQL, MySQL, Cloudflare D1, HTTP frameworks, cache, and object storage. `@xonava/testing` provides the conformance suites the adapters are checked against.

> **Experimental.** This is the `2.0.0-rc.2` release candidate. The API may change before `2.0.0`. Known gaps are listed in [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md).

## Packages

| Package | Install | Contents |
| --- | --- | --- |
| `@xonava/core` | `npm install @xonava/core` | Capability contracts and semantics. No runtime dependencies. Import subpaths such as `@xonava/core/cache`. |
| `@xonava/adapters` | `npm install @xonava/adapters` | Reference integrations for PostgreSQL, MySQL, D1, Express, Fastify, Hono, cache, and object storage. |
| `@xonava/testing` | `npm install -D @xonava/testing vitest` | Fixtures and contract suites for core and adapters. |

Each package README lists its subpaths: [core](packages/core/README.md), [adapters](packages/adapters/README.md), and [testing](packages/testing/README.md).

## Quick start

Requires Node.js 22 or later. The packages are native ES modules.

```ts
import { CacheService, type CacheAdapter } from "@xonava/core/cache";

declare const adapter: CacheAdapter; // supply an implementation, for example a reference cache adapter from @xonava/adapters/cache
const cache = new CacheService({ adapter, defaultTtlMs: 30_000 });
await cache.set("account:42", { enabled: true });
const account = await cache.get<{ enabled: boolean }>("account:42");
```

Core capabilities do not require a global container. You pass each capability the implementation it needs. An application can start with one capability and add others later. See [getting started](docs/guides/getting-started.md).

## Supported backends

| Kind | Supported | Import |
| --- | --- | --- |
| Database | PostgreSQL | `@xonava/adapters/drizzle-pg` |
| Database | MySQL 8 | `@xonava/adapters/drizzle-mysql` |
| Database | Cloudflare D1 | `@xonava/adapters/drizzle-d1` |
| HTTP framework | Express 5 | `@xonava/adapters/express` |
| HTTP framework | Fastify 5 | `@xonava/adapters/fastify` |
| HTTP framework | Hono 4 | `@xonava/adapters/hono` |

Typechecking an adapter does not show that it meets the contract. Database behavior is verified by the suites described in [persistence setup](docs/guides/persistence-setup.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [Documentation index](docs/README.md)
- [Specification](docs/spec/README.md): language-neutral semantics and conformance requirements
- [TypeScript profile](docs/typescript/README.md): the TypeScript API mapping
- [Public exports](docs/reference/package-exports.md): the supported import paths
- [Known limitations](docs/KNOWN-LIMITATIONS.md)
- [Changelog](CHANGELOG.md)

## Contributing and security

- [Contributing](CONTRIBUTING.md): setup, build, test, and verification commands
- [Architecture rules](docs/architecture/contributing.md): where code belongs and what it must not import
- [Security policy](SECURITY.md): how to report a vulnerability privately

## License

Released under the [MIT License](LICENSE).
