import { ConfigurationError, ForbiddenError } from "../domain/errors.js"
import { encodeExecutionScopeId, type ExecutionScope, type ExecutionScopeId } from "../domain/executionScope.js"
import type { CompiledRouteBindingRef } from "../domain/routeExposure.js"
import type { CompiledRouteBinding } from "../bootstrap/compiledRouteBinding.js"

/** Query, body, and cursor values are intentionally absent from this boundary. */
export interface UntrustedScopeResolutionInput {
  readonly host?: string
  readonly pathParameters?: Readonly<Record<string, string>>
  readonly headers?: Readonly<Record<string, string>>
  readonly sessionFacts?: Readonly<Record<string, unknown>>
}

const verifiedScopeBrand: unique symbol = Symbol("VerifiedScopeResolution")
const verifiedScopes = new WeakSet<object>()

export interface VerifiedScopeResolution {
  readonly scope: ExecutionScope
  readonly scopeId: ExecutionScopeId
  readonly resolverKey: string
  readonly [verifiedScopeBrand]: true
}

export interface ScopeResolver {
  readonly key: string
  resolve(input: UntrustedScopeResolutionInput, route: CompiledRouteBindingRef): Promise<VerifiedScopeResolution>
}

/** Trusted resolver implementations use this constructor after directory lookup. */
export function createVerifiedScopeResolution(resolverKey: string, scope: ExecutionScope): VerifiedScopeResolution {
  if (resolverKey.trim().length === 0) throw new ConfigurationError("resolver key must be non-empty")
  const result = Object.freeze({
    scope: Object.freeze({ ...scope }),
    scopeId: encodeExecutionScopeId(scope),
    resolverKey,
    [verifiedScopeBrand]: true as const,
  })
  verifiedScopes.add(result)
  return result
}

export function isVerifiedScopeResolution(value: unknown): value is VerifiedScopeResolution {
  return typeof value === "object" && value !== null && verifiedScopes.has(value)
}

export interface BoundScopeResolver {
  readonly key: string
  readonly resolver: ScopeResolver
  readonly allowedTargetKinds: readonly ExecutionScope["kind"][]
}

export async function resolveVerifiedScope(args: {
  readonly route: CompiledRouteBinding
  readonly input: UntrustedScopeResolutionInput
  readonly binding: BoundScopeResolver
}): Promise<VerifiedScopeResolution> {
  const plan = args.route.scopeResolution
  if (plan.kind !== "resolver") throw new ConfigurationError("route does not use resolver scope resolution")
  if (args.route.exposure === "public" && args.route.anonymousPrincipal.allowed !== true) {
    throw new ConfigurationError("public route must declare an anonymous principal")
  }
  if (args.binding.key !== plan.resolverKey || args.binding.resolver.key !== plan.resolverKey) {
    throw new ConfigurationError("scope resolver binding identity mismatch")
  }
  const verified = await args.binding.resolver.resolve(args.input, {
    routeKey: args.route.routeKey,
    definitionVersion: args.route.definitionVersion,
    operationKey: args.route.operationKey,
  })
  if (!isVerifiedScopeResolution(verified) || verified.resolverKey !== plan.resolverKey) {
    throw new ForbiddenError("scope resolver returned an unverified or mismatched result")
  }
  if (encodeExecutionScopeId(verified.scope) !== verified.scopeId) {
    throw new ForbiddenError("verified scope identity mismatch")
  }
  if (!args.binding.allowedTargetKinds.includes(verified.scope.kind)) {
    throw new ForbiddenError("resolved scope kind is outside resolver binding")
  }
  if (!plan.allowedTargetKinds.includes(verified.scope.kind)) {
    throw new ForbiddenError("resolved scope kind is outside route binding")
  }
  return verified
}

export function assertVerifiedScopeIdentity(value: VerifiedScopeResolution): void {
  if (!isVerifiedScopeResolution(value) || encodeExecutionScopeId(value.scope) !== value.scopeId) {
    throw new ConfigurationError("verified scope identity mismatch")
  }
}
