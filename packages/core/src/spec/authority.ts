export const EXECUTION_SCOPE_KINDS = [
  "application",
  "tenant",
  "platform",
  "system",
] as const

export type ExecutionScopeKind = (typeof EXECUTION_SCOPE_KINDS)[number]

export const PRINCIPAL_KINDS = [
  "human",
  "service",
  "system",
  "anonymous",
] as const

export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number]

export const AUTHORITY_ORIGINS = [
  "bootstrap",
  "route",
  "authority",
] as const

export type AuthorityOriginKind = (typeof AUTHORITY_ORIGINS)[number]

export type AuthorityNodeKind =
  | "root"
  | ExecutionScopeKind
  | "delegated-tenant"

export interface AuthorityTransition {
  readonly from: AuthorityNodeKind
  readonly to: AuthorityNodeKind
  readonly mechanism: "bootstrap-resolution" | "explicit-delegation"
}

export const AUTHORITY_LATTICE_TRANSITIONS: readonly AuthorityTransition[] = [
  { from: "root", to: "application", mechanism: "bootstrap-resolution" },
  { from: "root", to: "tenant", mechanism: "bootstrap-resolution" },
  { from: "root", to: "platform", mechanism: "bootstrap-resolution" },
  { from: "root", to: "system", mechanism: "bootstrap-resolution" },
  { from: "platform", to: "delegated-tenant", mechanism: "explicit-delegation" },
  { from: "system", to: "delegated-tenant", mechanism: "explicit-delegation" },
]

export const EXECUTION_SCOPE_ID_PREFIX = "fscope:v1:"

export const AUTHORITY_INVARIANTS = {
  publicIsNeverAnExecutionScopeKind: true,
  platformAndSystemAreNeverImplicitTenantWildcards: true,
  tenantAuthorityCanNeverRebindToAnotherTenant: true,
  applicationAuthorityCannotConvertToTenantOrPlatformAtRuntime: true,
  scopeIdMismatchRejectsBeforeDataAccess: true,
  bootstrapOriginIsNeverPassedAsUnrestrictedPersistenceAuthority: true,
} as const

export const AUTHORITY_PROVENANCE_FORMAT = {
  format: "framework.authority-provenance",
  version: 1,
  recordsActorAndSubject: true,
  recordsScopeAndScopeId: true,
  recordsAuthorityOrigin: true,
  recordsDelegationChain: true,
  authenticationSecretsPermitted: false,
} as const

export function transitionsFrom(kind: AuthorityNodeKind): readonly AuthorityTransition[] {
  return AUTHORITY_LATTICE_TRANSITIONS.filter((transition) => transition.from === kind)
}

export function isExplicitDelegation(transition: AuthorityTransition): boolean {
  return transition.mechanism === "explicit-delegation"
}
