import type { CacheAdapter } from "core/cache"

const TAG_PREFIX = "__tag__"

export class InMemoryCacheAdapter implements CacheAdapter {
  // Synchronous map mutations are atomic within this adapter's event loop, so
  // tag generations are linearizable, but only within a single JS process.
  // Correctness-critical callers must compose this adapter with a shared
  // generation store (SharedGenerationCacheAdapter) to fence across instances.
  readonly capabilities = { tagGenerationConsistency: "linearizable" as const, coherenceScope: "process" as const }
  private values = new Map<string, { value: unknown; expiresAt?: number; revision: number }>()
  private revisions = new Map<string, number>()
  private tags = new Map<string, Map<string, number>>()
  private generations = new Map<string, string>()

  private isExpired(record: { expiresAt?: number } | undefined): boolean {
    return record?.expiresAt !== undefined && record.expiresAt <= Date.now()
  }

  private clone<T>(value: T): T {
    return structuredClone(value)
  }

  private pruneIfExpired(key: string): void {
    const record = this.values.get(key)
    if (this.isExpired(record)) {
      this.values.delete(key)
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async get<T>(key: string): Promise<T | undefined> {
    this.pruneIfExpired(key)
    const record = this.values.get(key)
    return record ? this.clone(record.value as T) : undefined
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async set<T>(key: string, data: T, ttlMs?: number): Promise<void> {
    const value = this.clone(data)
    const revision = (this.revisions.get(key) ?? 0) + 1
    this.revisions.set(key, revision)
    this.values.set(key, ttlMs ? { value, expiresAt: Date.now() + ttlMs, revision } : { value, revision })
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async delete(key: string): Promise<boolean> {
    return this.values.delete(key)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async has(key: string): Promise<boolean> {
    this.pruneIfExpired(key)
    return this.values.has(key)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async clear(): Promise<void> {
    this.values.clear()
    this.revisions.clear()
    this.tags.clear()
    this.generations.clear()
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async addToTag(tag: string, key: string): Promise<void> {
    const tagKey = `${TAG_PREFIX}:${tag}`
    const keys = this.tags.get(tagKey) ?? new Map<string, number>()
    keys.set(key, this.revisions.get(key) ?? 0)
    this.tags.set(tagKey, keys)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getTagKeys(tag: string): Promise<string[]> {
    const tagKey = `${TAG_PREFIX}:${tag}`
    return Array.from(this.tags.get(tagKey)?.keys() ?? [])
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async deleteTag(tag: string): Promise<void> {
    const tagKey = `${TAG_PREFIX}:${tag}`
    const keys = this.tags.get(tagKey)
    if (keys) {
      for (const [key, taggedRevision] of keys) {
        if (taggedRevision === this.values.get(key)?.revision) this.values.delete(key)
      }
    }
    this.tags.delete(tagKey)
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
