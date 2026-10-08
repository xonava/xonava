import { ConfigurationError, UnavailableError } from "core/domain"
import type { AtomicRateLimitStore, RateLimitConsumeRequest, RateLimitStoreCapabilities } from "core/rate-limit"

export const DEFAULT_IN_MEMORY_RATE_LIMIT_MAX_BUCKETS = 100_000
/** Buckets inspected for expiry per call (and per call while at capacity). */
const SWEEP_BATCH = 32
const CAPACITY_SWEEP_BATCH = 1_024

export interface InMemoryRateLimitStoreOptions {
  /**
   * Upper bound on live buckets. Expired buckets are removed opportunistically
   * with a bounded sweep on every call. When the store is full and no expired
   * bucket is found, a NEW key fails closed with UnavailableError (existing
   * keys keep counting) so the core rate-limit failure policy decides. Evicting
   * a live bucket instead would only make the limit more permissive for the
   * evicted key, which an attacker rotating keys could exploit.
   */
  maxBuckets?: number
}

export class InMemoryRateLimitStore implements AtomicRateLimitStore {
  readonly capabilities: RateLimitStoreCapabilities = Object.freeze({ algorithms: Object.freeze(["fixed-window"] as const), weightedCost: true })
  private readonly buckets = new Map<string, { count: number; resetAt: number }>()
  private readonly maxBuckets: number
  private sweepCursor: Iterator<string> | undefined

  constructor(private readonly nowMs: () => number = Date.now, options: InMemoryRateLimitStoreOptions = {}) {
    const maxBuckets = options.maxBuckets ?? DEFAULT_IN_MEMORY_RATE_LIMIT_MAX_BUCKETS
    if (!Number.isSafeInteger(maxBuckets) || maxBuckets <= 0) {
      throw new ConfigurationError("InMemoryRateLimitStore maxBuckets must be a positive safe integer")
    }
    this.maxBuckets = maxBuckets
  }

  async increment(key: string, windowMs: number) { return this.consumeAtomically({ key, windowMs, algorithm: "fixed-window", cost: 1 }) }
  async incrementAtomically(key: string, windowMs: number) { return this.increment(key, windowMs) }

  /** Bounded expiry sweep that resumes where the previous one stopped. */
  private sweep(now: number, limit: number): void {
    let wrapped = false
    for (let inspected = 0; inspected < limit && this.buckets.size > 0; inspected++) {
      this.sweepCursor ??= this.buckets.keys()
      const next = this.sweepCursor.next()
      if (next.done) {
        this.sweepCursor = undefined
        if (wrapped) return
        wrapped = true
        continue
      }
      const bucket = this.buckets.get(next.value)
      if (bucket && bucket.resetAt <= now) this.buckets.delete(next.value)
    }
  }

  // A synchronous map update is atomic inside this reference adapter's process.
  // eslint-disable-next-line @typescript-eslint/require-await
  async consumeAtomically(request: RateLimitConsumeRequest): Promise<{ count: number; resetAt: number }> {
    if (request.algorithm !== "fixed-window") throw new ConfigurationError(`Unsupported rate-limit algorithm: ${String(request.algorithm)}`)
    const now = this.nowMs()
    this.sweep(now, SWEEP_BATCH)
    const current = this.buckets.get(request.key)
    let bucket: { count: number; resetAt: number }
    if (current && current.resetAt > now) {
      bucket = current
    } else {
      if (!current && this.buckets.size >= this.maxBuckets) {
        this.sweep(now, CAPACITY_SWEEP_BATCH)
        if (this.buckets.size >= this.maxBuckets) {
          throw new UnavailableError("In-memory rate-limit store is at capacity.")
        }
      }
      bucket = { count: 0, resetAt: now + request.windowMs }
      // Re-insert so Map order approximates window start order for the sweep.
      this.buckets.delete(request.key)
      this.buckets.set(request.key, bucket)
    }
    bucket.count += request.cost
    return { ...bucket }
  }
}
