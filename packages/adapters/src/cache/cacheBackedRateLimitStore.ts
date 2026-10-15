import { buildKey, type CacheAdapter } from "@xonava/core/cache"
import type { AtomicRateLimitStore, RateLimitStore } from "@xonava/core/rate-limit"

interface Bucket {
  count: number
  resetAt: number
}

/**
 * Best-effort rate limiting. This store performs a non-atomic read-modify-write
 * and must only be selected for `consistency: "best-effort"` routes. Atomic
 * consistency requires an AtomicRateLimitStore and is enforced by
 * checkRateLimit and the write handlers.
 */
export class CacheBackedRateLimitStore implements RateLimitStore {
  readonly supportsAtomic = false

  constructor(private readonly cache: CacheAdapter) {}

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const bucketKey = buildKey("rate", key, "bucket")
    const now = Date.now()
    const existing = await this.cache.get<Bucket>(bucketKey)

    const bucket = existing && existing.resetAt > now
      ? { ...existing }
      : { count: 0, resetAt: now + windowMs }

    bucket.count += 1

    await this.cache.set(bucketKey, bucket, Math.max(bucket.resetAt - now, 1))

    return bucket
  }
}

export class AtomicCacheBackedRateLimitStore implements AtomicRateLimitStore {
  constructor(private readonly backend: { incrementRateLimitAtomically(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> }) {}

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    return this.incrementAtomically(key, windowMs)
  }

  async incrementAtomically(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    return this.backend.incrementRateLimitAtomically(buildKey("rate", key, "bucket"), windowMs)
  }
}
