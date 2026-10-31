# Public package exports

Only package export-map paths are supported APIs. Private source/dist paths are not public.

## Core

| Subpath | Purpose / major surface |
|---|---|
| `@xonava/core` | Small entity compilation and operation execution surface |
| `@xonava/core/aggregate` | Named consistency boundaries and transactional cross-entity invariants |
| `@xonava/core/kernel` | Validation and definition integrity |
| `@xonava/core/domain` | Errors, principals, authority, predicates, ABAC/domain primitives |
| `@xonava/core/entity` | Entity definitions, compilation, scope/lifecycle/scalars |
| `@xonava/core/cache` | Cache service/adapter and generation semantics |
| `@xonava/core/rate-limit` | Rate-limit stores, decisions, enforcement |
| `@xonava/core/telemetry` | Neutral telemetry port/events/safe attributes |
| `@xonava/core/temporal` | Temporal revisions, snapshots, stores, and point-in-time reconstruction |
| `@xonava/core/quota` | Quota contracts |
| `@xonava/core/resilience` | Retry/circuit/resilience policy |
| `@xonava/core/rules` | Deterministic, versioned and effective-dated business-rule evaluation |
| `@xonava/core/sequence` | Transaction-bound scoped sequential-number allocation and formatting |
| `@xonava/core/object-store` | Object-store contract |
| `@xonava/core/health` | Health contracts |
| `@xonava/core/secrets` | Opaque secret contract |
| `@xonava/core/feature-flags` | Trusted feature facts |
| `@xonava/core/business-calendar` | Business-calendar contract |
| `@xonava/core/persistence` | Provider/repository, routing, scoping, bulk/streaming/capabilities |
| `@xonava/core/query` | Plans, budgets, projection, consistency, pagination/cursors/search |
| `@xonava/core/read-model` | Read-model definition/execution |
| `@xonava/core/events` | Events plus audit/idempotency/inbox/outbox/lease contracts |
| `@xonava/core/operation` | Operations, services, context, budgets, deadlines, execution |
| `@xonava/core/execution` | Jobs, schedules, retry, progress, dispatch |
| `@xonava/core/workflow` | Workflow definitions, state machine, dispatcher, store |
| `@xonava/core/security` | Scope resolution and authorized execution plans |
| `@xonava/core/storage` | Attachment contract |
| `@xonava/core/bootstrap` | Definition compilation, dependency/readiness/runtime plan |
| `@xonava/core/serialization` | Canonical JSON, fingerprints, envelopes, codecs, versions |

## Adapters

| Subpath | Purpose |
|---|---|
| `@xonava/adapters` | Deliberately small shared adapter surface |
| `@xonava/adapters/http` | HTTP parsing/handler/error integration |
| `@xonava/adapters/fastify` | Fastify 5 bindings for Fetch handlers and compiled CRUD routes |
| `@xonava/adapters/hono` | Hono 4 bindings for Fetch handlers and compiled CRUD routes |
| `@xonava/adapters/express` | Express 5 bindings for Fetch handlers and compiled CRUD routes |
| `@xonava/adapters/server` | Server-side composition/finalization |
| `@xonava/adapters/drizzle-pg` | PostgreSQL reference persistence/durability implementation |
| `@xonava/adapters/drizzle-mysql` | MySQL reference persistence/durability implementation |
| `@xonava/adapters/drizzle-d1` | Cloudflare D1 reference implementation |
| `@xonava/adapters/cache` | Reference cache adapters |
| `@xonava/adapters/storage` | Reference object storage |

## Testing

| Subpath | Purpose |
|---|---|
| `@xonava/testing` | All suite runners |
| `@xonava/testing/repositories` | Repository contract suite |
| `@xonava/testing/predicates` | Predicate contract suite |
| `@xonava/testing/abac` | ABAC invariant suite |
| `@xonava/testing/contracts/persistence-provider` | Persistence provider contract suite |
| `@xonava/testing/contracts/atomic-batch` | Atomic batch contract suite |
| `@xonava/testing/contracts/cache-adapter` | Cache adapter contract suite |
| `@xonava/testing/contracts/object-store` | Object store contract suite |
| `@xonava/testing/contracts/shared-conformance` | Shared conformance suites |

Stability follows the version policy; new/removal/semantic changes to public paths require an API/version decision.
