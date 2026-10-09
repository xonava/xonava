# Writing and testing an adapter

1. Select the neutral contract and read its normative specification.
2. Import only its public `core/<capability>` entry point.
3. Map provider operations and errors without weakening semantics.
4. Declare only capabilities the implementation actually guarantees.
5. Add provider-local unit/integration tests.
6. Run shared conformance suites.
7. Add race and crash/replay tests for concurrency/durability.
8. Produce source-bound certification evidence.

For HTTP, translate request data to canonical operation input and map canonical output/errors back to HTTP. Do not place request/response objects in core operations.

## Provider obligations added by the core hardening

- **Commit outcome.** Classify transaction failures with the callback's completion: a serialization failure or deadlock reported at COMMIT is `TransactionRolledBackError`; any other COMMIT failure keeps an unknown outcome; raw driver errors are always normalized (`classifyTransactionFailure`).
- **Transaction deadlines.** Declare `capabilities.transactionTimeouts` only when `TransactionOptions.timeoutMs` is enforced inside the database (PostgreSQL: `SET LOCAL statement_timeout`); statement timeouts map to `TIMEOUT`.
- **Access mode.** Honour `accessMode: "read only"`; the operation pipeline requests it for transactional reads.
- **Predicate text semantics.** Compile predicates with the engine's dialect (`postgres`, `mysql`, `sqlite`) so string comparison is case-sensitive and code-point ordered regardless of column collation. MySQL schemas may opt into direct comparison (`mysqlBinaryCollation: true`, which keeps character-column indexes usable) only after `assertMySqlBinaryCollation`. That check requires MySQL 8.0+ and a NO PAD binary collation: it rejects PAD SPACE `utf8mb4_bin`, which treats `'a'` and `'a '` as equal. To migrate, run `ALTER TABLE t MODIFY c VARCHAR(n) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin` (keep the column's existing type and nullability). Temporal, enum, and numeric columns compare natively ([predicates](../spec/persistence/predicates.md#temporal-columns)). Repositories put predicates in WHERE through `compileWhere`, which keeps comparisons visible to the planner; `compile` wraps the root in `COALESCE(..., FALSE)` for callers that negate or project it. A custom `predicateCompiler` passed to a repository only needs `compile`; repositories use its `compileWhere` when it has one. A `DrizzlePredicateCompiler` subclass that overrides `compile` keeps control of WHERE clauses, because the inherited `compileWhere` then delegates to the override. Every compiler must pass the shared differential tests in `packages/testing/integration/shared/predicateParity.ts` and `richParity.ts`.
- **Job release.** Implement `JobStore.release` so a worker can hand back a job it cannot run without consuming an attempt.
- **Outbox provenance.** Give outbox tables a `provenance` column; sinks write it as framework-owned data.
- **Schemas.** Store constructors take the schema (and table names where needed) explicitly; nothing defaults to a test schema.
