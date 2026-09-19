import { CanonicalJsonError } from "../serialization/canonicalJson"
import { emitTelemetry, explicitlySafeTelemetryAttributes, type TelemetryPort } from "../telemetry/telemetry"

export const MAX_CACHE_KEY_DEPTH = 100
export const MAX_CACHE_KEY_KEYS = 10_000
export const MAX_CACHE_KEY_BYTES = 2 * 1024
export const MAX_CACHE_KEY_ITEMS = 10_000
export const MAX_CACHE_KEY_NODES = 10_000

function compareSerialized(left: unknown, right: unknown): number {
  const a = JSON.stringify(left) ?? ""
  const b = JSON.stringify(right) ?? ""
  return a < b ? -1 : a > b ? 1 : 0
}

function assertAcyclic(value: object, seen: Set<object>): void {
  if (seen.has(value)) {
    throw new CanonicalJsonError("Cache key parts do not accept cyclic structures")
  }
  seen.add(value)
}

interface CacheKeySerializationState { nodes: number }

function assertItemCount(count: number, kind: "array" | "Map" | "Set"): void {
  if (count > MAX_CACHE_KEY_ITEMS) {
    throw new CanonicalJsonError(`Cache key ${kind} exceeds the maximum of ${MAX_CACHE_KEY_ITEMS} items`)
  }
}

function sortForSerialization(
  value: unknown,
  state: CacheKeySerializationState,
  depth = 0,
  seen = new Set<object>(),
): unknown {
  if (depth > MAX_CACHE_KEY_DEPTH) {
    throw new CanonicalJsonError(`Cache key nesting exceeds the maximum depth of ${MAX_CACHE_KEY_DEPTH}`)
  }
  if (++state.nodes > MAX_CACHE_KEY_NODES) {
    throw new CanonicalJsonError(`Cache key exceeds the maximum of ${MAX_CACHE_KEY_NODES} nodes`)
  }
  if (value === undefined) return { "$type": "undefined" }
  if (typeof value === "number" && Number.isNaN(value)) return { "$type": "NaN" }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return { "$type": value > 0 ? "Infinity" : "-Infinity" }
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new CanonicalJsonError("Cache key parts do not accept invalid Date values")
    }
    return { "$type": "Date", "value": value.toISOString() }
  }
  if (typeof value === "bigint") {
    return { "$type": "BigInt", "value": value.toString() }
  }
  if (value instanceof Map) {
    assertAcyclic(value, seen)
    const entries = Array.from(value.entries())
    assertItemCount(entries.length, "Map")
    const sorted = entries
      .map(([k, v]) => [sortForSerialization(k, state, depth + 1, seen), sortForSerialization(v, state, depth + 1, seen)] as const)
      .sort((left, right) => compareSerialized(left[0], right[0]))
    seen.delete(value)
    return { "$type": "Map", "value": sorted }
  }
  if (value instanceof Set) {
    assertAcyclic(value, seen)
    const items = Array.from(value)
    assertItemCount(items.length, "Set")
    const sorted = items
      .map((item) => sortForSerialization(item, state, depth + 1, seen))
      .sort(compareSerialized)
    seen.delete(value)
    return { "$type": "Set", "value": sorted }
  }
  if (Array.isArray(value)) {
    assertAcyclic(value, seen)
    assertItemCount(value.length, "array")
    const items = value.map((item) => sortForSerialization(item, state, depth + 1, seen))
    seen.delete(value)
    return items
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    if ("$type" in record) {
      throw new CanonicalJsonError("Cache key parts do not accept objects with a reserved $type key")
    }
    assertAcyclic(value, seen)
    const keys = Object.keys(record)
    if (keys.length > MAX_CACHE_KEY_KEYS) {
      throw new CanonicalJsonError(`Cache key object exceeds the maximum of ${MAX_CACHE_KEY_KEYS} keys`)
    }
    const result = keys
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortForSerialization(record[key], state, depth + 1, seen)
        return acc
      }, Object.create(null) as Record<string, unknown>)
    seen.delete(value)
    return result
  }
  return value
}

export function serializeCacheKeyPart(value: unknown): string {
  const serialized = JSON.stringify(sortForSerialization(value, { nodes: 0 }))
  const bytes = new TextEncoder().encode(serialized).byteLength
  if (bytes > MAX_CACHE_KEY_BYTES) {
    throw new CanonicalJsonError(`Cache key part exceeds the maximum of ${MAX_CACHE_KEY_BYTES} bytes`)
  }
  return serialized
}

export function buildKey(prefix: string, scope: string, suffix: string): string {
  const encoded = [prefix, scope, suffix].map((part) => encodeURIComponent(part)).join(":")
  const bytes = new TextEncoder().encode(encoded).byteLength
  if (bytes > MAX_CACHE_KEY_BYTES) {
    throw new CanonicalJsonError(`Cache key exceeds the maximum of ${MAX_CACHE_KEY_BYTES} bytes`)
  }
  return encoded
}

