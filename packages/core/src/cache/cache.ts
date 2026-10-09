import { CanonicalJsonError } from "../serialization/canonicalJson"
import { ConfigurationError, ValidationError } from "../domain"
import { emitTelemetry, explicitlySafeTelemetryAttributes, type TelemetryPort } from "../telemetry/telemetry"

export const MAX_CACHE_KEY_DEPTH = 100
export const MAX_CACHE_KEY_KEYS = 10_000
export const MAX_CACHE_KEY_BYTES = 2 * 1024
export const MAX_CACHE_KEY_ITEMS = 10_000
export const MAX_CACHE_KEY_NODES = 10_000
export const MAX_CACHE_TAG_BYTES = 256
export const MAX_CACHE_TAGS_PER_CALL = 100
export const DEFAULT_MAX_CACHE_IN_FLIGHT = 1_000

const textEncoder = new TextEncoder()

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength
}

function assertCacheKey(key: string): void {
  if (typeof key !== "string" || utf8Bytes(key) > MAX_CACHE_KEY_BYTES) {
    throw new ValidationError(`Cache key must not exceed ${MAX_CACHE_KEY_BYTES} UTF-8 bytes`)
  }
}

function assertTag(tag: string): void {
  if (typeof tag !== "string" || tag.length === 0 || utf8Bytes(tag) > MAX_CACHE_TAG_BYTES) {
    throw new ValidationError(`Cache tag must be non-empty and not exceed ${MAX_CACHE_TAG_BYTES} UTF-8 bytes`)
  }
}

function assertTags(tags: readonly string[]): void {
  if (!Array.isArray(tags) || tags.length > MAX_CACHE_TAGS_PER_CALL) {
    throw new ValidationError(`Cache calls accept at most ${MAX_CACHE_TAGS_PER_CALL} tags`)
  }
  const unique = new Set<string>()
  for (const tag of tags) {
    assertTag(tag)
    if (unique.has(tag)) throw new ValidationError("Cache tags must be unique")
    unique.add(tag)
  }
}

