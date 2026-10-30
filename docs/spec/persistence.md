# Persistence

## Scope

Persistence defines providers, repositories, trusted scoping, datasource routing, capabilities, transactions, OCC, bulk operations, streams, and failure semantics. Detailed requirements are split into [provider/repository](persistence/provider-and-repository.md), [scope/routing](persistence/scope-and-routing.md), [bulk/streaming](persistence/bulk-and-streaming.md), [transactions/OCC](transactions-and-occ.md), predicates, entity versions, and leases.

## Requirements

A provider MUST declare only capabilities it proves. Reads MUST distinguish absence, authorization-filtered absence, and provider failure without leaking protected existence. Mutations MUST produce defined success/conflict outcomes and MUST NOT partially apply atomic effects. Every tenant/application-aware access MUST include trusted scope predicates generated from the compiled plan.

Reference provider notes are non-normative: PostgreSQL uses interactive transactions/locking, MySQL its transaction/result semantics, and D1 atomic batches/conditional writes.

## Errors

Invalid plans/inputs are validation failures; stale versions are conflicts; unavailable declared requirements are capability failures; transient provider failures are retryable only when normalized as such. Provider messages MUST NOT be exposed unsafely.

## Conformance

Providers MUST pass contract, integration, scope isolation, transaction rollback, OCC/race, and crash/replay suites applicable to every claimed capability.

Traceability: `packages/core/src/persistence`; `packages/adapters/src/drizzle-*`.
