export const CANONICAL_TERMS = [
  {
    term: "Principal",
    definition:
      "The normalized human, service, system, or explicit anonymous identity participating in execution",
    securityAuthority: false,
    durable: false,
  },
  {
    term: "Actor",
    definition: "The real identity causing the action",
    securityAuthority: true,
    durable: true,
  },
  {
    term: "Subject",
    definition:
      "The identity whose permissions are being evaluated, especially during impersonation",
    securityAuthority: true,
    durable: true,
  },
  {
    term: "ExecutionScope",
    definition:
      "The data/security boundary in which execution occurs: application, tenant, platform, or system",
    securityAuthority: true,
    durable: true,
  },
  {
    term: "RouteExposure",
    definition: "Whether a transport route is public or authenticated",
    securityAuthority: false,
    durable: false,
  },
  {
    term: "AuthorityGrant",
    definition:
      "Why the principal is allowed to enter the execution scope, including delegation/impersonation provenance",
    securityAuthority: true,
    durable: true,
  },
  {
    term: "PersistenceAuthority",
    definition: "The actual storage capability object available to an execution plan",
    securityAuthority: true,
    durable: false,
  },
  {
    term: "DatasourceKey",
    definition: "Logical persistence target such as primary, reporting, or audit",
    securityAuthority: false,
    durable: true,
  },
  {
    term: "ReadConsistency",
    definition: "Required read guarantee",
    securityAuthority: false,
    durable: true,
  },
  {
    term: "CompiledFrameworkPlan",
    definition:
      "Immutable startup-validated global registry containing all compiled definitions, routes, datasource/security/guarantee/format/readiness/runtime-binding artifacts",
    securityAuthority: true,
    durable: false,
  },
  {
    term: "AuthorizedExecutionPlan",
    definition:
      "Per-execution immutable authorization result constraining one operation/query/mutation to its verified identity, scope, fields, predicates, obligations and datasource authority",
    securityAuthority: true,
    durable: true,
  },
  {
    term: "Route",
    definition: "Transport exposure of a compiled operation/entity/read model",
    securityAuthority: false,
    durable: false,
  },
] as const

export type CanonicalTerm = (typeof CANONICAL_TERMS)[number]["term"]

export const FORBIDDEN_SCOPE_OVERLOADS = [
  "route exposure",
  "module scope",
  "tenant selection",
  "arbitrary namespacing",
] as const
