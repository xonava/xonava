# Transactions and optimistic concurrency

## Scope and requirements

An atomic transaction MUST make all included state changes visible together or none of them. Failure before commit MUST roll back the unit. Verification MUST use an independent connection/runtime where durable visibility is claimed.

Nested transaction behavior MUST be declared: true savepoint/nesting, join-existing, or unsupported. An implementation MUST NOT report independent commit when work actually joins an outer transaction. Isolation/locking requirements MUST be negotiated before execution; unavailable requirements produce capability failure.

## Optimistic concurrency

A versioned mutation MUST condition on the expected version and advance the version only on success. A stale version MUST produce a conflict and MUST NOT partially apply effects. When authorization facts can change concurrently, authorization predicates and the mutation MUST be one conditional atomic decision.

Exactly one concurrent mutation for a shared expected version may succeed. A retry MUST reread/re-authorize and use the new version; blind automatic replay is forbidden.

## Atomic effects and crash behavior

Idempotency receipt, audit, outbox, and cache-generation effects declared atomic with a mutation MUST commit or roll back with it. Crash recovery MUST yield either the committed state or a replayable uncommitted state, never an ambiguous partial outcome.

## Errors and conformance

Stale versions are conflict, invalid versions validation, unavailable transaction/isolation capability configuration/capability failure, and transient provider faults retryable only when normalized safely. Conformance covers rollback, commit visibility, independent verifier connections, concurrent winners, TOCTOU authorization, every atomic side effect, termination at named failpoints, fresh-process replay, and repetition thresholds.

Traceability: provider transaction/OCC/race/crash suites; V1 and MYSQL1 evidence.

## Commit outcome classification

Providers MUST distinguish a transaction that definitely did not commit from one whose outcome is unknown. A serialization failure or deadlock reported at COMMIT, for which the database guarantees rollback, SHOULD be raised as `TransactionRolledBackError` (a `RetryablePersistenceError`); the operation pipeline may then re-run the transaction. A lost connection or timeout during COMMIT has an unknown outcome and MUST NOT be raised as `TransactionRolledBackError`.
