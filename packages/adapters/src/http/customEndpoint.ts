import type { RequestContext } from "@xonava/core/domain"
import type { AbacBundle, FrameworkAdapterDeps, FrameworkRequestNormalization } from "../server"
import { assertVerifiedAbacBundle, ForbiddenError } from "@xonava/core/domain"
import { authorizeFrameworkModule, normalizeCrudRequest } from "./crudHandlers/shared"
import { resolveRequestMetadata } from "./requestBody"

/** Request identifiers for one request, as returned by `resolveRequestMetadata`. */
export interface EndpointRequestMetadata {
  readonly requestId: string
  readonly correlationId: string
  readonly ipAddress?: string
  readonly userAgent?: string | null
}

export interface ResolveEndpointRequestContextArgs {
  readonly request: Request
  /** Key of a binding in `normalization.routeBindings`. */
  readonly routeKey: string
  readonly normalization: FrameworkRequestNormalization
  /**
   * Used only to resolve the client address when `requestMetadata` is omitted.
   * Pass the same deps the built-in handlers receive.
   */
  readonly adapterDeps?: Pick<FrameworkAdapterDeps, "resolveClientIp" | "resolveHttpMetadata">
  /**
   * Identifiers you already generated (for the response header, say). Omit it and
   * they are generated with `resolveRequestMetadata`, exactly as CRUD handlers do.
   */
  readonly requestMetadata?: EndpointRequestMetadata
  /** Validated path parameters, available to scope resolvers. */
  readonly pathParameters?: Readonly<Record<string, string>>
}

/**
 * Builds the trusted `RequestContext` for a hand-written endpoint exactly as the
 * CRUD and write handlers do: trusted session, scope resolution and admission
 * evidence come from `normalization`, never from the request body.
 *
 * Throws `ConfigurationError` when `routeKey` has no binding. A request without a
 * trusted session on a route that does not allow anonymous callers fails with the
 * same error the CRUD handlers raise (answered as 401 by the framework error handler).
 */
export async function resolveEndpointRequestContext(args: ResolveEndpointRequestContextArgs): Promise<RequestContext> {
  const metadata = args.requestMetadata ?? resolveRequestMetadata(
    args.request,
    args.adapterDeps?.resolveClientIp,
    args.adapterDeps?.resolveHttpMetadata?.(args.request),
  )
  return normalizeCrudRequest({
    request: args.request,
    routeKey: args.routeKey,
    normalization: args.normalization,
    requestId: metadata.requestId,
    correlationId: metadata.correlationId,
    ...(args.pathParameters === undefined ? {} : { pathParameters: args.pathParameters }),
    metadata: { requestId: metadata.requestId, ipAddress: metadata.ipAddress ?? "unknown", userAgent: metadata.userAgent ?? null },
  })
}

export interface AdmitModuleActionArgs {
  readonly adapterDeps: FrameworkAdapterDeps
  readonly moduleKey: string
  readonly action: string
  readonly context: RequestContext
  /** The ABAC bundle resolved for `moduleKey`, or null/undefined when there is none. */
  readonly bundle: AbacBundle | null | undefined
  /** Required capability, when the module action is capability-gated. */
  readonly capabilityKey?: string
}

/**
 * Admits `action` on `moduleKey` the way the CRUD and write handlers do: the
 * module must be enabled for the action, the bundle must be present, verified and
 * issued for this module, and the ABAC collection decision must not deny. A
 * conditional grant admits (the per-record check belongs to the action itself).
 * Resolve the bundle with `adapterDeps.resolveAbacBundle({ moduleKey, context })`.
 *
 * Throws `ForbiddenError` for a missing bundle, a bundle for another module or a
 * deny, and `CapabilityError` (also 403) for a module, action or capability that
 * is not enabled.
 */
export function admitModuleAction(args: AdmitModuleActionArgs): void {
  if (!args.bundle) throw new ForbiddenError("ABAC authorization bundle unavailable")
  assertVerifiedAbacBundle(args.bundle)
  authorizeFrameworkModule({
    deps: args.adapterDeps,
    moduleKey: args.moduleKey,
    action: args.action,
    ...(args.capabilityKey === undefined ? {} : { capabilityKey: args.capabilityKey }),
    context: args.context,
    bundle: args.bundle,
  })
}
