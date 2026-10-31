import { ConfigurationError, type AuthoritativeStoreDelegationHop, type VerifiedAbacPolicyBundle, type ModuleAuthorizationFacts, type RequestContext } from "@xonava/core/domain"
import type { HttpRequestMetadata } from "../http/trustedClientIp"
import type { TrustedClientIpResolver } from "../http/requestBody"
import type { IdempotencyPort } from "@xonava/core/events"
import type { RateLimitStore } from "@xonava/core/rate-limit"
import type { TelemetryPort } from "@xonava/core/telemetry"
import type { AuthorityOrigin, DelegationHop, ExecutionIdentity, ExecutionScope, ExecutionScopeId, PolicyEvidence } from "@xonava/core/domain"
import type { CompiledRouteBinding, CompiledScopeResolverBinding } from "@xonava/core/bootstrap"

export type AbacBundle = VerifiedAbacPolicyBundle

export interface TrustedFrameworkSession {
  readonly identity: ExecutionIdentity
  readonly scope: ExecutionScope
  readonly source?: AuthorityOrigin
  readonly resolverFacts?: Readonly<Record<string, unknown>>
}

export interface ScopeAdmissionEvidence {
  readonly grantId: string
  readonly purpose: string
  readonly reason: string
  readonly issuedAt: string
  readonly expiresAt?: string
  readonly policy: PolicyEvidence
  readonly delegationChain?: readonly DelegationHop[]
}

/**
 * The built-in CRUD route keys. Each is required only by the CRUD handler that
 * uses it; a module without CRUD handlers declares none of them.
 */
export type CrudRouteBindings = Readonly<{
  list?: CompiledRouteBinding
  detail?: CompiledRouteBinding
  create?: CompiledRouteBinding
  update?: CompiledRouteBinding
  delete?: CompiledRouteBinding
}>

/** Bootstrap-owned bindings used at the common HTTP normalization boundary. */
export interface FrameworkRequestNormalization {
  /** Optional CRUD bindings plus one binding per business action, looked up by the handler's `routeKey`. */
  readonly routeBindings: CrudRouteBindings & Readonly<Record<string, CompiledRouteBinding>>
  readonly resolverBindings: ReadonlyMap<string, CompiledScopeResolverBinding>
  readonly trustedHeaders?: readonly string[]
  resolveTrustedSession(args: { readonly request: Request; readonly route: CompiledRouteBinding }): Promise<TrustedFrameworkSession | undefined>
  resolveAdmissionEvidence(args: {
    readonly request: Request
    readonly route: CompiledRouteBinding
    readonly identity: ExecutionIdentity
    readonly scope: ExecutionScope
    readonly scopeId: ExecutionScopeId
    readonly session?: TrustedFrameworkSession
  }): Promise<ScopeAdmissionEvidence>
  verifyDelegationRevocation?: NormalizeDelegationRevocation
}

export type NormalizeDelegationRevocation = (hop: AuthoritativeStoreDelegationHop) => Promise<boolean>

/** Host-provided entitlements only; security context is derived by the adapter. */
export type FrameworkAuthorizationEntitlements = Pick<ModuleAuthorizationFacts,
  "enabledModuleKeys" | "enabledModuleActions" | "enabledModuleCapabilities"
>

type FrameworkAdapterObsoleteDecisionKey =
  | "isOwnerBypass"
  | "ownerBypass"
  | "ownerAuthority"
  | "impersonated"
  | "resolveSession"
  | "hasCapability"
  | "assertModuleEnabled"
  | "assertModuleActionEnabled"
  | "assertModuleCapabilityEnabled"

export interface FrameworkAdapterDeps {
  telemetry?: TelemetryPort
  /** Atomic store used by security-sensitive route policies. */
  getRateLimitStore?: () => Promise<RateLimitStore>
  /** Resolves the client IP from trusted runtime context. Forwarded headers are never used by the framework. */
  resolveClientIp?: TrustedClientIpResolver
  resolveHttpMetadata?: (request: Request) => HttpRequestMetadata | undefined
  assertValidCsrf(request: Request): void
  resolveAbacBundle(args: {
    moduleKey: string
    context: RequestContext
  }): Promise<AbacBundle | null>
  /**
   * Resolves host entitlements only. Decisions and security context remain
   * authoritative in the adapter and packages/core.
   */
  resolveModuleAuthorizationFacts?(args: {
    moduleKey: string
    context: RequestContext
  }): FrameworkAuthorizationEntitlements
  createIdempotencyPort?: <TResult>(args: { context: RequestContext }) => IdempotencyPort<TResult>
}

/** Reject metadata that could be mistaken for a policy decision. */
export function assertFrameworkAdapterDeps(deps: unknown): asserts deps is FrameworkAdapterDeps {
  if (deps === null || typeof deps !== "object") {
    throw new ConfigurationError("Framework adapter dependencies must be an object")
  }

  const dependencyRecord = deps as Record<string, unknown>
  const obsoleteKeys: FrameworkAdapterObsoleteDecisionKey[] = [
    "isOwnerBypass",
    "ownerBypass",
    "ownerAuthority",
    "impersonated",
    "resolveSession",
    "hasCapability",
    "assertModuleEnabled",
    "assertModuleActionEnabled",
    "assertModuleCapabilityEnabled",
  ]
  const present = obsoleteKeys.filter((key) => Object.hasOwn(dependencyRecord, key))
  if (present.length > 0) {
    throw new ConfigurationError(
      `Framework adapter dependencies contain obsolete authorization decision key(s): ${present.join(", ")}. ` +
      "Provide entitlements only; authorization decisions remain in packages/core.",
    )
  }

  const requiredKeys = [
    "assertValidCsrf",
    "resolveAbacBundle",
  ] as const
  const invalidRequiredKeys = requiredKeys.filter((key) => typeof dependencyRecord[key] !== "function")
  if (invalidRequiredKeys.length > 0) {
    throw new ConfigurationError(
      `Framework adapter dependencies contain invalid required member(s): ${invalidRequiredKeys.join(", ")}. ` +
      "Each member must be a function.",
    )
  }

  const optionalKeys = [
    "getRateLimitStore",
    "resolveClientIp",
    "resolveHttpMetadata",
    "resolveModuleAuthorizationFacts",
    "createIdempotencyPort",
  ] as const
  const invalidOptionalKeys = optionalKeys.filter((key) =>
    Object.hasOwn(dependencyRecord, key) && dependencyRecord[key] !== undefined && typeof dependencyRecord[key] !== "function",
  )
  if (invalidOptionalKeys.length > 0) {
    throw new ConfigurationError(
      `Framework adapter dependencies contain invalid optional member(s): ${invalidOptionalKeys.join(", ")}. ` +
      "Each present member must be a function.",
    )
  }
}
