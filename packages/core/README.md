# @SCOPE/core

Language-neutral framework semantics and their TypeScript reference contracts. Core has zero runtime dependencies, native ES module exports, and one subpath per capability. The package root is intentionally small.

## Install

```sh
npm install @SCOPE/core
```

Requires Node.js 22 or later.

## Usage

Import the capability you need from its subpath. Importing one subpath does not initialize bootstrap, workflow, HTTP, or a database provider.

```ts
import { checkRateLimit, type AtomicRateLimitStore } from "@SCOPE/core/rate-limit";

declare const store: AtomicRateLimitStore; // supply an implementation, for example from @SCOPE/adapters/cache
const decision = await checkRateLimit({
  store, key: "tenant:t1:user:u1", limit: 100, windowMs: 60_000,
});
```

## Subpath exports

| Import | Purpose |
| --- | --- |
| `@SCOPE/core` | Entity definition and compilation, and operation creation and execution |
| `@SCOPE/core/aggregate` | Named consistency boundaries and transactional cross-entity invariants |
| `@SCOPE/core/kernel` | Validation and definition integrity |
| `@SCOPE/core/domain` | Errors, principals, authority, predicates, and ABAC primitives |
| `@SCOPE/core/entity` | Entity definitions, compilation, scope, lifecycle, and scalars |
| `@SCOPE/core/cache` | Cache service, adapter contract, and generation semantics |
| `@SCOPE/core/rate-limit` | Rate-limit stores, decisions, and enforcement |
| `@SCOPE/core/telemetry` | Neutral telemetry port, events, and safe attributes |
| `@SCOPE/core/temporal` | Temporal revisions, snapshots, stores, and point-in-time reconstruction |
| `@SCOPE/core/quota` | Quota contracts |
| `@SCOPE/core/resilience` | Retry and circuit-breaker policy |
| `@SCOPE/core/rules` | Deterministic, versioned, and effective-dated business-rule evaluation |
| `@SCOPE/core/sequence` | Transaction-bound scoped sequential-number allocation and formatting |
| `@SCOPE/core/object-store` | Object-store contract |
| `@SCOPE/core/health` | Health contracts |
| `@SCOPE/core/secrets` | Opaque secret contract |
| `@SCOPE/core/feature-flags` | Trusted feature facts |
| `@SCOPE/core/business-calendar` | Business-calendar contract |
| `@SCOPE/core/persistence` | Provider and repository contracts, routing, scoping, bulk and streaming, and capabilities |
| `@SCOPE/core/query` | Query plans, budgets, projection, consistency, pagination, cursors, and search |
| `@SCOPE/core/read-model` | Read-model definition and execution |
| `@SCOPE/core/events` | Events, and audit, idempotency, inbox, outbox, and lease contracts |
| `@SCOPE/core/operation` | Operations, services, context, budgets, deadlines, and execution |
| `@SCOPE/core/execution` | Jobs, schedules, retry, progress, and dispatch |
| `@SCOPE/core/workflow` | Workflow definitions, state machine, dispatcher, and store |
| `@SCOPE/core/security` | Scope resolution and authorized execution plans |
| `@SCOPE/core/storage` | Attachment contract |
| `@SCOPE/core/bootstrap` | Definition compilation, dependency and readiness checks, and runtime plan |
| `@SCOPE/core/serialization` | Canonical JSON, fingerprints, envelopes, codecs, and versions |

Only the paths in the package `exports` map are public. Do not deep-import `src` or `dist`.

## Documentation

- [Documentation index](https://github.com/Suriyaprakash-Somu/engine/blob/main/docs/README.md)
- [Specification](https://github.com/Suriyaprakash-Somu/engine/blob/main/docs/spec/README.md)
- [TypeScript profile](https://github.com/Suriyaprakash-Somu/engine/blob/main/docs/typescript/README.md)
- [Core usage](https://github.com/Suriyaprakash-Somu/engine/blob/main/docs/typescript/core-usage.md)
- [Public exports](https://github.com/Suriyaprakash-Somu/engine/blob/main/docs/reference/package-exports.md)

## License

MIT
