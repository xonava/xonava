export type RouteExposure = "authenticated" | "public"

export interface CompiledRouteBindingRef {
  readonly routeKey: string
  readonly definitionVersion: number
  /** Bound compiled operation identity; never derived from transport input. */
  readonly operationKey: string
}
