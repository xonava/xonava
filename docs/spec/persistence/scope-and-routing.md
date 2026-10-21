# Persistence scope and datasource routing

## Scope

Trusted scope contains application/tenant authority resolved before repository access. Mandatory row predicates are conjunctive with caller filters and MUST NOT be removable, weakened, or replaced by caller input.

### Platform and system entities

An entity declared with `entityScope: { kind: "platform" | "system", acknowledged: true }` has no tenant or application partition column and is served by the unwrapped provider. The adapters never read the entity scope. Isolation for such an entity comes only from the route's fixed scope plan and the optional `scopeFilter` predicate, which is ANDed into every list, detail, update and delete. A tenant-scoped provider MUST refuse an entity without a tenant field. Authorization for a platform route is the ABAC bundle; module entitlements are evaluated for tenant scope only.

Current rule, not a recommendation: the CRUD handlers guard tenant and application entities against the wrong route scope, but a platform entity is reachable from a system-scope or application-scope route as well as a platform one. Deployments SHOULD bind platform entities only to routes whose fixed scope is platform. See the [standalone application guide](../../guides/standalone-application.md).

## Routing requirements

A datasource route binds a trusted datasource identity and authority. Routing MUST reject caller-selected sources not authorized by the compiled plan. Required read consistency and transaction/capability needs MUST be checked before execution. Cross-source reads MUST declare consistency and partial-failure behavior; cross-source atomicity MUST NOT be implied without a coordinating guarantee.

## Security and errors

Scope encoding MUST be canonical for identity/idempotency use. Missing/malformed scope is validation or authorization failure. An unavailable authorized source is a dependency failure; an unauthorized source is authorization failure without topology disclosure.

## Conformance

Test tenant isolation, hostile filters, scope-field overwrite, datasource substitution, consistency rejection, and independent verification connections.
