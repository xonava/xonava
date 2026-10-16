# Architecture

This page is the non-normative architecture of the framework. Normative behavior lives in [`spec/`](spec/README.md). Contributor setup and commands are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Overview

The framework separates specification, implementation, integration, and proof:

```text
                 LANGUAGE-NEUTRAL SPECIFICATION
                              │
                     TypeScript profile
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
            core           adapters         testing
              │               │               │
              └───────────────┼───────────────┘
                              ▼
                     certified behavior
```

Core defines contracts, semantics, domain primitives, and neutral orchestration. Adapters connect those contracts to databases, HTTP, storage, caches, and runtimes. Testing provides reusable contract suites, real-provider integration/race/crash suites, and certification evidence.

An application normally follows `application → public capability → contract → adapter → provider/runtime`. Provider technology never becomes core semantics.

## Principles

- Core defines observable semantics and has zero runtime dependencies.
- Adapters depend only on intentional public core APIs; core never depends on adapters or testing.
- Capabilities are independently consumable and do not require global initialization.
- Security and durability boundaries remain explicit.
- Reference adapters prove implementability; certification proves behavioral conformance.
- Provider-specific mechanics stay outside the neutral specification.
- No import-time registration is required.
- A port is a contract boundary, not a global consumer-facing directory.
- Current code is the source of truth when historical prose conflicts.

## Packages

### `@xonava/core`

Contracts, framework semantics, orchestration, domain primitives, capability logic, and intentional public APIs. Its root export is deliberately small; specialized capabilities use subpaths such as `@xonava/core/cache` and `@xonava/core/persistence`.

### `@xonava/adapters`

Reference and technology-specific implementations: PostgreSQL, MySQL, D1, HTTP/server composition, cache, and object storage. An adapter translates provider behavior into core semantics and normalizes provider failures.

### `@xonava/testing`

Fixtures, integration suites, conformance suites, race tests, process-crash/replay tests, and certification support. It may depend on core and adapters where proof requires real implementations.

See [public exports](reference/package-exports.md) for the exact supported entry points.

## Dependency model

```text
kernel
  ↑
standalone capabilities
  ↑
domain / entity / query / persistence / events
  ↑
operation / execution / workflow
  ↑
bootstrap
```

Lower-level capabilities MUST NOT acquire dependencies on higher orchestration merely for convenience.

```text
adapters → public core APIs
testing  → core; adapters when implementations are under test
core     ✕ adapters
core     ✕ testing
```

Architecture verification rejects runtime cycles, obsolete package identities, private compatibility surfaces, and tree-shaking regressions.

## Execution model

An operation definition describes trusted input/output behavior, authorization, budgets, hooks, and required capabilities. An execution context carries an attenuated principal/scope, deadline, cancellation, services, telemetry, and effects. The operation produces a canonical result or structured error; transport adapters translate at the boundary.

```text
transport input → adapter validation → canonical operation input
  → authorization plan → scoped execution → result/effects
  → adapter response
```

Jobs, schedules, and workflows add durable identity, retry, progress, leases/fencing, and versioned state. Their state machines remain distinct even where they share lease primitives.

## Adapter model and framework neutrality

Core does not depend on Express, Fastify, Hono, NestJS, Next.js, database drivers, or cloud SDKs. An integration translates a runtime request into neutral operation input and maps canonical results/errors back to its transport.

```text
HTTP request → HTTP adapter → core operation → canonical result/error → HTTP adapter → response
```

HTTP status, headers, request objects, and middleware are adapter concerns. A reference adapter is an example/proof implementation. A certified adapter has passed the applicable conformance and provider-specific suites. A defect in an uncertified custom adapter is not automatically a core defect.

## Modularity and tree shaking

Core uses native ESM, capability subpath exports, `sideEffects: false`, zero runtime dependencies, and no required import-time registry. Applications may consume cache, rate limiting, telemetry, object storage, persistence, query, or full orchestration independently.

Tree shaking means an application bundle can omit unreachable capability code. It does not mean npm installs dependencies separately per subpath. Adapter packaging/distribution is separate.

The architecture gate bundles nine isolated consumption fixtures and rejects cross-capability leakage, runtime cycles, and obsolete owners.

## Domain layer

The domain layer owns framework decisions that must remain independent of HTTP, databases, queues, and Cloudflare runtime APIs.

It contains predicates, ABAC policy evaluation, structured errors, and domain value normalization. Domain code may depend on other core domain modules and core ports as types, but must not import adapter implementations or application modules.

Keep I/O behind ports. If a rule needs a database, cache, audit sink, or request object, expose the required capability through a port and keep the decision itself in this layer.

## Contributor rules

For setup, verification commands, and database test requirements, see [CONTRIBUTING.md](../CONTRIBUTING.md). This section states where code belongs and the rules every change must follow.

### Placement

Place a fundamental invariant with no higher dependency in `@xonava/core/kernel`. Put neutral capability contracts and behavior in the corresponding core capability. Put provider- and runtime-specific code in `@xonava/adapters`. Put conformance and certification infrastructure in `@xonava/testing` or `scripts/verification`.

### Rules

- No compatibility aliases without an explicit versioning decision.
- No framework or provider imports in core.
- No adapter deep-imports into private core files.
- No unjustified broad barrels, dead migration files, or duplicate canonical concepts.
- Public behavior requires tests and applicable conformance coverage.
- Normative behavior cannot exist only in an implementation comment.
- React and HTTP-framework bindings belong outside core.
