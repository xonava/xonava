import { ConfigurationError } from "./errors.js"
import { encodeExecutionScopeId, executionScopesEqual, isAuthorityNarrowing, type ExecutionScope, type ExecutionScopeId } from "./executionScope.js"
import { assertPrincipal, isRfc3339UtcInstant, type ExecutionIdentity, type Principal } from "./principal.js"

export interface ScopedAuthorityTarget { readonly scope: ExecutionScope; readonly scopeId: ExecutionScopeId }
export interface PersistenceAuthorityIdentity { readonly target: ScopedAuthorityTarget }

export type AuthorityOrigin =
  | { readonly kind: "bootstrap"; readonly bootstrapKey: string }
  | { readonly kind: "route"; readonly routeKey: string }
  | { readonly kind: "authority"; readonly target: ScopedAuthorityTarget }

export interface PolicyEvidence {
  readonly policyKey: string
  readonly policyVersion: number
  readonly policyDigest: string
  readonly evaluatedAt: string
  readonly authorizationModel: "snapshot" | "continuous"
}

export interface DelegationHop {
  readonly grantId: string
  readonly issuer: Principal
  readonly source: AuthorityOrigin
  readonly target: ScopedAuthorityTarget
  readonly purpose: string
  readonly reason: string
  readonly issuedAt: string
  readonly expiresAt?: string
  readonly policy: PolicyEvidence
  readonly permittedOperationKeys?: readonly string[]
  readonly permittedActions?: readonly string[]
  readonly permittedResourceIds?: readonly string[]
  readonly revocation:
    | { readonly kind: "not-revocable-before-expiry" }
    | { readonly kind: "authoritative-store"; readonly verifierKey: string; readonly grantVersion: string }
}

export interface AuthorityGrant {
  readonly grantId: string
  readonly source: AuthorityOrigin
  readonly target: ScopedAuthorityTarget
  readonly purpose: string
  readonly reason: string
  readonly issuedAt: string
  readonly expiresAt?: string
  readonly policy: PolicyEvidence
  readonly delegationChain: readonly DelegationHop[]
  readonly impersonation:
    | { readonly kind: "none" }
    | { readonly kind: "explicit"; readonly actorId: string; readonly subjectId: string; readonly grantId: string }
}

export interface AuthorityProvenance {
  readonly identity: ExecutionIdentity
  readonly grant: AuthorityGrant
  readonly correlationId: string
  readonly causationId?: string
}

export interface DurableAuthorityProvenanceV1 {
  readonly format: "framework.authority-provenance"
  readonly formatVersion: 1
  readonly actor: Principal
  readonly subject: Principal
  readonly source: AuthorityOrigin
  readonly target: ScopedAuthorityTarget
  readonly grantId: string
  readonly purpose: string
  readonly reason: string
  readonly delegationChain: readonly DelegationHop[]
  readonly policy: PolicyEvidence
  readonly issuedAt: string
  readonly expiresAt?: string
  readonly correlationId: string
  readonly causationId?: string
}

function nonBlank(value: string, field: string): void {
  if (value.trim().length === 0) throw new ConfigurationError(`${field} must be non-empty`)
}

function assertTarget(target: ScopedAuthorityTarget, field: string): void {
  if (encodeExecutionScopeId(target.scope) !== target.scopeId) throw new ConfigurationError(`${field} scope identity mismatch`)
}

function assertAuthorityOrigin(origin: AuthorityOrigin, field: string): void {
  if (origin.kind === "bootstrap") {
    nonBlank(origin.bootstrapKey, `${field}.bootstrapKey`)
    return
  }
  if (origin.kind === "route") {
    nonBlank(origin.routeKey, `${field}.routeKey`)
    return
  }
  assertTarget(origin.target, `${field}.target`)
}

function targetsEqual(left: ScopedAuthorityTarget, right: ScopedAuthorityTarget): boolean {
  return left.scopeId === right.scopeId && executionScopesEqual(left.scope, right.scope)
}