function assertPositiveSafeInteger(value: number, name: string, ErrorType: typeof ValidationError | typeof ConfigurationError): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ErrorType(`${name} must be a positive safe integer`)
}

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
  if (typeof value === "string" && (value.length > MAX_CACHE_KEY_BYTES || utf8Bytes(value) > MAX_CACHE_KEY_BYTES)) {
    throw new CanonicalJsonError(`Cache key string exceeds the maximum of ${MAX_CACHE_KEY_BYTES} bytes`)
  }
  if (value === undefined) return { "$type": "undefined" }
  if (typeof value === "number" && Number.isNaN(value)) return { "$type": "NaN" }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return { "$type": value > 0 ? "Infinity" : "-Infinity" }
  }
  if (value instanceof Date) {
    if (Object.getPrototypeOf(value) !== Date.prototype || Number.isNaN(Date.prototype.getTime.call(value))) {
      throw new CanonicalJsonError("Cache key parts do not accept invalid Date values")
    }
    return { "$type": "Date", "value": Date.prototype.toISOString.call(value) }
  }
  if (typeof value === "bigint") {
    return { "$type": "BigInt", "value": value.toString() }
  }
  if (value instanceof Map) {
    if (Object.getPrototypeOf(value) !== Map.prototype) throw new CanonicalJsonError("Cache key parts do not accept Map subclasses")
    assertAcyclic(value, seen)
    const entries = Array.from(Map.prototype.entries.call(value) as MapIterator<[unknown, unknown]>)
    assertItemCount(entries.length, "Map")
    const sorted = entries
      .map(([k, v]) => [sortForSerialization(k, state, depth + 1, seen), sortForSerialization(v, state, depth + 1, seen)] as const)
      .sort(compareSerialized)
    seen.delete(value)
    return { "$type": "Map", "value": sorted }
  }
  if (value instanceof Set) {
    if (Object.getPrototypeOf(value) !== Set.prototype) throw new CanonicalJsonError("Cache key parts do not accept Set subclasses")
    assertAcyclic(value, seen)
    const items = Array.from(Set.prototype.values.call(value) as SetIterator<unknown>)
    assertItemCount(items.length, "Set")
    const sorted = items
      .map((item) => sortForSerialization(item, state, depth + 1, seen))
      .sort(compareSerialized)
    seen.delete(value)
    return { "$type": "Set", "value": sorted }
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) throw new CanonicalJsonError("Cache key parts accept only plain arrays")
    assertAcyclic(value, seen)
    assertItemCount(value.length, "array")
    const names = Object.getOwnPropertyNames(value)
    if (names.length !== value.length + 1) throw new CanonicalJsonError("Cache key arrays must be dense and cannot contain extra properties")
    const items: unknown[] = []
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new CanonicalJsonError("Cache key arrays must contain enumerable data properties")
      items.push(sortForSerialization(descriptor.value, state, depth + 1, seen))
    }
    seen.delete(value)
    return items
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    const prototype = Object.getPrototypeOf(record) as object | null
    if (prototype !== Object.prototype && prototype !== null) throw new CanonicalJsonError("Cache key parts accept only plain objects")
    if (Object.getOwnPropertySymbols(record).length > 0) throw new CanonicalJsonError("Cache key parts do not accept symbol keys")
    if (Object.hasOwn(record, "$type")) {
      throw new CanonicalJsonError("Cache key parts do not accept objects with a reserved $type key")
    }
    assertAcyclic(value, seen)
    const keys = Object.getOwnPropertyNames(record)
    if (keys.length > MAX_CACHE_KEY_KEYS) {
      throw new CanonicalJsonError(`Cache key object exceeds the maximum of ${MAX_CACHE_KEY_KEYS} keys`)
    }
    const result = keys
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        if (key.length > MAX_CACHE_KEY_BYTES || utf8Bytes(key) > MAX_CACHE_KEY_BYTES) throw new CanonicalJsonError(`Cache key property exceeds the maximum of ${MAX_CACHE_KEY_BYTES} bytes`)
        const descriptor = Object.getOwnPropertyDescriptor(record, key)
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new CanonicalJsonError("Cache key objects must contain enumerable data properties")
        acc[key] = sortForSerialization(descriptor.value, state, depth + 1, seen)
        return acc
      }, Object.create(null) as Record<string, unknown>)
    seen.delete(value)
    return result
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  throw new CanonicalJsonError(`Cache key parts do not accept values of type ${typeof value}`)
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
  let encoded: string
  try {
    encoded = [prefix, scope, suffix].map((part) => encodeURIComponent(part)).join(":")
  } catch (error) {
    // encodeURIComponent throws URIError for lone surrogates; report it as an invalid key.
    throw new CanonicalJsonError("Cache key parts must be well-formed UTF-16 strings", { cause: error })
  }
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

/** A new cache miss was rejected before its resolver ran because the local single-flight limit was reached. */
export class CacheOverloadError extends Error {
  readonly maxInFlight: number

