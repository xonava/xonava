# Public package exports

Only package export-map paths are supported APIs. Private source/dist paths are not public.

## Core

| Subpath | Purpose / major surface |
|---|---|
| `core` | Small entity compilation and operation execution surface |
| `core/aggregate` | Named consistency boundaries and transactional cross-entity invariants |
| `core/kernel` | Validation and definition integrity |
| `core/domain` | Errors, principals, authority, predicates, ABAC/domain primitives |
| `core/entity` | Entity definitions, compilation, scope/lifecycle/scalars |
| `core/cache` | Cache service/adapter and generation semantics |
| `core/rate-limit` | Rate-limit stores, decisions, enforcement |
| `core/telemetry` | Neutral telemetry port/events/safe attributes |
| `core/temporal` | Temporal revisions, snapshots, stores, and point-in-time reconstruction |
| `core/quota` | Quota contracts |
| `core/resilience` | Retry/circuit/resilience policy |
| `core/rules` | Deterministic, versioned and effective-dated business-rule evaluation |
| `core/sequence` | Transaction-bound scoped sequential-number allocation and formatting |
| `core/object-store` | Object-store contract |
| `core/health` | Health contracts |
| `core/secrets` | Opaque secret contract |
| `core/feature-flags` | Trusted feature facts |
| `core/business-calendar` | Business-calendar contract |
| `core/persistence` | Provider/repository, routing, scoping, bulk/streaming/capabilities |
| `core/query` | Plans, budgets, projection, consistency, pagination/cursors/search |
| `core/read-model` | Read-model definition/execution |
| `core/events` | Events plus audit/idempotency/inbox/outbox/lease contracts |
| `core/operation` | Operations, services, context, budgets, deadlines, execution |
| `core/execution` | Jobs, schedules, retry, progress, dispatch |
| `core/workflow` | Workflow definitions, state machine, dispatcher, store |
| `core/security` | Scope resolution and authorized execution plans |
| `core/storage` | Attachment contract |
| `core/bootstrap` | Definition compilation, dependency/readiness/runtime plan |
| `core/serialization` | Canonical JSON, fingerprints, envelopes, codecs, versions |

## Adapters

| Subpath | Purpose |
|---|---|
| `adapters` | Deliberately small shared adapter surface |
| `adapters/http` | HTTP parsing/handler/error integration |
| `adapters/fastify` | Fastify 5 bindings for Fetch handlers and compiled CRUD routes |
| `adapters/hono` | Hono 4 bindings for Fetch handlers and compiled CRUD routes |
| `adapters/express` | Express 5 bindings for Fetch handlers and compiled CRUD routes |
| `adapters/server` | Server-side composition/finalization |
| `adapters/drizzle-pg` | PostgreSQL reference persistence/durability implementation |
| `adapters/drizzle-mysql` | MySQL reference persistence/durability implementation |
| `adapters/drizzle-d1` | Cloudflare D1 reference implementation |
| `adapters/cache` | Reference cache adapters |
| `adapters/storage` | Reference object storage |

`testing` is workspace certification infrastructure and currently has no package export map. Stability follows the version policy; new/removal/semantic changes to public paths require an API/version decision.
