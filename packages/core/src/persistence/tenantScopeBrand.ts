/**
 * Compile-time marker retained for the public provider type. It is deliberately
 * never installed as an own property: symbols are discoverable through
 * reflection and therefore are not an authority boundary.
 */
export const TENANT_SCOPED_PROVIDER_BRAND: unique symbol = Symbol("framework.tenant-scoped-provider")

// A module-private WeakSet is an unforgeable runtime capability: callers can
// neither enumerate it nor add an arbitrary object to it.
const coreTenantScopedProviders = new WeakSet<object>()

/**
 * Framework-internal. Deliberately not re-exported from the persistence barrel:
 * only core attenuation code (scoped persistence, authorization constraints)
 * may mint the brand, by importing this module directly.
 */
export function registerTenantScopedProvider(provider: object): void {
  coreTenantScopedProviders.add(provider)
}

export function isCoreTenantScopedProvider(provider: unknown): provider is object {
  return typeof provider === "object" && provider !== null && coreTenantScopedProviders.has(provider)
}
