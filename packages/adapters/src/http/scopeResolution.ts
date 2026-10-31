import {
  ConfigurationError,
  encodeExecutionScopeId,
  executionScopesEqual,
  freezeVerifiedRequestContext,
  isAuthorityNarrowing,
  type AuthorityOrigin,
  type DelegationRevocationVerifier,
  type ExecutionIdentity,
  type ExecutionScope,
  type ExecutionScopeId,
  ForbiddenError,
  type RequestContext,
  UnauthorizedError,
} from "@xonava/core/domain"
import {
  compiledRouteBindingRef,
  type CompiledRouteBinding,
  type CompiledScopeResolverBinding,
} from "@xonava/core/bootstrap"
import { resolveVerifiedScope, type UntrustedScopeResolutionInput } from "@xonava/core/security"
import type { ScopeAdmissionEvidence, TrustedFrameworkSession } from "../server/frameworkAdapterDeps.js"

export type { ScopeAdmissionEvidence, TrustedFrameworkSession } from "../server/frameworkAdapterDeps.js"

export interface NormalizeFrameworkRequestInput {
  readonly requestId: string
  readonly correlationId: string
  readonly causationId?: string
  readonly route: CompiledRouteBinding
  readonly resolverBindings: ReadonlyMap<string, CompiledScopeResolverBinding>
  readonly session?: TrustedFrameworkSession
  readonly admit: (resolved: {
    readonly route: CompiledRouteBinding
    readonly identity: ExecutionIdentity
    readonly scope: ExecutionScope
    readonly scopeId: ExecutionScopeId
  }) => Promise<ScopeAdmissionEvidence>
  readonly signal: AbortSignal
  readonly deadline?: string
  readonly locale?: string
  readonly timezone?: string
  readonly traceContext?: Readonly<Record<string, string>>
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly host?: string
  readonly pathParameters?: Readonly<Record<string, string>>
  readonly headers?: Readonly<Record<string, string>>
  readonly now?: Date
  /** Required whenever admission contains a grant revocable through an authoritative store. */
  readonly verifyDelegationRevocation?: DelegationRevocationVerifier
}

function resolverInput(input: NormalizeFrameworkRequestInput): UntrustedScopeResolutionInput {
  return Object.freeze({
    ...(input.host === undefined ? {} : { host: input.host }),
    ...(input.pathParameters === undefined ? {} : { pathParameters: Object.freeze({ ...input.pathParameters }) }),
    ...(input.headers === undefined ? {} : { headers: Object.freeze({ ...input.headers }) }),
    ...(input.session?.resolverFacts === undefined ? {} : { sessionFacts: Object.freeze({ ...input.session.resolverFacts }) }),
  })
}

/**
 * An absent session on an authenticated route that cannot fall back to an
 * anonymous principal is a failed login (401), not a configuration fault.
 */
function missingSessionError(route: CompiledRouteBinding): Error {
  if (route.anonymousPrincipal.allowed) return new ConfigurationError("authenticated route requires a trusted session")
  return new UnauthorizedError()
}

async function resolveScope(input: NormalizeFrameworkRequestInput): Promise<ExecutionScope> {
  const plan = input.route.scopeResolution
  if (plan.kind === "fixed") {
    if (input.route.exposure === "public") throw new ConfigurationError("public route cannot use a fixed execution scope")
    if (!input.session) throw missingSessionError(input.route)
    // A valid session for another scope (for example a tenant user on a platform route) is a caller that may not use
    // this route, not a misconfiguration: refuse it as forbidden instead of answering 500.
    if (!executionScopesEqual(input.session.scope, plan.scope)) throw new ForbiddenError("session and fixed route scope mismatch")
    return plan.scope
  }
  const binding = input.resolverBindings.get(plan.resolverKey)
  if (!binding) throw new ConfigurationError(`missing compiled scope resolver binding ${plan.resolverKey}`)
  return (await resolveVerifiedScope({ route: input.route, input: resolverInput(input), binding })).scope
}

function resolveIdentity(input: NormalizeFrameworkRequestInput): ExecutionIdentity {
  if (input.route.exposure === "public") {
    if (input.session) throw new ConfigurationError("public route cannot inherit authenticated session authority")
    if (!input.route.anonymousPrincipal.allowed) throw new ConfigurationError("public route has no compiled anonymous principal")
    const actor = input.route.anonymousPrincipal.principal
    if (actor.kind !== "anonymous") throw new ConfigurationError("public route principal must be anonymous")
    return Object.freeze({ actor, subject: actor })
  }
  if (!input.session) throw missingSessionError(input.route)
  return input.session.identity
}

export async function normalizeFrameworkRequest(input: NormalizeFrameworkRequestInput): Promise<RequestContext> {
  const identity = resolveIdentity(input)
  const scope = await resolveScope(input)
  const scopeId = encodeExecutionScopeId(scope)
  const admission = await input.admit({ route: input.route, identity, scope, scopeId })
  const target = Object.freeze({ scope: Object.freeze({ ...scope }), scopeId })
  if (input.session && !executionScopesEqual(input.session.scope, scope)) {
    if (!isAuthorityNarrowing(input.session.scope, scope)) {
      throw new ConfigurationError("trusted session authority cannot widen or rebind to resolved scope")
    }
    if (!admission.delegationChain?.length) {
      throw new ConfigurationError("scope attenuation requires compiled delegation evidence")
    }
  }
  const sessionTarget = input.session
    ? Object.freeze({ scope: Object.freeze({ ...input.session.scope }), scopeId: encodeExecutionScopeId(input.session.scope) })
    : undefined
  const source: AuthorityOrigin = input.route.exposure === "public"
    ? { kind: "route", routeKey: input.route.routeKey }
    : input.session?.source ?? { kind: "authority", target: sessionTarget ?? target }
  const impersonation = identity.actor.id === identity.subject.id && identity.actor.kind === identity.subject.kind
    ? { kind: "none" as const }
    : { kind: "explicit" as const, actorId: identity.actor.id, subjectId: identity.subject.id, grantId: admission.grantId }
  const authority = {
    identity,
    correlationId: input.correlationId,
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    grant: {
      grantId: admission.grantId,
      source,
      target,
      purpose: admission.purpose,
      reason: admission.reason,
      issuedAt: admission.issuedAt,
      ...(admission.expiresAt === undefined ? {} : { expiresAt: admission.expiresAt }),
      policy: admission.policy,
      delegationChain: admission.delegationChain ?? [],
      impersonation,
    },
  }
  return freezeVerifiedRequestContext({
    requestId: input.requestId,
    correlationId: input.correlationId,
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    identity,
    scope,
    scopeId,
    authority,
    route: compiledRouteBindingRef(input.route),
    signal: input.signal,
    ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
    ...(input.locale === undefined ? {} : { locale: input.locale }),
    ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    ...(input.traceContext === undefined ? {} : { traceContext: { ...input.traceContext } }),
    ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
  }, input.verifyDelegationRevocation, input.now)
}
