export const ROUTE_EXPOSURES = ["authenticated", "public"] as const

export type RouteExposure = (typeof ROUTE_EXPOSURES)[number]

export const SCOPE_RESOLUTION_KINDS = ["fixed", "resolver"] as const

export type ScopeResolutionKind = (typeof SCOPE_RESOLUTION_KINDS)[number]

export const UNTRUSTED_SCOPE_INPUT_SOURCES = [
  "query",
  "body",
  "cursor",
] as const

export type UntrustedScopeInputSource = (typeof UNTRUSTED_SCOPE_INPUT_SOURCES)[number]

export const ROUTE_INVARIANTS = {
  routeExposureIsTransportPolicyOnly: true,
  routeExposureNeverSelectsDataAuthority: true,
  publicRouteNeverGrantsTenantPlatformOrSystemAuthority: true,
  queryBodyAndCursorValuesNeverDirectlyBecomeExecutionScope: true,
  hostAndPathTenantSlugsAreUntrustedLookupKeysOnly: true,
  resolverResultOutsideAllowedTargetKindsIsRejected: true,
  authorizationPlanStillDecidesPrincipalExecution: true,
} as const

export const ROUTE_BINDING_CONTRACT = {
  compiledBindingRequired: true,
  operationReferenceRequired: true,
  exposureIsNotAuthority: true,
  resolutionPlanKinds: SCOPE_RESOLUTION_KINDS,
  resolverReceivesCompiledRouteReference: true,
  resolvedKindMustBeAllowed: true,
  resolvedScopeIdMustBeCanonical: true,
} as const
