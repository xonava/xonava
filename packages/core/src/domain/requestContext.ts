import { ConfigurationError, ForbiddenError } from "./errors.js"
import { assertAuthorityProvenance, type AuthorityProvenance, type AuthorityValidationOptions, type DelegationHop } from "./authority.js"
import { encodeExecutionScopeId, type ExecutionScope, type ExecutionScopeId } from "./executionScope.js"
import { isRfc3339UtcInstant, type ExecutionIdentity } from "./principal.js"
import type { CompiledRouteBindingRef } from "./routeExposure.js"
import { cloneAndFreezeDefinition } from "../kernel/definitionIntegrity"
import { snapshotData } from "../kernel/snapshotData"

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
  if (typeof context.requestId !== "string" || context.requestId.trim().length === 0) throw new ConfigurationError("requestId must be non-empty")
  if (typeof context.correlationId !== "string" || context.correlationId.trim().length === 0) throw new ConfigurationError("correlationId must be non-empty")
  if (context.authority.correlationId !== context.correlationId) throw new ConfigurationError("request and authority correlationId mismatch")
  if (context.authority.causationId !== context.causationId) throw new ConfigurationError("request and authority causationId mismatch")
  if (
    context.authority.identity.actor.id !== context.identity.actor.id ||
    context.authority.identity.actor.kind !== context.identity.actor.kind ||
    context.authority.identity.subject.id !== context.identity.subject.id ||
    context.authority.identity.subject.kind !== context.identity.subject.kind
  ) throw new ConfigurationError("request and authority identity mismatch")
  if (context.scopeId !== encodeExecutionScopeId(context.scope)) throw new ConfigurationError("request scope identity mismatch")
  if (typeof context.route.routeKey !== "string" || typeof context.route.operationKey !== "string" || context.route.routeKey.trim().length === 0 || context.route.operationKey.trim().length === 0 || !Number.isSafeInteger(context.route.definitionVersion) || context.route.definitionVersion < 1) throw new ConfigurationError("route binding reference is invalid")
  if (context.deadline !== undefined && (typeof context.deadline !== "string" || !isRfc3339UtcInstant(context.deadline))) throw new ConfigurationError("deadline must be an RFC 3339 UTC instant")
  if (context.delegationTarget?.action !== undefined && (typeof context.delegationTarget.action !== "string" || context.delegationTarget.action.trim().length === 0)) {
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

const REQUEST_CONTEXT_KEYS = new Set([
  "requestId", "correlationId", "causationId", "identity", "scope", "scopeId", "authority", "route",
  "delegationTarget", "signal", "deadline", "locale", "timezone", "traceContext", "metadata",
])
const REQUIRED_REQUEST_CONTEXT_KEYS = ["requestId", "correlationId", "identity", "scope", "scopeId", "authority", "route", "signal"] as const

function snapshotRequestContext(context: RequestContext): RequestContext {
  if (!context || typeof context !== "object" || Array.isArray(context) || (Object.getPrototypeOf(context) !== Object.prototype && Object.getPrototypeOf(context) !== null)) {
    throw new ConfigurationError("request context must be a plain object")
  }
  if (Object.getOwnPropertySymbols(context).length > 0) throw new ConfigurationError("request context cannot contain symbol keys")
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of Object.getOwnPropertyNames(context)) {
    if (!REQUEST_CONTEXT_KEYS.has(key)) throw new ConfigurationError(`unknown request context field: ${key}`)
    const descriptor = Object.getOwnPropertyDescriptor(context, key)
    if (!descriptor || !("value" in descriptor)) throw new ConfigurationError(`request context field ${key} must be a data property`)
    values[key] = descriptor.value
  }
  for (const key of REQUIRED_REQUEST_CONTEXT_KEYS) if (!Object.hasOwn(values, key)) throw new ConfigurationError(`request context field ${key} is required`)
  const signal = values.signal
  if (!signal || typeof signal !== "object" || typeof (signal as AbortSignal).aborted !== "boolean" || typeof (signal as AbortSignal).addEventListener !== "function" || typeof (signal as AbortSignal).removeEventListener !== "function") {
    throw new ConfigurationError("request context signal must be an AbortSignal")
  }
  const security = cloneAndFreezeDefinition({
    identity: values.identity,
    scope: values.scope,
    authority: values.authority,
    route: values.route,
    ...(values.delegationTarget !== undefined ? { delegationTarget: values.delegationTarget } : {}),
  }, true) as Pick<RequestContext, "identity" | "scope" | "authority" | "route" | "delegationTarget">
  const traceContext = values.traceContext === undefined ? undefined : snapshotData(values.traceContext, { label: "Request trace context" }) as Readonly<Record<string, string>>
  if (traceContext !== undefined) {
    for (const [key, value] of Object.entries(traceContext)) if (key.trim().length === 0 || typeof value !== "string") throw new ConfigurationError("request trace context must contain non-empty keys and string values")
  }
  const metadata = values.metadata === undefined ? undefined : snapshotData(values.metadata, { label: "Request metadata" }) as Readonly<Record<string, unknown>>
  if (metadata !== undefined && (!metadata || typeof metadata !== "object" || Array.isArray(metadata))) throw new ConfigurationError("request metadata must be a record")
  return Object.freeze({
    requestId: values.requestId,
    correlationId: values.correlationId,
    ...(values.causationId !== undefined ? { causationId: values.causationId } : {}),
    ...security,
    scopeId: values.scopeId,
    signal: signal as AbortSignal,
    ...(values.deadline !== undefined ? { deadline: values.deadline } : {}),
    ...(values.locale !== undefined ? { locale: values.locale } : {}),
    ...(values.timezone !== undefined ? { timezone: values.timezone } : {}),
    ...(traceContext !== undefined ? { traceContext } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  } as RequestContext)
}

export function assertRequestContext(context: RequestContext, now = new Date()): void {
  assertRequestContextBase(context, now)
  if (authoritativeStoreHops(context).length > 0) {
    throw new ConfigurationError("authoritative-store delegations require asynchronous revocation verification")
  }
}

export function freezeRequestContext(context: RequestContext, now = new Date()): RequestContext {
  context = snapshotRequestContext(context)
  assertRequestContext(context, now)
  return context
}

/** Creates a live request context only after every revocable delegation is checked. */
export async function freezeVerifiedRequestContext(
  context: RequestContext,
  verifyDelegationRevocation: DelegationRevocationVerifier | undefined,
  now = new Date(),
): Promise<RequestContext> {
  context = snapshotRequestContext(context)
  assertRequestContextBase(context, now)
  for (const hop of authoritativeStoreHops(context)) {
    if (!verifyDelegationRevocation) throw new ConfigurationError("authoritative-store delegation requires a revocation verifier")
    if ((await verifyDelegationRevocation(hop)) !== true) throw new ForbiddenError("delegation has been revoked")
  }
  return context
}