export class CacheAdapterError extends Error {
  readonly operation: string

  constructor(operation: string, options?: { cause?: unknown }) {
    super(`Cache operation failed: ${operation}`, options)
    this.name = "CacheAdapterError"
    this.operation = operation
  }
}

export interface CacheAdapter {
  /** Backend consistency guarantees used by correctness-critical callers. */
  readonly capabilities?: CacheCapabilities
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, data: T, ttlMs?: number): Promise<void>
  delete(key: string): Promise<boolean>
  has(key: string): Promise<boolean>
  clear(): Promise<void>
  addToTag(tag: string, key: string): Promise<void>
  getTagKeys(tag: string): Promise<string[]>
  deleteTag(tag: string): Promise<void>
  /** Best-effort epoch primitives used to fence in-flight resolver writes. */
  getTagGeneration?(tag: string): Promise<string | undefined>
  /** Atomically advances and returns a tag generation when the backend supports it. */
  advanceTagGeneration?(tag: string): Promise<string>
}

/**
 * Describes the consistency guarantees a cache backend can provide for
 * tag-based invalidation. Implementations should set the appropriate value
 * so callers can reason about correctness.
 */
export interface CacheCapabilities {
  /**
   * Whether the backend's tag generation tracking provides linearizable
   * (strong) or merely eventual consistency. When unset, callers should
   * assume eventual consistency.
   */
  tagGenerationConsistency?: "linearizable" | "eventual"
  /**
   * Whether generation and payload state is visible across every process and
   * instance ("shared") or only within the current JS process ("process").
   * Correctness-critical caches require shared scope so generation fencing
   * holds across the whole fleet, not just one event loop.
   */
  coherenceScope?: "process" | "shared"
}

export interface CacheConfig {
  adapter?: CacheAdapter
  defaultTtlMs?: number
  debug?: boolean
  telemetry?: TelemetryPort | CacheTelemetry
  /**
   * Do not read or write tagged cache data when generation state cannot be
   * verified. When enabled, the cache service requires `getTagGeneration` and
   * `advanceTagGeneration` on the adapter and throws if they are absent.
   *
   * This flag requires the adapter to declare linearizable tag-generation
   * consistency, a shared coherence scope (generation state visible to every
   * process and instance), and the generation primitives.
   */
  correctnessCritical?: boolean
}

export interface CacheTelemetry {
  onError?: (event: { operation: string; key?: string; error: unknown }) => void
}

export class CacheService {
  private adapter: CacheAdapter
  private defaultTtlMs: number
  /**
   * Instance-local deduplication map for in-flight cache resolutions.
   *
   * @note Stampede coalescing is per-CacheService instance and request-scoped,
   * NOT distributed. Concurrent requests to different instances or processes
   * will each independently resolve the same key. This is an optimization
   * boundary, never a correctness mechanism. A miss simply recomputes the value.
   */
  private readonly inFlight = new Map<string, Promise<unknown>>()
  private readonly localTagGenerations = new Map<string, string>()
  private readonly telemetry: TelemetryPort | CacheTelemetry | undefined
  private readonly correctnessCritical: boolean

  constructor(config: CacheConfig & { adapter: CacheAdapter }) {
    this.adapter = config.adapter
    this.defaultTtlMs = config.defaultTtlMs ?? 120_000
    this.telemetry = config.telemetry
    this.correctnessCritical = config.correctnessCritical === true
    if (
      this.correctnessCritical &&
      (this.adapter.capabilities?.tagGenerationConsistency !== "linearizable" ||
        this.adapter.capabilities?.coherenceScope !== "shared" ||
        !this.adapter.getTagGeneration ||
        !this.adapter.advanceTagGeneration)
    ) {
      throw new CacheAdapterError("shared tag generation unavailable")
    }
  }

  async getOrSet<T>(
    key: string,
    resolver: () => Promise<T>,
    tags: string[] = [],
    ttlMs?: number
  ): Promise<T> {
    this.requireSharedGeneration(tags)
    const generation = tags.length > 0
      ? await this.getTagGeneration(tags)
      : undefined
    const storageKey = generation === undefined ? key : this.generationKey(key, generation)
    const existing = await this.get<T>(storageKey)
    if (existing !== undefined) {
      const currentGeneration = tags.length > 0 ? await this.getTagGeneration(tags) : undefined
      if (currentGeneration === generation) return existing
    }

    const pending = this.inFlight.get(storageKey)
    if (pending) return pending as Promise<T>

    const work = (async () => {
      const value = await resolver()
      if (tags.length > 0) {
        const currentGeneration = await this.getTagGeneration(tags)
        if (currentGeneration !== generation) return value
      }
      // A resolver may have started before a write invalidated its tags. Its
      // generation-qualified key is intentionally no longer readable.
      await this.set(storageKey, value, ttlMs ?? this.defaultTtlMs)

      for (const tag of tags) {
        try {
          await this.adapter.addToTag(tag, storageKey)
        } catch {
          // Cache tags are an invalidation hint, not a correctness boundary.
        }
      }

      return value
    })()

    this.inFlight.set(storageKey, work)
    try {
      return await work
    } finally {
      if (this.inFlight.get(storageKey) === work) this.inFlight.delete(storageKey)
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      return await this.adapter.get<T>(key)
    } catch (error) {
      this.reportError("get", key, error)
      if (this.correctnessCritical) throw error
      return undefined
    }
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    try {
      await this.adapter.set(key, value, ttlMs ?? this.defaultTtlMs)
    } catch (error) {
      this.reportError("set", key, error)
      if (this.correctnessCritical) throw error
      // A cache write must not turn a best-effort cache into a request failure.
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      return await this.adapter.delete(key)
    } catch (error) {
      this.reportError("delete", key, error)
      return false
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      return await this.adapter.has(key)
    } catch (error) {
      this.reportError("has", key, error)
      return false
    }
  }

