export const AUTHORIZATION_SEQUENCE = [
  "normalize-principal",
  "match-compiled-route",
  "resolve-execution-scope",
  "validate-authority-grant",
  "authorize-operation",
  "attenuate-persistence",
  "prepare-operation",
  "perform-operation",
] as const

export type AuthorizationSequenceStep = (typeof AUTHORIZATION_SEQUENCE)[number]

export const AUTHORIZATION_SEQUENCE_INVARIANTS = {
  noDataAccessBeforeScopeAndGrantValidation: true,
  noMutationBeforeAuthorization: true,
  authorizationReceivesReadOnlyDeclaredResourcesOnly: true,
  persistenceIsAttenuatedBeforePreparation: true,
  compiledRouteBindingIsMandatory: true,
  requestInputNeverConstructsAuthority: true,
} as const
