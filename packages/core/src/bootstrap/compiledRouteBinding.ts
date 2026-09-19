import { ConfigurationError } from "../domain/errors.js"
import type { Principal } from "../domain/principal.js"
import type { CompiledRouteBindingRef, RouteExposure } from "../domain/routeExposure.js"
import type { ExecutionScope } from "../domain/executionScope.js"

export type { CompiledRouteBindingRef } from "../domain/routeExposure.js"

export type CompiledScopeResolutionPlan =
  | { readonly kind: "fixed"; readonly scope: ExecutionScope }
  | {
      readonly kind: "resolver"
      readonly resolverKey: string
      readonly allowedTargetKinds: readonly ExecutionScope["kind"][]
    }

export interface CompiledRouteBinding {
  readonly routeKey: string
  readonly definitionVersion: number
  readonly transport: "http"
  readonly method: string
  readonly pathTemplate: string
  readonly exposure: RouteExposure
  readonly operationKey: string
  readonly scopeResolution: CompiledScopeResolutionPlan
  readonly anonymousPrincipal:
    | { readonly allowed: false }
    | { readonly allowed: true; readonly principal: Principal }
  readonly inputPolicy: Readonly<Record<string, unknown>>
  readonly outputPolicy: Readonly<Record<string, unknown>>
  readonly mutation:
    | { readonly allowed: false }
    | {
        readonly allowed: true
        readonly idempotencyRequirement: "required" | "optional" | "forbidden"
      }
  readonly authorizationPlanKey: string
}

export function compiledRouteBindingRef(route: CompiledRouteBinding): CompiledRouteBindingRef {
  if (route.routeKey.trim().length === 0 || !Number.isSafeInteger(route.definitionVersion) || route.definitionVersion < 1) {
    throw new ConfigurationError("compiled route binding identity is invalid")
  }
  if (route.operationKey.trim().length === 0) throw new ConfigurationError("compiled route binding operation identity is invalid")
  return Object.freeze({ routeKey: route.routeKey, definitionVersion: route.definitionVersion, operationKey: route.operationKey })
}
