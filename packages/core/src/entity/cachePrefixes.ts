import { ConfigurationError } from "../domain/errors.js"

export interface CacheKeyPrefixOwner {
  /** Human-readable identity of the owner, used in the error message. */
  readonly owner: string
  readonly keyPrefix: string
}

/**
 * Cache key prefixes are the isolation boundary between entities' cached rows:
 * two entities sharing one would read and invalidate each other's entries.
 * Defaults are namespaced by module/namespace/name and cannot collide, but an
 * explicit `cache.keyPrefix` can, so the whole application is checked here.
 */
export function assertUniqueCacheKeyPrefixes(owners: Iterable<CacheKeyPrefixOwner>): void {
  const seen = new Map<string, string>()
  for (const { owner, keyPrefix } of owners) {
    const prior = seen.get(keyPrefix)
    if (prior !== undefined) throw new ConfigurationError(`Entities "${prior}" and "${owner}" share the cache key prefix "${keyPrefix}"; each entity needs its own.`)
    seen.set(keyPrefix, owner)
  }
}

/** Checks compiled entity definitions; entities with caching disabled are skipped. */
export function assertUniqueEntityCachePrefixes(entities: Iterable<{
  readonly moduleKey: string
  readonly entity: { readonly name: string }
  readonly cache: false | { readonly keyPrefix: string }
}>): void {
  const owners: CacheKeyPrefixOwner[] = []
  for (const { moduleKey, entity, cache } of entities) if (cache !== false) owners.push({ owner: `${moduleKey}:${entity.name}`, keyPrefix: cache.keyPrefix })
  assertUniqueCacheKeyPrefixes(owners)
}
