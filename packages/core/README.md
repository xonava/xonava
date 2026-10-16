# @xonava/core

Zero-dependency core of the Xonava server framework: runtime-neutral semantics and TypeScript contracts for entities, operations, persistence, events, workflows, and access policy.

[![npm version](https://img.shields.io/npm/v/@xonava/core)](https://www.npmjs.com/package/@xonava/core)
[![license: MIT](https://img.shields.io/npm/l/@xonava/core)](https://github.com/xonava/xonava/blob/main/LICENSE)
[![node >=22](https://img.shields.io/node/v/@xonava/core)](https://nodejs.org)

> **Experimental.** Xonava is in its `0.x` series: a minor release may contain breaking changes until `1.0.0`. Pin an exact version. See [Known limitations](https://github.com/xonava/xonava/blob/main/docs/KNOWN-LIMITATIONS.md) before you adopt it.

Core has no runtime dependencies, ships native ES modules, and exposes one subpath per capability. Importing one subpath does not initialize bootstrap, workflow, HTTP, or a database provider. Concrete database, HTTP, cache, and storage implementations live in [`@xonava/adapters`](https://www.npmjs.com/package/@xonava/adapters).

## Install

```sh
npm install @xonava/core
```

Requires Node.js 22 or later. The package is ESM only.

## Usage

Import the capability you need from its subpath and supply the contract implementation it requires. There is no global container.

A cache service over any `CacheAdapter`:

```ts
import { CacheService, type CacheAdapter } from "@xonava/core/cache";

declare const adapter: CacheAdapter; // supply an implementation, for example from @xonava/adapters/cache
const cache = new CacheService({ adapter, defaultTtlMs: 30_000 });
await cache.set("account:42", { enabled: true });
const account = await cache.get<{ enabled: boolean }>("account:42");
```

An atomic rate-limit check:

```ts
import { checkRateLimit, type AtomicRateLimitStore } from "@xonava/core/rate-limit";

declare const store: AtomicRateLimitStore; // supply an implementation, for example from @xonava/adapters/cache
const decision = await checkRateLimit({
  store, key: "tenant:t1:user:u1", limit: 100, windowMs: 60_000,
});
```

## Entry points

The package root is intentionally small. Everything else is a subpath.

| Import | Purpose |
| --- | --- |
| `@xonava/core` | Entity definition and compilation, and operation creation and execution |
| `@xonava/core/aggregate` | Named consistency boundaries and transactional cross-entity invariants |
| `@xonava/core/kernel` | Validation and definition integrity |
| `@xonava/core/domain` | Errors, principals, authority, predicates, and ABAC primitives |
| `@xonava/core/entity` | Entity definitions, compilation, scope, lifecycle, and scalars |
| `@xonava/core/cache` | Cache service, adapter contract, and generation semantics |
| `@xonava/core/rate-limit` | Rate-limit stores, decisions, and enforcement |
| `@xonava/core/telemetry` | Neutral telemetry port, events, and safe attributes |
| `@xonava/core/temporal` | Temporal revisions, snapshots, stores, and point-in-time reconstruction |
| `@xonava/core/quota` | Quota contracts |
| `@xonava/core/resilience` | Retry and circuit-breaker policy |
| `@xonava/core/rules` | Deterministic, versioned, and effective-dated business-rule evaluation |
| `@xonava/core/sequence` | Transaction-bound scoped sequential-number allocation and formatting |
| `@xonava/core/object-store` | Object-store contract |
| `@xonava/core/health` | Health contracts |
| `@xonava/core/secrets` | Opaque secret contract |
| `@xonava/core/feature-flags` | Trusted feature facts |
| `@xonava/core/business-calendar` | Business-calendar contract |
| `@xonava/core/persistence` | Provider and repository contracts, routing, scoping, bulk and streaming, and capabilities |
| `@xonava/core/query` | Query plans, budgets, projection, consistency, pagination, cursors, and search |
| `@xonava/core/read-model` | Read-model definition and execution |
| `@xonava/core/events` | Events, and audit, idempotency, inbox, outbox, and lease contracts |
| `@xonava/core/operation` | Operations, services, context, budgets, deadlines, and execution |
| `@xonava/core/execution` | Jobs, schedules, retry, progress, and dispatch |
| `@xonava/core/workflow` | Workflow definitions, state machine, dispatcher, and store |
| `@xonava/core/security` | Scope resolution and authorized execution plans |
| `@xonava/core/storage` | Attachment contract |
| `@xonava/core/bootstrap` | Definition compilation, dependency and readiness checks, and runtime plan |
| `@xonava/core/serialization` | Canonical JSON, fingerprints, envelopes, codecs, and versions |

Only the paths in the package `exports` map are public. Do not deep-import `src` or `dist`.

## Documentation

- [Documentation index](https://github.com/xonava/xonava/blob/main/docs/README.md)
- [Getting started](https://github.com/xonava/xonava/blob/main/docs/guides/getting-started.md)
- [Core usage](https://github.com/xonava/xonava/blob/main/docs/typescript/core-usage.md)
- [TypeScript profile](https://github.com/xonava/xonava/blob/main/docs/typescript/README.md)
- [Specification](https://github.com/xonava/xonava/blob/main/docs/spec/README.md)
- [Public exports](https://github.com/xonava/xonava/blob/main/docs/reference/package-exports.md)
- [Known limitations](https://github.com/xonava/xonava/blob/main/docs/KNOWN-LIMITATIONS.md)

## License

[MIT](https://github.com/xonava/xonava/blob/main/LICENSE)
