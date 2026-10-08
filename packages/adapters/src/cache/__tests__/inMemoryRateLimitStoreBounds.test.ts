import { describe, expect, it } from "vitest"
import { ConfigurationError, UnavailableError } from "core/domain"
import { checkRateLimit } from "core/rate-limit"
import { InMemoryRateLimitStore } from "../inMemoryRateLimitStore"

function bucketCount(store: InMemoryRateLimitStore): number {
  return (store as unknown as { buckets: Map<string, unknown> }).buckets.size
}

describe("defect 4: InMemoryRateLimitStore is bounded", () => {
  it("sweeps expired buckets opportunistically", async () => {
    let now = 0
    const store = new InMemoryRateLimitStore(() => now)
    for (let i = 0; i < 5_000; i++) await store.increment(`ip${i}`, 10)
    now = 100
    for (let i = 0; i < 200; i++) await store.increment("steady", 10)
    expect(bucketCount(store)).toBe(1)
  })

  it("caps the bucket count and fails closed with UnavailableError when nothing is expired", async () => {
    let now = 0
    const store = new InMemoryRateLimitStore(() => now, { maxBuckets: 3 })
    await store.increment("a", 1_000)
    await store.increment("b", 1_000)
    await store.increment("c", 1_000)
    await expect(store.increment("d", 1_000)).rejects.toBeInstanceOf(UnavailableError)
    // Existing keys keep being counted at capacity.
    await expect(store.increment("a", 1_000)).resolves.toMatchObject({ count: 2 })
    expect(bucketCount(store)).toBe(3)
    now = 2_000
    await expect(store.increment("d", 1_000)).resolves.toMatchObject({ count: 1 })
    expect(bucketCount(store)).toBeLessThanOrEqual(3)
  })

  it("lets the core failure policy decide at capacity", async () => {
    const store = new InMemoryRateLimitStore(() => 0, { maxBuckets: 1 })
    await store.increment("a", 1_000)
    await expect(checkRateLimit({ store, key: "b", limit: 3, windowMs: 1_000 })).rejects.toBeInstanceOf(UnavailableError)
  })

  it("rejects an unsupported algorithm with ConfigurationError", async () => {
    const store = new InMemoryRateLimitStore()
    await expect(store.consumeAtomically({ key: "k", windowMs: 1_000, algorithm: "token-bucket", cost: 1 })).rejects.toBeInstanceOf(ConfigurationError)
  })

  it("rejects an invalid maxBuckets", () => {
    expect(() => new InMemoryRateLimitStore(Date.now, { maxBuckets: 0 })).toThrow(ConfigurationError)
  })
})