function originsEqual(left: AuthorityOrigin, right: AuthorityOrigin): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === "bootstrap" && right.kind === "bootstrap") return left.bootstrapKey === right.bootstrapKey
  if (left.kind === "route" && right.kind === "route") return left.routeKey === right.routeKey
  return left.kind === "authority" && right.kind === "authority" && targetsEqual(left.target, right.target)
}

function principalsEqual(left: Principal, right: Principal): boolean {
  return left.id === right.id && left.kind === right.kind
}

function assertPolicy(policy: PolicyEvidence): void {
  nonBlank(policy.policyKey, "policy.policyKey")
  nonBlank(policy.policyDigest, "policy.policyDigest")
  if (!Number.isSafeInteger(policy.policyVersion) || policy.policyVersion < 1) throw new ConfigurationError("policy.policyVersion must be a positive safe integer")
  if (!isRfc3339UtcInstant(policy.evaluatedAt)) throw new ConfigurationError("policy.evaluatedAt must be an RFC 3339 UTC instant")
}

export interface AuthorityValidationOptions {
  readonly routeKey?: string
  /** The compiled operation identity, when validation occurs at dispatch. */
  readonly operationKey?: string
  /** The concrete action being authorized, when a delegation narrows actions. */
  readonly action?: string
  /** Every concrete resource targeted by the action, when a delegation narrows resources. */
  readonly resourceIds?: readonly string[]
}

function assertDelegationRevocation(revocation: DelegationHop["revocation"]): void {
  if (!revocation || (revocation.kind !== "authoritative-store" && revocation.kind !== "not-revocable-before-expiry")) {
    throw new ConfigurationError("delegation revocation mode is invalid")
  }
  if (revocation.kind === "authoritative-store") {
    nonBlank(revocation.verifierKey, "delegation.revocation.verifierKey")
    nonBlank(revocation.grantVersion, "delegation.revocation.grantVersion")
  }
}

function assertDelegationRestriction(
  values: readonly string[] | undefined,
  field: "permittedOperationKeys" | "permittedActions" | "permittedResourceIds",
): void {
  if (values === undefined) return
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    throw new ConfigurationError(`delegation.${field} must contain only non-empty strings`)
  }
}

function assertDelegationRestrictions(hop: DelegationHop, options: AuthorityValidationOptions | undefined): void {
  assertDelegationRestriction(hop.permittedOperationKeys, "permittedOperationKeys")
  assertDelegationRestriction(hop.permittedActions, "permittedActions")
  assertDelegationRestriction(hop.permittedResourceIds, "permittedResourceIds")

  if (hop.permittedOperationKeys !== undefined) {
    if (options?.operationKey === undefined) throw new ConfigurationError("delegation operation restriction requires an operation key")
    if (!hop.permittedOperationKeys.includes(options.operationKey)) throw new ConfigurationError("delegation does not permit this operation")
  }
  if (hop.permittedActions !== undefined) {
    if (options?.action === undefined) throw new ConfigurationError("delegation action restriction requires an action")
    if (!hop.permittedActions.includes(options.action)) throw new ConfigurationError("delegation does not permit this action")
  }
  if (hop.permittedResourceIds !== undefined) {
    if (options?.resourceIds === undefined) throw new ConfigurationError("delegation resource restriction requires resource identities")
    if (options.resourceIds.length === 0) throw new ConfigurationError("delegation resource restriction does not permit an unspecified resource collection")
    if (options.resourceIds.some((resourceId) => typeof resourceId !== "string" || resourceId.trim().length === 0 || !hop.permittedResourceIds!.includes(resourceId))) {
      throw new ConfigurationError("delegation does not permit one or more resources")
    }
  }
}

