import { ConfigurationError, ForbiddenError } from "./errors.js"
import { assertAuthorityProvenance, freezeAuthorityProvenance, type AuthorityProvenance, type AuthorityValidationOptions, type DelegationHop } from "./authority.js"
import { encodeExecutionScopeId, type ExecutionScope, type ExecutionScopeId } from "./executionScope.js"
import { isRfc3339UtcInstant, type ExecutionIdentity } from "./principal.js"
import type { CompiledRouteBindingRef } from "./routeExposure.js"
import { cloneAndFreezeDefinition } from "../kernel/definitionIntegrity"

export interface RequestContext {
  readonly requestId: string
  readonly correlationId: string
  readonly causationId?: string
  readonly identity: ExecutionIdentity
  readonly scope: ExecutionScope
  readonly scopeId: ExecutionScopeId
  readonly authority: AuthorityProvenance
  readonly route: CompiledRouteBindingRef
  /** Required when a delegation narrows the request to concrete actions or resources. */
  readonly delegationTarget?: Pick<AuthorityValidationOptions, "action" | "resourceIds">
  readonly signal: AbortSignal
  readonly deadline?: string
  readonly locale?: string
  readonly timezone?: string
  readonly traceContext?: Readonly<Record<string, string>>
  readonly metadata?: Readonly<Record<string, unknown>>
}

export type AuthoritativeStoreDelegationHop = DelegationHop & {
  readonly revocation: { readonly kind: "authoritative-store"; readonly verifierKey: string; readonly grantVersion: string }
}
export type DelegationRevocationVerifier = (hop: AuthoritativeStoreDelegationHop) => Promise<boolean>

function authoritativeStoreHops(context: RequestContext): AuthoritativeStoreDelegationHop[] {
  return context.authority.grant.delegationChain.filter(
    (hop): hop is AuthoritativeStoreDelegationHop => hop.revocation.kind === "authoritative-store",
  )
}

function assertRequestContextBase(context: RequestContext, now: Date): void {
  if (context.requestId.trim().length === 0) throw new ConfigurationError("requestId must be non-empty")
  if (context.correlationId.trim().length === 0) throw new ConfigurationError("correlationId must be non-empty")
  if (context.authority.correlationId !== context.correlationId) throw new ConfigurationError("request and authority correlationId mismatch")
  if (context.authority.causationId !== context.causationId) throw new ConfigurationError("request and authority causationId mismatch")
  if (
    context.authority.identity.actor.id !== context.identity.actor.id ||
    context.authority.identity.actor.kind !== context.identity.actor.kind ||
    context.authority.identity.subject.id !== context.identity.subject.id ||
    context.authority.identity.subject.kind !== context.identity.subject.kind
  ) throw new ConfigurationError("request and authority identity mismatch")
  if (context.scopeId !== encodeExecutionScopeId(context.scope)) throw new ConfigurationError("request scope identity mismatch")
  if (context.route.routeKey.trim().length === 0 || context.route.operationKey.trim().length === 0 || !Number.isSafeInteger(context.route.definitionVersion) || context.route.definitionVersion < 1) throw new ConfigurationError("route binding reference is invalid")
  if (context.deadline && !isRfc3339UtcInstant(context.deadline)) throw new ConfigurationError("deadline must be an RFC 3339 UTC instant")
  if (context.delegationTarget?.action !== undefined && context.delegationTarget.action.trim().length === 0) {
    throw new ConfigurationError("delegation target action must be non-empty")
  }
  if (context.delegationTarget?.resourceIds !== undefined && context.delegationTarget.resourceIds.some((resourceId) => typeof resourceId !== "string" || resourceId.trim().length === 0)) {
    throw new ConfigurationError("delegation target resource identities must be non-empty strings")
  }
  assertAuthorityProvenance(context.authority, context.scope, context.scopeId, now, {
    routeKey: context.route.routeKey,
    operationKey: context.route.operationKey,
    ...(context.delegationTarget?.action !== undefined ? { action: context.delegationTarget.action } : {}),
    ...(context.delegationTarget?.resourceIds !== undefined ? { resourceIds: context.delegationTarget.resourceIds } : {}),
  })
}

export function assertRequestContext(context: RequestContext, now = new Date()): void {
  assertRequestContextBase(context, now)
  if (authoritativeStoreHops(context).length > 0) {
    throw new ConfigurationError("authoritative-store delegations require asynchronous revocation verification")
  }
}

function freezeValidatedRequestContext(context: RequestContext): RequestContext {
  freezeAuthorityProvenance(context.authority)
  Object.freeze(context.identity.actor.authentication)
  Object.freeze(context.identity.subject.authentication)
  Object.freeze(context.identity.actor)
  Object.freeze(context.identity.subject)
  Object.freeze(context.identity)
  Object.freeze(context.scope)
  Object.freeze(context.route)
  if (context.delegationTarget) {
    if (context.delegationTarget.resourceIds) Object.freeze(context.delegationTarget.resourceIds)
    Object.freeze(context.delegationTarget)
  }
  if (context.traceContext) Object.freeze(context.traceContext)
  if (context.metadata) Object.freeze(context.metadata)
  return Object.freeze(context)
}

export function freezeRequestContext(context: RequestContext, now = new Date()): RequestContext {
  assertRequestContext(context, now)
  return freezeValidatedRequestContext(context)
}

/** Creates a live request context only after every revocable delegation is checked. */
export async function freezeVerifiedRequestContext(
  context: RequestContext,
  verifyDelegationRevocation: DelegationRevocationVerifier | undefined,
  now = new Date(),
): Promise<RequestContext> {
  const snapshot = cloneAndFreezeDefinition({
    authority: context.authority,
    identity: context.identity,
    scope: context.scope,
    route: context.route,
    ...(context.delegationTarget !== undefined ? { delegationTarget: context.delegationTarget } : {}),
  }, true)
  context = Object.freeze({ ...context, ...snapshot })
  assertRequestContextBase(context, now)
  for (const hop of authoritativeStoreHops(context)) {
    if (!verifyDelegationRevocation) throw new ConfigurationError("authoritative-store delegation requires a revocation verifier")
    if ((await verifyDelegationRevocation(hop)) !== true) throw new ForbiddenError("delegation has been revoked")
  }
  return freezeValidatedRequestContext(context)
}
