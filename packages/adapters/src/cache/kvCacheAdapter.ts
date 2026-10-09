import { CacheAdapterError, type CacheAdapter } from "core/cache"
import { assertCacheTtl, decodeCacheValue, encodeCacheValue } from "./cacheValueCodec"

declare class KVNamespace {
  get(key: string): Promise<string | null>
  get<T = unknown>(key: string, options: { type: "json" }): Promise<T | null>
  put(key: string, value: string | ArrayBuffer | ReadableStream, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: { name: string }[]
    list_complete: boolean
    cursor?: string
  }>
}

const TAG_PREFIX = "__tag__"
const CACHE_NS_PREFIX = "__cache__:"
/**
 * Tag generation counters live outside the cache namespace, so no cache key
 * (including CacheService's tagged storage keys `__generation__:"<gen>":<key>`)
 * can overwrite a counter and clear() can delete every cached value without
 * touching the counters.
 */
const GENERATION_NS_PREFIX = "__cachegen__:"
/** Previous layout: counters at `__cache__:__generation__:<tag>`, shared with tagged values. Read-only fallback. */
const LEGACY_GENERATION_PREFIX = "__generation__:"
const REVISION_PREFIX = "__revision__:"
/** Cloudflare KV rejects an expirationTtl below 60 seconds. */
export const KV_MIN_EXPIRATION_TTL_SECONDS = 60
/** Upper bound on members kept per KV tag list; the oldest members are dropped first. */
export const KV_MAX_TAG_MEMBERS = 1_000
const ENVELOPE_MARKER = "$cacheEnvelope"

/**
 * Stored payload. `e` is the logical expiry (epoch ms) enforced on read, since
 * KV's own expirationTtl has a 60s floor and only bounds storage lifetime.
 */
interface Envelope {
  [ENVELOPE_MARKER]: 1
  v: unknown
  e?: number
}

function isEnvelope(value: unknown): value is Envelope {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (value as Record<string, unknown>)[ENVELOPE_MARKER] === 1
}

function cacheKey(raw: string): string {
  return `${CACHE_NS_PREFIX}${raw}`
}

function generationKey(tag: string): string {
  return `${GENERATION_NS_PREFIX}${tag}`
}

function legacyGenerationKey(tag: string): string {
  return cacheKey(`${LEGACY_GENERATION_PREFIX}${tag}`)
}

function revisionKey(raw: string): string {
  return cacheKey(`${REVISION_PREFIX}${raw}`)
}

function logicalKey(key: string): string {
  return key.startsWith(CACHE_NS_PREFIX) ? key.slice(CACHE_NS_PREFIX.length) : key
}

type TagMember = {
  key: string
  revision: string
}

export class KvCacheAdapter implements CacheAdapter {
  // The KV payload is shared across instances; only the tag-generation
  // semantics are eventual. Correctness-critical callers must compose this
  // adapter with a shared generation store (SharedGenerationCacheAdapter).
  readonly capabilities = { tagGenerationConsistency: "eventual" as const, coherenceScope: "shared" as const }
  private kv: KVNamespace

  constructor(kv: KVNamespace) {
    this.kv = kv
  }

  private failure(operation: string, error: unknown): CacheAdapterError {
    return new CacheAdapterError(`kv.${operation}`, { cause: error })
  }

