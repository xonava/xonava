import type { CacheAdapter } from "core/cache"
import { ConfigurationError } from "core/domain"
import { assertCacheTtl, decodeCacheValue, encodeCacheValue } from "./cacheValueCodec"

const TAG_PREFIX = "__tag__"

export const DEFAULT_IN_MEMORY_CACHE_MAX_ENTRIES = 10_000
/** Maximum entries inspected for expiry by the opportunistic sweep per operation. */
const SWEEP_BATCH = 32

export interface InMemoryCacheAdapterOptions {
  /**
   * Upper bound on stored values. When full, the least recently used entry is
   * evicted (Map insertion order; reads and writes refresh recency).
   * Defaults to {@link DEFAULT_IN_MEMORY_CACHE_MAX_ENTRIES}.
   */
  maxEntries?: number
}

interface ValueRecord {
  /** Tagged-JSON encoded value (see cacheValueCodec); doubles as a defensive copy. */
  encoded: string
  expiresAt?: number
  revision: number
}

export class InMemoryCacheAdapter implements CacheAdapter {
  // Synchronous map mutations are atomic within this adapter's event loop, so
  // tag generations are linearizable, but only within a single JS process.
  // Correctness-critical callers must compose this adapter with a shared
  // generation store (SharedGenerationCacheAdapter) to fence across instances.
  readonly capabilities = { tagGenerationConsistency: "linearizable" as const, coherenceScope: "process" as const }
  private readonly maxEntries: number
  private values = new Map<string, ValueRecord>()
  /** Live revision per stored key; pruned together with the value. */
  private revisions = new Map<string, number>()
  private nextRevision = 0
  private tags = new Map<string, Map<string, number>>()
  /** Reverse index: key -> tag keys it is a member of, so removals prune memberships. */
  private keyTags = new Map<string, Set<string>>()
  // Generations are the shared fence and must stay monotonic: clear() never
  // resets them. They grow with the number of distinct tags only.
  private generations = new Map<string, string>()
  private sweepCursor: Iterator<string> | undefined

  constructor(options: InMemoryCacheAdapterOptions = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_IN_MEMORY_CACHE_MAX_ENTRIES
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new ConfigurationError("InMemoryCacheAdapter maxEntries must be a positive safe integer")
    }
    this.maxEntries = maxEntries
  }

  private isExpired(record: { expiresAt?: number } | undefined, now = Date.now()): boolean {
    return record?.expiresAt !== undefined && record.expiresAt <= now
  }

  /** Removes a key together with its revision and every tag membership. */
  private removeKey(key: string): boolean {
    const existed = this.values.delete(key)
    this.revisions.delete(key)
    const tagKeys = this.keyTags.get(key)
    if (tagKeys) {
      for (const tagKey of tagKeys) {
        const members = this.tags.get(tagKey)
        if (!members) continue
        members.delete(key)
        if (members.size === 0) this.tags.delete(tagKey)
      }
      this.keyTags.delete(key)
    }
    return existed
  }

  /** Bounded opportunistic expiry sweep; resumes where the previous one stopped. */
  private sweep(limit = SWEEP_BATCH): void {
    if (this.values.size === 0) {
      this.sweepCursor = undefined
      return
    }
    const now = Date.now()
    let wrapped = false
    for (let inspected = 0; inspected < limit; inspected++) {
      this.sweepCursor ??= this.values.keys()
      const next = this.sweepCursor.next()
      if (next.done) {
        this.sweepCursor = undefined
        if (wrapped) return
        wrapped = true
        continue
      }
      if (this.isExpired(this.values.get(next.value), now)) this.removeKey(next.value)
    }
  }

  private live(key: string): ValueRecord | undefined {
    const record = this.values.get(key)
    if (!record) return undefined
    if (this.isExpired(record)) {
      this.removeKey(key)
      return undefined
    }
    return record
  }

  private touch(key: string, record: ValueRecord): void {
    this.values.delete(key)
    this.values.set(key, record)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async get<T>(key: string): Promise<T | undefined> {
    this.sweep()
    const record = this.live(key)
    if (!record) return undefined
    this.touch(key, record)
    return decodeCacheValue<T>(JSON.parse(record.encoded))
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async set<T>(key: string, data: T, ttlMs?: number): Promise<void> {
    assertCacheTtl(ttlMs)
    const encoded = JSON.stringify(encodeCacheValue(data))
    this.sweep()
    const revision = ++this.nextRevision
    const record: ValueRecord = ttlMs !== undefined ? { encoded, expiresAt: Date.now() + ttlMs, revision } : { encoded, revision }
    if (!this.values.has(key)) {
      if (this.values.size >= this.maxEntries) this.sweep()
      while (this.values.size >= this.maxEntries) {
        const oldest = this.values.keys().next()
        if (oldest.done) break
        this.removeKey(oldest.value)
      }
    }
    this.values.delete(key)
    this.values.set(key, record)
    this.revisions.set(key, revision)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async delete(key: string): Promise<boolean> {
    this.sweep()
    const existed = this.live(key) !== undefined
    this.removeKey(key)
    return existed
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async has(key: string): Promise<boolean> {
    this.sweep()
    return this.live(key) !== undefined
  }

  /** Clears values and tag indexes. Tag generations are deliberately kept monotonic. */
  // eslint-disable-next-line @typescript-eslint/require-await
  async clear(): Promise<void> {
    this.values.clear()
    this.revisions.clear()
    this.tags.clear()
    this.keyTags.clear()
    this.sweepCursor = undefined
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async addToTag(tag: string, key: string): Promise<void> {
    this.sweep()
    const record = this.live(key)
    // Membership for an absent key has nothing to invalidate and would only grow.
    if (!record) return
    const tagKey = `${TAG_PREFIX}:${tag}`
    const keys = this.tags.get(tagKey) ?? new Map<string, number>()
    keys.set(key, record.revision)
    this.tags.set(tagKey, keys)
    const memberships = this.keyTags.get(key) ?? new Set<string>()
    memberships.add(tagKey)
    this.keyTags.set(key, memberships)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getTagKeys(tag: string): Promise<string[]> {
    this.sweep()
    const tagKey = `${TAG_PREFIX}:${tag}`
    return Array.from(this.tags.get(tagKey)?.keys() ?? []).filter((key) => this.live(key) !== undefined)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async deleteTag(tag: string): Promise<void> {
    const tagKey = `${TAG_PREFIX}:${tag}`
    const keys = this.tags.get(tagKey)
    this.tags.delete(tagKey)
    if (keys) {
      for (const [key, taggedRevision] of keys) {
        this.keyTags.get(key)?.delete(tagKey)
        if (taggedRevision === this.values.get(key)?.revision) this.removeKey(key)
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getTagGeneration(tag: string): Promise<string> {
    return this.generations.get(tag) ?? "0"
  }

  // A single map update is atomic within this adapter's event loop.
  // eslint-disable-next-line @typescript-eslint/require-await
  async advanceTagGeneration(tag: string): Promise<string> {
    const next = String(Number(this.generations.get(tag) ?? "0") + 1)
    this.generations.set(tag, next)
    return next
  }

}
