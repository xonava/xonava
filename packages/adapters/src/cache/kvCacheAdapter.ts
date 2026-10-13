import { CacheAdapterError, type CacheAdapter } from "core/cache"
import { ValidationError } from "core/domain"
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
/**
 * Previous layout: counters at `__cache__:__generation__:<tag>`, sharing a
 * prefix with tagged values. During a rolling deploy, instances on the previous
 * release read and advance only this key, so this release observes both
 * counters (see compositeGeneration) and advances both. Remove the legacy
 * counter (reads, writes and the clear() exemption) one release after every
 * instance runs this layout.
 */
const LEGACY_GENERATION_PREFIX = "__generation__:"

/**
 * The observed generation of a tag is the pair of both counters, so a change
 * to EITHER key fences previously cached values. CacheService compares
 * generations only by equality and keys values by them; nothing here orders
 * generations by time, so clock skew between instances cannot hide an advance.
 * In the steady state both counters hold the same value and it is returned
 * as is, which keeps generation-qualified cache keys short (KV keys are capped
 * at 512 bytes and each tag's generation appears in the key). Differing
 * counters are reported as `h:` + the base64url SHA-256 of the JSON pair, a
 * fixed 45-character token: the raw pair cost ~107 bytes per tag and pushed
 * multi-tag keys past the cap, after which `put` threw and nothing was cached.
 * A digest (256 bits, so a collision serving stale data is infeasible) is
 * different for every distinct pair, and starts with "h:", so it never equals a
 * single `ms:uuid` counter or "0" (neither counter exists yet).
 */
async function compositeGeneration(current: string | undefined, legacy: string | undefined): Promise<string> {
  if (current === undefined && legacy === undefined) return "0"
  if (current !== undefined && current === legacy) return current
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([current ?? null, legacy ?? null])))
  let binary = ""
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte)
  return `h:${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`
}
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

/**
 * Caller keys share the `__cache__:` namespace with tag lists (`__tag__:`),
 * revisions (`__revision__:`) and legacy generation counters
 * (`__generation__:<tag>`), so a raw key spelled like one could read or
 * overwrite bookkeeping. CacheService's tagged storage keys are
 * `__generation__:"<gen>":<key>` (the generation is a quoted JSON string) and
 * stay valid; every other key under an internal prefix is rejected.
 */
function assertCallerKey(key: string): void {
  if (typeof key !== "string") return
  const reserved = key.startsWith(`${TAG_PREFIX}:`)
    || key.startsWith(REVISION_PREFIX)
    || (key.startsWith(LEGACY_GENERATION_PREFIX) && key[LEGACY_GENERATION_PREFIX.length] !== '"')
  if (reserved) throw new ValidationError("Cache key collides with a reserved internal key prefix")
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
    assertCallerKey(key)
    try {
      const live = await this.readLive(key)
      return live ? (live.value as T) : undefined
    } catch (error) {
      throw this.failure("get", error)
    }
  }

  async set<T>(key: string, data: T, ttlMs?: number): Promise<void> {
    // Validation errors are caller configuration faults, not adapter failures.
    assertCallerKey(key)
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
    assertCallerKey(key)
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
    assertCallerKey(key)
    try {
      return (await this.readLive(key)) !== undefined
    } catch (error) {
      throw this.failure("has", error)
    }
  }

  /**
   * Deletes every cached value (tagged or not), revision and tag list. Tag
   * generation counters are kept, in both layouts: they must stay monotonic so
   * a resolver started before an invalidate+clear cannot later look fresh.
   * Under the legacy prefix a counter is a bare JSON string while a tagged
   * value is a value envelope, which tells them apart.
   */
  async clear(): Promise<void> {
    const legacyPrefix = cacheKey(LEGACY_GENERATION_PREFIX)
    try {
      let cursor: string | undefined
      do {
        const list = await this.kv.list(cursor ? { cursor, prefix: CACHE_NS_PREFIX } : { prefix: CACHE_NS_PREFIX })
        for (const k of list.keys) {
          if (k.name.startsWith(legacyPrefix) && typeof (await this.kv.get<unknown>(k.name, { type: "json" })) === "string") continue
          await this.kv.delete(k.name)
        }
        cursor = list.list_complete ? undefined : list.cursor
      } while (cursor)
    } catch (error) {
      throw this.failure("clear", error)
    }
  }

  // Tag membership is a best-effort hint, never a correctness boundary.
  // Correctness-critical invalidation is generation-fenced
  // (advanceTagGeneration), which the CacheService uses exclusively for
  // correctness-critical mode; the membership list below may be lossy under
  // concurrent writers and must never be relied on for security. Lists are
  // deduped per key (latest revision wins) and capped at KV_MAX_TAG_MEMBERS,
  // dropping the oldest members, so deleteTag on a large tag is best-effort.
  async addToTag(tag: string, key: string): Promise<void> {
    assertCallerKey(key)
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
      let current = await this.readCounter(generationKey(tag))
      // Also read the previous layout: an upgrade must never reset a generation,
      // and an instance still on the previous release advances only that key.
      const legacy = await this.readCounter(legacyGenerationKey(tag))
      if (current === undefined && legacy !== undefined) current = await this.adoptLegacyCounter(tag, legacy)
      return await compositeGeneration(current, legacy)
    } catch (error) {
      throw this.failure("getTagGeneration", error)
    }
  }

  private async readCounter(key: string): Promise<string | undefined> {
    const value = await this.kv.get<unknown>(key, { type: "json" })
    return typeof value === "string" ? value : undefined
  }

  /**
   * Self-healing after an upgrade: a counter only the previous release wrote
   * would otherwise report the (bounded, but never converging) pair for ever.
   * Copies the legacy value into the current key, re-reading first so a new-release
   * advance landing in between is not overwritten. Best effort and never thrown: on
   * failure the pair token is still correct, only less cacheable.
   */
  private async adoptLegacyCounter(tag: string, legacy: string): Promise<string | undefined> {
    try {
      const fresh = await this.readCounter(generationKey(tag))
      if (fresh !== undefined) return fresh
      await this.kv.put(generationKey(tag), JSON.stringify(legacy))
      return legacy
    } catch {
      return undefined
    }
  }

  async advanceTagGeneration(tag: string): Promise<string> {
    // KV writes are not linearizable across readers, so this adapter is never
    // suitable for correctness-critical cache reads.
    try {
      const generation = `${Date.now()}:${crypto.randomUUID()}`
      // Legacy first: instances on the previous release read only that key, and
      // a reader between the two writes already observes a changed pair.
      await this.kv.put(legacyGenerationKey(tag), JSON.stringify(generation))
      await this.kv.put(generationKey(tag), JSON.stringify(generation))
      return generation
    } catch (error) {
      throw this.failure("advanceTagGeneration", error)
    }
  }

}
