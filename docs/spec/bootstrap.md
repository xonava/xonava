# Bootstrap and compiled plans

## Scope and requirements

Bootstrap MUST validate definitions, dependencies, capability requirements, formats, guarantees, and readiness before exposing a runtime plan. Compilation MUST be deterministic for the same valid registry and MUST fail closed on missing/contradictory requirements. The sealed plan is the runtime authority; adapters MUST NOT recompile policy ad hoc.

Runtime registration and readiness MUST not allow an implementation to claim an unproven capability.

Dependency graphs MUST reject missing nodes and cycles and produce deterministic order. Registries MUST reject duplicate stable identities. Runtime bindings MUST match compiled route/entity/operation requirements and must not mutate sealed definitions. Entity definitions that declare a resolved cache key prefix (`config.cache.keyPrefix`) MUST have an application-unique prefix: compilation MUST fail with a configuration error naming both entities when two share one. Applications assembling compiled entity definitions directly SHOULD apply the same check (`assertUniqueEntityCachePrefixes`, `@xonava/core/entity`). Readiness changes after startup MUST be represented explicitly rather than silently serving with missing required dependencies.

## Module catalogs

Applications own their module registrations, capability mappings and initial grants. The compiler
already rejects routes, operations and policy keys that do not reference each other, and policy
normalization rejects actions and fields missing from a module catalog (see
[security](security.md)). A separate catalog-introspection or module-descriptor API is not planned
before `1.0.0`: it would duplicate application-owned mappings, and adding an action must never widen
existing grants implicitly. The decision is revisited if pilot applications show registration drift
that these checks do not catch.

## Errors and conformance

Definition/dependency/format/guarantee contradictions are configuration failures before readiness. Runtime capability loss is readiness/dependency failure. Conformance covers duplicates, missing dependencies, cycles, deterministic plans, mutation resistance, capability mismatch, format/guarantee checks, binding, and readiness transitions.

Traceability: `packages/core/src/bootstrap`; compiler lifecycle/readiness tests; F3/A-series and API evidence.
