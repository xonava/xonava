import type { CacheAdapter } from "core/cache"
import type { TagGenerationStore } from "./dbTagGenerationStore"

export interface SharedGenerationCacheAdapterArgs {
  /** Fast payload adapter (KV or in-memory) whose payload semantics are unchanged. */
  payload: CacheAdapter
  /** Shared, genuinely linearizable generation source (e.g. DbTagGenerationStore). */
  generations: TagGenerationStore
}

/**
 * Composes a fast payload adapter with a shared generation store so the
 * resulting adapter is both fast and correctness-critical safe: reads and
 * writes stay on the payload adapter while tag generations are fenced by a
 * single atomic counter table in the application DB.
 */
export class SharedGenerationCacheAdapter implements CacheAdapter {
  readonly capabilities = { tagGenerationConsistency: "linearizable" as const, coherenceScope: "shared" as const }
  private readonly payload: CacheAdapter
  private readonly generations: TagGenerationStore

  constructor(args: SharedGenerationCacheAdapterArgs) {
    this.payload = args.payload
    this.generations = args.generations
    // Preserve presence semantics so atomic rate-limit callers can detect
    // whether the composed adapter actually supports the primitive.
  }

  get<T>(key: string): Promise<T | undefined> {
    return this.payload.get<T>(key)
  }

  set<T>(key: string, data: T, ttlMs?: number): Promise<void> {
    return this.payload.set(key, data, ttlMs)
  }

  delete(key: string): Promise<boolean> {
    return this.payload.delete(key)
  }

  has(key: string): Promise<boolean> {
    return this.payload.has(key)
  }

  clear(): Promise<void> {
    return this.payload.clear()
  }

  addToTag(tag: string, key: string): Promise<void> {
    return this.payload.addToTag(tag, key)
  }

  getTagKeys(tag: string): Promise<string[]> {
    return this.payload.getTagKeys(tag)
  }

  deleteTag(tag: string): Promise<void> {
    return this.payload.deleteTag(tag)
  }

  getTagGeneration(tag: string): Promise<string> {
    return this.generations.getTagGeneration(tag)
  }

  advanceTagGeneration(tag: string): Promise<string> {
    return this.generations.advanceTagGeneration(tag)
  }
}
