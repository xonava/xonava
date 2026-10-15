# @xonava/core

Language-neutral framework semantics and their TypeScript reference contracts. Core has zero runtime dependencies, native ES module exports, and one subpath per capability. The package root is intentionally small.

## Install

```sh
npm install @xonava/core
```

Requires Node.js 22 or later.

## Usage

Import the capability you need from its subpath. Importing one subpath does not initialize bootstrap, workflow, HTTP, or a database provider.

```ts
import { checkRateLimit, type AtomicRateLimitStore } from "@xonava/core/rate-limit";

declare const store: AtomicRateLimitStore; // supply an implementation, for example from @xonava/adapters/cache
const decision = await checkRateLimit({
  store, key: "tenant:t1:user:u1", limit: 100, windowMs: 60_000,
});
```

## Subpath exports

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
- [Specification](https://github.com/xonava/xonava/blob/main/docs/spec/README.md)
- [TypeScript profile](https://github.com/xonava/xonava/blob/main/docs/typescript/README.md)
- [Core usage](https://github.com/xonava/xonava/blob/main/docs/typescript/core-usage.md)
- [Public exports](https://github.com/xonava/xonava/blob/main/docs/reference/package-exports.md)

## License

MIT
