# Provider and repository

## Scope and data model

A provider exposes repository construction and execution facilities plus an immutable capability declaration. A repository binds one compiled entity, datasource, trusted scope, and provider. Entity identity, version, scope columns, readable/writable fields, predicates, ordering, and limits derive from the compiled plan.

## Read requirements

Single lookup MUST return one authorized scoped row or explicit absence. It MUST NOT distinguish nonexistent from existing-but-forbidden rows to an unauthorized caller. List/query MUST enforce budget, projection, deterministic ordering, and bounds. Returned fields MUST obey field visibility after row authorization.

## Mutation requirements

Create MUST enforce scope-derived fields and reject caller attempts to override trusted scope. Update/delete MUST condition on identity, mandatory scope, authorization predicates, lifecycle rules, and expected version where versioned. A zero-row conditional result maps to absence or conflict only according to a non-leaking, authorized decision process. Successful versioned mutation advances version exactly once.

## Capabilities and lifecycle

Construction MUST validate required provider features before handling traffic. Optional operations MUST be absent or return capability failure; they MUST NOT silently use weaker behavior. Resources acquired for transactions/streams MUST be released on success, error, cancellation, and timeout.

## Conformance

Test creation, authorized/forbidden reads, projection, scope injection, conditional mutation, stale versions, lifecycle transitions, affected-row normalization, and resource cleanup against a real provider.
