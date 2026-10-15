import { assertUniqueCacheKeyPrefixes } from "@xonava/core/entity"
import type { EntityDescriptor } from "@xonava/core/persistence"

/** The part of a compiled entity definition (`defineEntity()` result) the registries read. */
export interface CompiledEntityRegistration<T> {
  readonly entity: EntityDescriptor<T>
  readonly moduleKey: string
  readonly cache: false | { readonly keyPrefix: string }
}

/** What a Drizzle registry accepts: a bare persistence descriptor or a compiled entity definition. */
export type RegistrableEntity<T> = EntityDescriptor<T> | CompiledEntityRegistration<T>

export interface ResolvedRegistration<T> {
  readonly descriptor: EntityDescriptor<T>
  /** Set only for compiled entities with caching enabled. */
  readonly cachePrefix?: { readonly owner: string; readonly keyPrefix: string }
}

/**
 * A bare descriptor carries no cache configuration. A compiled definition does,
 * and its resolved `cache.keyPrefix` is what registries must keep unique: two
 * entities sharing one would read and invalidate each other's cached rows.
 */
export function resolveRegistration<T>(input: RegistrableEntity<T>): ResolvedRegistration<T> {
  const candidate = input as Partial<CompiledEntityRegistration<T>> & Partial<EntityDescriptor<T>>
  if (!candidate || typeof candidate !== "object" || candidate.fields !== undefined || !candidate.entity || typeof candidate.entity !== "object") {
    return { descriptor: input as EntityDescriptor<T> }
  }
  const cache = candidate.cache
  return {
    descriptor: candidate.entity,
    ...(cache && typeof cache === "object" && typeof cache.keyPrefix === "string"
      ? { cachePrefix: { owner: `${String(candidate.moduleKey)}:${String(candidate.entity.name)}`, keyPrefix: cache.keyPrefix } }
      : {}),
  }
}

/** Registry-side ledger of explicit cache key prefixes; a reused prefix is a ConfigurationError naming both entities. */
export class CachePrefixLedger {
  private readonly owners = new Map<string, string>()

  /** Throws when `keyPrefix` is already owned; records nothing in that case. */
  assertAvailable(prefix: { readonly owner: string; readonly keyPrefix: string } | undefined): void {
    if (!prefix) return
    const prior = this.owners.get(prefix.keyPrefix)
    if (prior !== undefined) assertUniqueCacheKeyPrefixes([{ owner: prior, keyPrefix: prefix.keyPrefix }, prefix])
  }

  claim(prefix: { readonly owner: string; readonly keyPrefix: string } | undefined): void {
    if (prefix) this.owners.set(prefix.keyPrefix, prefix.owner)
  }
}
