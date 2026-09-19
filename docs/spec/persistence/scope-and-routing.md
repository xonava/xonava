# Persistence scope and datasource routing

## Scope

Trusted scope contains application/tenant authority resolved before repository access. Mandatory row predicates are conjunctive with caller filters and MUST NOT be removable, weakened, or replaced by caller input.

## Routing requirements

A datasource route binds a trusted datasource identity and authority. Routing MUST reject caller-selected sources not authorized by the compiled plan. Required read consistency and transaction/capability needs MUST be checked before execution. Cross-source reads MUST declare consistency and partial-failure behavior; cross-source atomicity MUST NOT be implied without a coordinating guarantee.

## Security and errors

Scope encoding MUST be canonical for identity/idempotency use. Missing/malformed scope is validation or authorization failure. An unavailable authorized source is a dependency failure; an unauthorized source is authorization failure without topology disclosure.

## Conformance

Test tenant isolation, hostile filters, scope-field overwrite, datasource substitution, consistency rejection, and independent verification connections.