  /** Reads the stored payload, treating logically expired envelopes as misses. */
  private async readLive(key: string): Promise<{ value: unknown } | undefined> {
    const stored = await this.kv.get<unknown>(cacheKey(key), { type: "json" })
    if (stored === null) return undefined
    if (!isEnvelope(stored)) return { value: stored } // legacy plain-JSON entry
    if (stored.e !== undefined && stored.e <= Date.now()) {
      // Best effort: KV's own TTL removes the entry eventually anyway.
      await this.kv.delete(cacheKey(key)).catch(() => undefined)
      return undefined
    }
    return { value: decodeCacheValue(stored.v) }
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const live = await this.readLive(key)
      return live ? (live.value as T) : undefined
    } catch (error) {
      throw this.failure("get", error)
    }
  }

  async set<T>(key: string, data: T, ttlMs?: number): Promise<void> {
    // Validation errors are caller configuration faults, not adapter failures.
    assertCacheTtl(ttlMs)
    const envelope: Envelope = { [ENVELOPE_MARKER]: 1, v: encodeCacheValue(data) }
    if (ttlMs !== undefined) envelope.e = Date.now() + ttlMs
    const options = ttlMs !== undefined
      ? { expirationTtl: Math.max(KV_MIN_EXPIRATION_TTL_SECONDS, Math.ceil(ttlMs / 1000)) }
      : undefined
    try {
      await this.kv.put(cacheKey(key), JSON.stringify(envelope), options)
      await this.kv.put(revisionKey(key), JSON.stringify(`${Date.now()}:${crypto.randomUUID()}`), options)
    } catch (error) {
      throw this.failure("set", error)
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      const existed = await this.has(key)
      await this.kv.delete(cacheKey(key))
      await this.kv.delete(revisionKey(key))
      return existed
    } catch (error) {
      throw this.failure("delete", error)
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      return (await this.readLive(key)) !== undefined
    } catch (error) {
      throw this.failure("has", error)
    }
  }

  /**
   * Deletes every cached value (tagged or not), revision and tag list. Tag
   * generation counters are kept: they live in their own namespace and must
   * stay monotonic, so a resolver started before an invalidate+clear cannot
   * later look fresh. Counters still in the legacy layout (inside the cache
   * namespace) are first copied to the counter namespace, then removed with
   * everything else.
   */
  async clear(): Promise<void> {
    const legacyPrefix = cacheKey(LEGACY_GENERATION_PREFIX)
    try {
      let cursor: string | undefined
      do {
        const list = await this.kv.list(cursor ? { cursor, prefix: CACHE_NS_PREFIX } : { prefix: CACHE_NS_PREFIX })
        for (const k of list.keys) {
          if (k.name.startsWith(legacyPrefix)) await this.migrateLegacyGeneration(k.name.slice(legacyPrefix.length), k.name)
          await this.kv.delete(k.name)
        }
        cursor = list.list_complete ? undefined : list.cursor
      } while (cursor)
    } catch (error) {
      throw this.failure("clear", error)
    }
  }

  /** Copies a legacy counter (a bare JSON string, never a value envelope) unless the tag already has a current one. */
  private async migrateLegacyGeneration(tag: string, legacyKey: string): Promise<void> {
    const legacy = await this.kv.get<unknown>(legacyKey, { type: "json" })
    if (typeof legacy !== "string") return
    if ((await this.kv.get<unknown>(generationKey(tag), { type: "json" })) !== null) return
    await this.kv.put(generationKey(tag), JSON.stringify(legacy))
  }

  // Tag membership is a best-effort hint, never a correctness boundary.
  // Correctness-critical invalidation is generation-fenced
  // (advanceTagGeneration), which the CacheService uses exclusively for
  // correctness-critical mode; the membership list below may be lossy under
  // concurrent writers and must never be relied on for security. Lists are
  // deduped per key (latest revision wins) and capped at KV_MAX_TAG_MEMBERS,
  // dropping the oldest members, so deleteTag on a large tag is best-effort.
  async addToTag(tag: string, key: string): Promise<void> {
    try {
      const tagKey = cacheKey(`${TAG_PREFIX}:${tag}`)
      const existing = await this.kv.get<Array<string | TagMember>>(tagKey, { type: "json" })
      const revision = await this.kv.get<string>(revisionKey(key), { type: "json" })
      const canonicalKey = cacheKey(key)
      const members = (existing ?? []).map((member) => typeof member === "string" ? { key: cacheKey(member), revision: "" } : member)
      const current = revision ?? ""
      if (members.some((member) => member.key === canonicalKey && member.revision === current)) return
      const next = members.filter((member) => member.key !== canonicalKey)
      next.push({ key: canonicalKey, revision: current })
      await this.kv.put(tagKey, JSON.stringify(next.slice(-KV_MAX_TAG_MEMBERS)))
    } catch (error) {
      throw this.failure("addToTag", error)
    }
  }

  async getTagKeys(tag: string): Promise<string[]> {
    try {
      const tagKey = cacheKey(`${TAG_PREFIX}:${tag}`)
      const members = await this.kv.get<Array<string | TagMember>>(tagKey, { type: "json" })
      return (members ?? []).map((member) => logicalKey(typeof member === "string" ? member : member.key))
    } catch (error) {
      throw this.failure("getTagKeys", error)
    }
  }

  async deleteTag(tag: string): Promise<void> {
    try {
      const tagKey = cacheKey(`${TAG_PREFIX}:${tag}`)
      const members = await this.kv.get<Array<string | TagMember>>(tagKey, { type: "json" })
      if (members) {
        for (const member of members) {
          const tagged = typeof member === "string" ? { key: cacheKey(member), revision: "" } : member
          const currentRevision = await this.kv.get<string>(revisionKey(logicalKey(tagged.key)), { type: "json" })
          if (tagged.revision === "" || tagged.revision === currentRevision) {
            await this.kv.delete(tagged.key)
            if (tagged.revision !== "") await this.kv.delete(revisionKey(logicalKey(tagged.key)))
          }
        }
      }
      await this.kv.delete(tagKey)
    } catch (error) {
      throw this.failure("deleteTag", error)
    }
  }

  async getTagGeneration(tag: string): Promise<string> {
    try {
      const generation = await this.kv.get<unknown>(generationKey(tag), { type: "json" })
      if (typeof generation === "string") return generation
      // Fall back to a counter written by the previous key layout so an upgrade
      // never resets a generation (which could make stale tagged data readable).
      const legacy = await this.kv.get<unknown>(legacyGenerationKey(tag), { type: "json" })
      return typeof legacy === "string" ? legacy : "0"
    } catch (error) {
      throw this.failure("getTagGeneration", error)
    }
  }

  async advanceTagGeneration(tag: string): Promise<string> {
    // KV writes are not linearizable across readers, so this adapter is never
    // suitable for correctness-critical cache reads.
    try {
      const generation = `${Date.now()}:${crypto.randomUUID()}`
      await this.kv.put(generationKey(tag), JSON.stringify(generation))
      return generation
    } catch (error) {
      throw this.failure("advanceTagGeneration", error)
    }
  }

}
