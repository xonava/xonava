# Aggregate consistency boundaries

An aggregate definition declares a stable key, positive version, one to 100 unique member keys, and one to 100 uniquely keyed invariants. Invariants are synchronous deterministic predicates over an authoritative aggregate snapshot and run before mutation, after mutation, or in both phases. Compilation validates and freezes the definition. Only compiled definitions may be evaluated.

Snapshots MUST contain every declared member exactly once and MUST NOT contain undeclared members. A failed invariant raises a conflict identifying the aggregate, invariant, and phase in internal details while retaining the standard safe conflict response. An invariant that throws is invalid configuration rather than a business conflict.

`assertAggregateTransition` validates before and proposed snapshots during atomic-batch preparation. It MUST run before commands are submitted. `runAggregateTransaction` requires an existing interactive-transaction provider and performs the initial load, before checks, mutation, second authoritative load, and after checks inside the same transaction. It defaults to serializable, read-write execution. An after-check failure is thrown inside the callback so the provider's existing transaction contract rolls back the mutation.

The aggregate layer does not implement a commit mechanism, load entities itself, compensate already-committed external effects, or replace OCC. Callers MUST use authoritative scoped repositories, preserve OCC fences, and keep external effects behind the existing outbox/workflow mechanisms. Atomic-batch callers MUST construct the proposed snapshot from the exact commands they submit.

The aggregate conformance suite covers compilation, phase behavior, exact membership, deterministic transition checks, scoped transaction use, serializable defaults, rollback on failure, provider capability refusal, and exception normalization. Traceability: `@xonava/core/aggregate`.
