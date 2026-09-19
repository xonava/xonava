import { CacheAdapterError, type CacheAdapter } from "core/cache"

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
const GENERATION_PREFIX = "__generation__:"
const REVISION_PREFIX = "__revision__:"

function cacheKey(raw: string): string {
  return `${CACHE_NS_PREFIX}${raw}`
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

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const value = await this.kv.get(cacheKey(key), { type: "json" })
      return value === null ? undefined : (value as T)
    } catch (error) {
      throw this.failure("get", error)
    }
  }

  async set<T>(key: string, data: T, ttlMs?: number): Promise<void> {
    try {
      const options = ttlMs ? { expirationTtl: Math.ceil(ttlMs / 1000) } : undefined
      await this.kv.put(cacheKey(key), JSON.stringify(data), options)
      await this.kv.put(revisionKey(key), JSON.stringify(`${Date.now()}:${crypto.randomUUID()}`))
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
      const value = await this.kv.get(cacheKey(key))
      return value !== null
    } catch (error) {
      throw this.failure("has", error)
    }
  }

  async clear(): Promise<void> {
    try {
      let cursor: string | undefined
      do {
        const list = await this.kv.list(cursor ? { cursor, prefix: CACHE_NS_PREFIX } : { prefix: CACHE_NS_PREFIX })
        for (const k of list.keys) {
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
  // concurrent writers and must never be relied on for security.
  async addToTag(tag: string, key: string): Promise<void> {
    try {
      const tagKey = cacheKey(`${TAG_PREFIX}:${tag}`)
      const existing = await this.kv.get<Array<string | TagMember>>(tagKey, { type: "json" })
      const revision = await this.kv.get<string>(revisionKey(key), { type: "json" })
      const canonicalKey = cacheKey(key)
      const members = (existing ?? []).map((member) => typeof member === "string" ? { key: cacheKey(member), revision: "" } : member)
      if (!members.some((member) => member.key === canonicalKey && member.revision === (revision ?? ""))) {
        members.push({ key: canonicalKey, revision: revision ?? "" })
        await this.kv.put(tagKey, JSON.stringify(members))
      }
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
      const generation = await this.kv.get<string>(cacheKey(`${GENERATION_PREFIX}${tag}`), { type: "json" })
      return generation ?? "0"
    } catch (error) {
      throw this.failure("getTagGeneration", error)
    }
  }

  async advanceTagGeneration(tag: string): Promise<string> {
    // KV writes are not linearizable across readers, so this adapter is never
    // suitable for correctness-critical cache reads.
    try {
      const generation = `${Date.now()}:${crypto.randomUUID()}`
      await this.kv.put(cacheKey(`${GENERATION_PREFIX}${tag}`), JSON.stringify(generation))
      return generation
    } catch (error) {
      throw this.failure("advanceTagGeneration", error)
    }
  }

}