export function assertAuthorityProvenance(
  provenance: AuthorityProvenance,
  scope: ExecutionScope,
  scopeId: ExecutionScopeId,
  now = new Date(),
  options?: AuthorityValidationOptions,
): void {
  assertPrincipal(provenance.identity.actor)
  assertPrincipal(provenance.identity.subject)
  nonBlank(provenance.correlationId, "authority.correlationId")
  const grant = provenance.grant
  nonBlank(grant.grantId, "grant.grantId")
  nonBlank(grant.purpose, "grant.purpose")
  nonBlank(grant.reason, "grant.reason")
  if (!isRfc3339UtcInstant(grant.issuedAt) || Date.parse(grant.issuedAt) > now.getTime()) throw new ConfigurationError("grant.issuedAt must be a valid time not in the future")
  if (grant.expiresAt && (!isRfc3339UtcInstant(grant.expiresAt) || Date.parse(grant.expiresAt) <= now.getTime())) throw new ConfigurationError("authority grant has expired or has an invalid expiry")
  if (options?.routeKey !== undefined && grant.source.kind === "route" && grant.source.routeKey !== options.routeKey) {
    throw new ConfigurationError("authority grant source route does not match request route")
  }
  assertPolicy(grant.policy)
  assertAuthorityOrigin(grant.source, "grant.source")
  assertTarget(grant.target, "grant.target")
  const requestTarget = { scope, scopeId }
  if (!targetsEqual(grant.target, requestTarget) || scopeId !== encodeExecutionScopeId(scope)) throw new ConfigurationError("request and authority target scope identity mismatch")
  if (grant.delegationChain.length > 1) throw new ConfigurationError("maximum delegation depth is one")
  if (grant.delegationChain[0] && !originsEqual(grant.delegationChain[0].source, grant.source)) throw new ConfigurationError("first delegation source does not match grant source")
  let preceding: ScopedAuthorityTarget | undefined
  for (const hop of grant.delegationChain) {
    nonBlank(hop.grantId, "delegation.grantId")
    nonBlank(hop.purpose, "delegation.purpose")
    nonBlank(hop.reason, "delegation.reason")
    assertPrincipal(hop.issuer)
    assertTarget(hop.target, "delegation.target")
    assertAuthorityOrigin(hop.source, "delegation.source")
    assertPolicy(hop.policy)
    assertDelegationRevocation(hop.revocation)
    if (!isRfc3339UtcInstant(hop.issuedAt) || Date.parse(hop.issuedAt) > now.getTime()) throw new ConfigurationError("delegation.issuedAt must be a valid time not in the future")
    if (hop.expiresAt && (!isRfc3339UtcInstant(hop.expiresAt) || Date.parse(hop.expiresAt) <= now.getTime())) throw new ConfigurationError("delegation has expired or has an invalid expiry")
    if (hop.expiresAt && grant.expiresAt && Date.parse(hop.expiresAt) > Date.parse(grant.expiresAt)) throw new ConfigurationError("delegation expiry cannot exceed grant expiry")
    assertDelegationRestrictions(hop, options)
    if (preceding && (hop.source.kind !== "authority" || !targetsEqual(hop.source.target, preceding))) throw new ConfigurationError("delegation chain is discontinuous")
    if (hop.source.kind === "authority" && !isAuthorityNarrowing(hop.source.target.scope, hop.target.scope)) throw new ConfigurationError("delegation cannot widen or rebind authority")
    preceding = hop.target
  }
  if (preceding && !targetsEqual(preceding, grant.target)) throw new ConfigurationError("delegation chain target does not match grant target")
  const { actor, subject } = provenance.identity
  if (principalsEqual(actor, subject)) {
    if (grant.impersonation.kind !== "none") throw new ConfigurationError("ordinary identity cannot contain impersonation evidence")
  } else {
    if (grant.impersonation.kind !== "explicit") throw new ConfigurationError("actor and subject differ without explicit impersonation")
    if (grant.impersonation.actorId !== actor.id || grant.impersonation.subjectId !== subject.id || grant.impersonation.grantId !== grant.grantId) throw new ConfigurationError("impersonation evidence does not match identity and grant")
    if (grant.delegationChain.some((hop) => hop.source.kind === "authority" && hop.source.target.scope.kind === "tenant")) throw new ConfigurationError("nested impersonation is forbidden")
  }
}

