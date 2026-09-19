import { ConfigurationError } from "core/domain"
import type { CacheAdapter } from "core/cache"

/**
 * Declares which backing engine builds the default cache adapter. Capabilities
 * are owned by the adapter each engine returns, never overridden here:
 *
 *   - `memory` => InMemoryCacheAdapter with `coherenceScope: "process"`
 *     (linearizable only within a single JS process). Do NOT use it for
 *     correctness-critical cache reads across instances; compose it with a
 *     SharedGenerationCacheAdapter backed by a shared generation store.
 *   - `kv` => KvCacheAdapter with `coherenceScope: "shared"` but eventual tag
 *     generations. Same composition rule applies for correctness-critical use.
 */
export type CacheProviderConfig =
  | { engine: "kv" }
  | { engine: "memory" }

export interface CacheAdapterFactories {
  memory: () => CacheAdapter
  kv: () => Promise<CacheAdapter>
}

function configKey(c: CacheProviderConfig): string {
  return c.engine
}

const adapterCaches = new WeakMap<CacheAdapterFactories, Map<string, Promise<CacheAdapter>>>()

export function getCacheAdapter(
  config: CacheProviderConfig,
  factories: CacheAdapterFactories,
): Promise<CacheAdapter> {
  let adapterCache = adapterCaches.get(factories)
  if (!adapterCache) {
    adapterCache = new Map()
    adapterCaches.set(factories, adapterCache)
  }
  const key = configKey(config)

  let promise = adapterCache.get(key)
  if (!promise) {
    promise = createCacheAdapter(config, factories).catch((error) => {
      adapterCache.delete(key)
      throw error
    })
    adapterCache.set(key, promise)
  }
  return promise
}

async function createCacheAdapter(
  config: CacheProviderConfig,
  factories: CacheAdapterFactories,
): Promise<CacheAdapter> {
  if (config.engine === "memory") {
    return factories.memory()
  }

  if (config.engine === "kv") {
    return factories.kv()
  }

  throw new ConfigurationError(`Unknown cache engine: ${(config as { engine: string }).engine}`)
}
