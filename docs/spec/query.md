# Query

## Scope and data model

A query plan declares filters, ordering, projection, pagination, budget, consistency, and optional search. Inputs MUST be validated against allowed fields/operators and complexity limits. Providers MUST NOT accept raw provider expressions as trusted query semantics.

Filters are typed predicate trees with bounded depth/nodes/operators. Sort entries identify allowed fields and direction. Projection is a requested field set intersected with authorized visibility. Budget bounds result count and semantic complexity; exceeding an output-row budget MUST fail explicitly and MUST NOT silently truncate an otherwise complete result. Search is OPTIONAL and MUST declare provider behavior/ranking guarantees. Search results MUST be validated for result count, consistency, identifiers, finite scores, totals, and authorized returned fields before reaching application code.

## Ordering and pagination

Ordering used for pagination MUST be deterministic and include a stable tie-breaker. A cursor MUST be bound to the relevant plan/scope and integrity protected where required; invalid, tampered, or mismatched cursors MUST be rejected. Projection MUST not disclose unauthorized fields. Offset pagination MAY be supported only when declared; cursor/keyset semantics remain distinct.

Forward/backward traversal MUST define comparison direction while returning results in the requested stable order. Cursor expiry, key rotation, version, and binding checks occur before position use. See [cursor](query/cursor.md).

## Errors and conformance

Unknown/forbidden fields, operators, sort/projection entries, over-budget plans, invalid consistency, and malformed cursors are validation or authorization failures as appropriate. Unsupported search/consistency is capability failure. Conformance covers normalization, budgets, hostile predicates, field disclosure, stable ties, page gaps/duplicates, both directions, tampering, expiry, and provider equivalence.

Traceability: `packages/core/src/query`; shared/provider pagination and cursor tests; Q1/Q2 certification.