/**
 * Validates a persisted provenance record as a complete historical fact. Unlike
 * live authority validation, an expired grant remains valid provenance for an
 * event that was legitimately produced before expiry.
 */
export function assertDurableAuthorityProvenance(provenance: DurableAuthorityProvenanceV1): void {
  if (provenance.format !== "framework.authority-provenance" || provenance.formatVersion !== 1) {
    throw new ConfigurationError("durable authority provenance format is invalid")
  }
  assertPrincipal(provenance.actor)
  assertPrincipal(provenance.subject)
  nonBlank(provenance.grantId, "durable authority grantId")
  nonBlank(provenance.purpose, "durable authority purpose")
  nonBlank(provenance.reason, "durable authority reason")
  nonBlank(provenance.correlationId, "durable authority correlationId")
  if (!isRfc3339UtcInstant(provenance.issuedAt)) throw new ConfigurationError("durable authority issuedAt must be an RFC 3339 UTC instant")
  if (provenance.expiresAt && !isRfc3339UtcInstant(provenance.expiresAt)) throw new ConfigurationError("durable authority expiresAt must be an RFC 3339 UTC instant")
  assertTarget(provenance.target, "durable authority target")
  assertAuthorityOrigin(provenance.source, "durable authority source")
  assertPolicy(provenance.policy)
  if (provenance.delegationChain.length > 1) throw new ConfigurationError("maximum delegation depth is one")
  if (provenance.delegationChain[0] && !originsEqual(provenance.delegationChain[0].source, provenance.source)) {
    throw new ConfigurationError("first delegation source does not match durable authority source")
  }
  let preceding: ScopedAuthorityTarget | undefined
  for (const hop of provenance.delegationChain) {
    nonBlank(hop.grantId, "delegation.grantId")
    nonBlank(hop.purpose, "delegation.purpose")
    nonBlank(hop.reason, "delegation.reason")
    assertPrincipal(hop.issuer)
    assertTarget(hop.target, "delegation.target")
    assertAuthorityOrigin(hop.source, "delegation.source")
    assertPolicy(hop.policy)
    assertDelegationRevocation(hop.revocation)
    assertDelegationRestriction(hop.permittedOperationKeys, "permittedOperationKeys")
    assertDelegationRestriction(hop.permittedActions, "permittedActions")
    assertDelegationRestriction(hop.permittedResourceIds, "permittedResourceIds")
    if (!isRfc3339UtcInstant(hop.issuedAt)) throw new ConfigurationError("delegation.issuedAt must be an RFC 3339 UTC instant")
    if (hop.expiresAt && !isRfc3339UtcInstant(hop.expiresAt)) throw new ConfigurationError("delegation.expiresAt must be an RFC 3339 UTC instant")
    if (hop.expiresAt && provenance.expiresAt && Date.parse(hop.expiresAt) > Date.parse(provenance.expiresAt)) {
      throw new ConfigurationError("delegation expiry cannot exceed grant expiry")
    }
    if (preceding && (hop.source.kind !== "authority" || !targetsEqual(hop.source.target, preceding))) {
      throw new ConfigurationError("delegation chain is discontinuous")
    }
    if (hop.source.kind === "authority" && !isAuthorityNarrowing(hop.source.target.scope, hop.target.scope)) {
      throw new ConfigurationError("delegation cannot widen or rebind authority")
    }
    preceding = hop.target
  }
  if (preceding && !targetsEqual(preceding, provenance.target)) {
    throw new ConfigurationError("delegation chain target does not match durable authority target")
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

export function freezeAuthorityProvenance(provenance: AuthorityProvenance): AuthorityProvenance { return deepFreeze(provenance) }
