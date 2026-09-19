export const DEFAULT_MAX_DELEGATION_DEPTH = 1

export const DELEGATION_REVOCATION_MODELS = [
  "not-revocable-before-expiry",
  "authoritative-store",
] as const

export type DelegationRevocationModel = (typeof DELEGATION_REVOCATION_MODELS)[number]

export const GRANT_AUTHORIZATION_MODELS = [
  "snapshot",
  "continuous",
] as const

export type GrantAuthorizationModel = (typeof GRANT_AUTHORIZATION_MODELS)[number]

export const IMPERSONATION_KINDS = ["none", "explicit"] as const

export type ImpersonationKind = (typeof IMPERSONATION_KINDS)[number]

export const DELEGATION_INVARIANTS = {
  nestedImpersonationForbidden: true,
  grantsAreImmutableOnceCreated: true,
  applicationHandlersCannotConstructTrustedAuthorityGrants: true,
  purposeBindingIsRequired: true,
  expiredGrantsRejectedBeforeExecution: true,
  revocationNeverRewritesHistoricalProvenance: true,
  durablePropagationNeverStoresAuthenticationSecrets: true,
} as const

export const DELEGATION_LIFECYCLE = [
  "issue",
  "validate",
  "use",
  "expire",
] as const

export const DELEGATION_VALIDATION_REQUIREMENTS = [
  "issuer-authority",
  "target-scope",
  "purpose",
  "validity-window",
  "depth",
  "revocation-status",
  "actor-continuity",
] as const