  constructor(maxInFlight: number) {
    super(`Cache resolver capacity exhausted (${maxInFlight} in flight)`)
    this.name = "CacheOverloadError"
    this.maxInFlight = maxInFlight
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
  /** Maximum unresolved, distinct resolver calls retained by this service. New misses fail before invoking the resolver. */
  maxInFlight?: number
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

/**
 * A joinable single-flight lookup. `invalidated` lives on the entry itself, so
 * fencing a key retains no state once its resolver settles.
 */
interface InFlightLookup {
  readonly work: Promise<unknown>
  readonly fence: { invalidated: boolean }
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
  private readonly inFlight = new Map<string, InFlightLookup>()
  /** Unsettled resolver calls, including ones detached from `inFlight` by delete, set or clear. */
  private activeResolvers = 0
  /** One process-local fence shared by every tag; cardinality does not depend on caller input. */
  private localFallbackEpoch = 0n
  /** Fences every resolver write and single-flight group started before a clear. */
  private localClearEpoch = 0n
  private backendGenerationUnavailable = false
  private readonly maxInFlight: number
  private readonly telemetry: TelemetryPort | CacheTelemetry | undefined
  private readonly correctnessCritical: boolean

  constructor(config: CacheConfig & { adapter: CacheAdapter }) {
    this.adapter = config.adapter
    this.defaultTtlMs = config.defaultTtlMs ?? 120_000
    assertPositiveSafeInteger(this.defaultTtlMs, "Cache defaultTtlMs", ConfigurationError)
    this.maxInFlight = config.maxInFlight ?? DEFAULT_MAX_CACHE_IN_FLIGHT
    assertPositiveSafeInteger(this.maxInFlight, "Cache maxInFlight", ConfigurationError)
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
    assertCacheKey(key)
    assertTags(tags)
    const clearEpoch = this.localClearEpoch
    const effectiveTtlMs = ttlMs ?? this.defaultTtlMs
    assertPositiveSafeInteger(effectiveTtlMs, "Cache TTL", ValidationError)
    this.requireSharedGeneration(tags)
    const generation = tags.length > 0
      ? await this.getTagGeneration(tags)
      : undefined
    const storageKey = generation === undefined ? key : this.generationKey(key, generation)
    const existing = await this.read<T>(storageKey)
    if (existing !== undefined && this.localClearEpoch === clearEpoch) {
      const currentGeneration = tags.length > 0 ? await this.getTagGeneration(tags) : undefined
      if (this.localClearEpoch === clearEpoch && currentGeneration === generation) return existing
    }

    const inFlightKey = `${clearEpoch}:${storageKey}`
    const pending = this.inFlight.get(inFlightKey)
    if (pending) return pending.work as Promise<T>
    if (this.activeResolvers >= this.maxInFlight) throw new CacheOverloadError(this.maxInFlight)

    const fence = { invalidated: false }
    const stale = () => fence.invalidated || this.localClearEpoch !== clearEpoch
    // Defer resolver invocation until after `work` is installed below. This
    // makes the bound and same-key coalescing hold even for re-entrant resolvers.
    const work = Promise.resolve().then(async () => {
      const value = await resolver()
      if (tags.length > 0) {
        const currentGeneration = await this.getTagGeneration(tags)
        if (currentGeneration !== generation) return value
      }
      // A delete, set or clear after the resolver started means `value` may
      // predate the change; never write it back.
      if (stale()) return value
      // A resolver may have started before a write invalidated its tags. Its
      // generation-qualified key is intentionally no longer readable.
      await this.write(storageKey, value, effectiveTtlMs)
      if (stale()) {
        // The invalidation raced the backend write and may have landed first.
        // Evicting is always safe; leaving the older value behind is not.
        await this.remove(storageKey)
        return value
      }

      for (const tag of tags) {
        try {
          await this.adapter.addToTag(tag, storageKey)
        } catch {
          // Cache tags are an invalidation hint, not a correctness boundary.
        }
      }

      return value
    })

    const lookup: InFlightLookup = { work, fence }
    this.inFlight.set(inFlightKey, lookup)
    this.activeResolvers++
    try {
      return await work
    } finally {
      this.activeResolvers--
      if (this.inFlight.get(inFlightKey) === lookup) this.inFlight.delete(inFlightKey)
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    assertCacheKey(key)
    return this.read<T>(key)
  }

  private async read<T>(key: string): Promise<T | undefined> {
    try {
      return await this.adapter.get<T>(key)
    } catch (error) {
      this.reportError("get", key, error)
      if (this.correctnessCritical) throw error
      return undefined
    }
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    assertCacheKey(key)
    const effectiveTtlMs = ttlMs ?? this.defaultTtlMs
    assertPositiveSafeInteger(effectiveTtlMs, "Cache TTL", ValidationError)
    this.detachInFlight(key)
    return this.write(key, value, effectiveTtlMs)
  }

  private async write<T>(key: string, value: T, ttlMs: number): Promise<void> {
    try {
      await this.adapter.set(key, value, ttlMs)
    } catch (error) {
      this.reportError("set", key, error)
      if (this.correctnessCritical) throw error
      // A cache write must not turn a best-effort cache into a request failure.
    }
  }

  async delete(key: string): Promise<boolean> {
    assertCacheKey(key)
    // Fence before awaiting the adapter, as clear() does, so a lookup that
    // started before this delete can neither repopulate the key nor be joined.
    this.detachInFlight(key)
    return this.remove(key)
  }

  private async remove(key: string): Promise<boolean> {
    try {
      return await this.adapter.delete(key)
    } catch (error) {
      this.reportError("delete", key, error)
      if (this.correctnessCritical) throw error
      return false
    }
  }

  async has(key: string): Promise<boolean> {
    assertCacheKey(key)
    try {
      return await this.adapter.has(key)
    } catch (error) {
      this.reportError("has", key, error)
      if (this.correctnessCritical) throw error
      return false
    }
  }

  /**
   * Marks the current single-flight lookup for `key` stale and removes it from
   * the join map. Its waiters still settle with the resolver's result, its
   * write is skipped, and new callers start a fresh lookup. Lookups from an
   * earlier clear epoch are already fenced by `localClearEpoch`.
   */
  private detachInFlight(key: string): void {
    const inFlightKey = `${this.localClearEpoch}:${key}`
    const lookup = this.inFlight.get(inFlightKey)
    if (!lookup) return
    lookup.fence.invalidated = true
    this.inFlight.delete(inFlightKey)
  }

  async clear(): Promise<void> {
    // Fence before awaiting the adapter so work already in progress can never
    // repopulate a generation that this instance will read after the clear.
    this.localClearEpoch += 1n
    this.advanceLocalFallbackEpoch()
    try {
      await this.adapter.clear()
    } catch (error) {
      this.reportError("clear", undefined, error)
      // Cache eviction is best effort.
    }
  }

  async invalidateTag(tag: string): Promise<void> {
    assertTag(tag)
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
    assertTags(tags)
    for (const tag of tags) {
      await this.invalidateTag(tag)
    }
  }

  async addToTag(tag: string, key: string): Promise<void> {
    assertTag(tag)
    assertCacheKey(key)
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
      return this.fallbackGeneration()
    }
    const epochAtStart = this.localFallbackEpoch
    try {
      const generations = await Promise.all(tags.map((tag) => this.adapter.getTagGeneration!(tag)))
      for (const generation of generations) {
        if (generation !== undefined && (typeof generation !== "string" || utf8Bytes(generation) > MAX_CACHE_TAG_BYTES)) {
          throw new CacheAdapterError("getTagGeneration")
        }
      }
      if (this.backendGenerationUnavailable) {
        this.backendGenerationUnavailable = false
        this.advanceLocalFallbackEpoch()
        return this.remoteGeneration(tags, generations, this.localFallbackEpoch)
      }
      return this.remoteGeneration(tags, generations, epochAtStart)
    } catch (error) {
      if (this.correctnessCritical) throw error
      // Entering fallback is itself a fence. Remaining unavailable is stable,
      // allowing local fallback hits without retaining one value per tag.
      if (!this.backendGenerationUnavailable) {
        this.backendGenerationUnavailable = true
        this.advanceLocalFallbackEpoch()
      }
      return this.fallbackGeneration()
    }
  }

  private async advanceTagGeneration(tag: string): Promise<void> {
    // The backend generation is the shared fence: a value written under an
    // older generation is never read again, so instances sharing a backend
    // keep sharing entries. The instance-local epoch is advanced only when the
    // backend cannot advance, so this instance still stops serving entries it
    // was told to invalidate (best-effort mode).
    try {
      if (this.adapter.advanceTagGeneration) {
        await this.adapter.advanceTagGeneration(tag)
      } else {
        if (this.correctnessCritical) throw new CacheAdapterError("advanceTagGeneration")
        this.advanceLocalFallbackEpoch()
      }
    } catch (error) {
      if (this.correctnessCritical) {
        if (error instanceof CacheAdapterError) throw error
        throw new CacheAdapterError("advanceTagGeneration", { cause: error })
      }
      this.advanceLocalFallbackEpoch()
    }
  }

  private advanceLocalFallbackEpoch(): void {
    this.localFallbackEpoch += 1n
  }

  private fallbackGeneration(): string {
    return `fallback:${this.localFallbackEpoch}`
  }

  private remoteGeneration(tags: readonly string[], generations: readonly (string | undefined)[], epoch: bigint): string {
    return serializeCacheKeyPart([`local:${epoch}`, ...tags.flatMap((tag, index) => [tag, generations[index] ?? "0"])])
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