  async clear(): Promise<void> {
    try {
      await this.adapter.clear()
    } catch (error) {
      this.reportError("clear", undefined, error)
      // Cache eviction is best effort.
    }
  }

  async invalidateTag(tag: string): Promise<void> {
    this.requireSharedGeneration([tag])
    await this.advanceTagGeneration(tag)
    // A shared, linearizable generation advance fences every pre-invalidation
    // key across all processes. Do not physically delete tag members in the
    // critical path: a stale tag index must never be allowed to delete a newer
    // reuse of the same key.
    if (this.correctnessCritical) return
    try {
      await this.adapter.deleteTag(tag)
    } catch (error) {
      this.reportError("invalidateTag", tag, error)
      // Cache invalidation is best effort.
    }
  }

  async invalidateTags(tags: string[]): Promise<void> {
    for (const tag of tags) {
      await this.invalidateTag(tag)
    }
  }

  async addToTag(tag: string, key: string): Promise<void> {
    try {
      await this.adapter.addToTag(tag, key)
    } catch (error) {
      this.reportError("addToTag", key, error)
      if (this.correctnessCritical) throw error
    }
  }

  private generationKey(key: string, generation: string): string {
    return `__generation__:${serializeCacheKeyPart(generation)}:${key}`
  }

  private async getTagGeneration(tags: string[]): Promise<string | undefined> {
    if (tags.length === 0) return undefined
    if (!this.adapter.getTagGeneration) {
      if (this.correctnessCritical) throw new CacheAdapterError("getTagGeneration")
      return serializeCacheKeyPart(tags.map((tag) => this.localTagGenerations.get(tag) ?? "0"))
    }
    const generations = await Promise.all(tags.map(async (tag) => {
      try {
        const generation = await this.adapter.getTagGeneration!(tag)
        if (generation !== undefined) this.localTagGenerations.set(tag, generation)
        return generation ?? this.localTagGenerations.get(tag) ?? "0"
      } catch (error) {
        if (this.correctnessCritical) throw error
        return this.localTagGenerations.get(tag) ?? "0"
      }
    }))
    return serializeCacheKeyPart(generations)
  }

  private async advanceTagGeneration(tag: string): Promise<void> {
    try {
      if (this.adapter.advanceTagGeneration) {
        this.localTagGenerations.set(tag, await this.adapter.advanceTagGeneration(tag))
      } else {
        if (this.correctnessCritical) throw new CacheAdapterError("advanceTagGeneration")
        this.localTagGenerations.set(tag, String(Number(this.localTagGenerations.get(tag) ?? "0") + 1))
      }
    } catch (error) {
      if (this.correctnessCritical) {
        if (error instanceof CacheAdapterError) throw error
        throw new CacheAdapterError("advanceTagGeneration", { cause: error })
      }
      // Invalidation remains best effort, but fence local in-flight work.
      this.localTagGenerations.set(tag, String(Number(this.localTagGenerations.get(tag) ?? "0") + 1))
    }
  }

  private requireSharedGeneration(tags: string[]): void {
    if (!this.correctnessCritical || tags.length === 0) return
    if (!this.adapter.getTagGeneration || !this.adapter.advanceTagGeneration) {
      throw new CacheAdapterError("shared tag generation unavailable")
    }
  }

  private reportError(operation: string, key: string | undefined, error: unknown): void {
    if (this.telemetry && "emit" in this.telemetry) {
      emitTelemetry(this.telemetry,{name:"cache.operation.failure",severity:"error",timestamp:new Date(),attributes:explicitlySafeTelemetryAttributes({operation,hasKey:key!==undefined,errorType:error instanceof Error?error.name:"unknown"})})
      return
    }
    try {
      this.telemetry?.onError?.({ operation, ...(key !== undefined ? { key } : {}), error })
    } catch {
      // Telemetry must never change cache semantics.
    }
  }
}
