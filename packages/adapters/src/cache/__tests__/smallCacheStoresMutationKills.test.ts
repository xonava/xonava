import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SQLiteSyncDialect, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { SQL } from "drizzle-orm"
import { buildKey, CacheAdapterError, type CacheAdapter } from "@xonava/core/cache"
import { ConfigurationError, UnavailableError } from "@xonava/core/domain"
import { AtomicCacheBackedRateLimitStore, CacheBackedRateLimitStore } from "../cacheBackedRateLimitStore"
import { createDbTagGenerationStore, type AnyDrizzleDatabase } from "../dbTagGenerationStore"
import { InMemoryRateLimitStore } from "../inMemoryRateLimitStore"

const generationTable = sqliteTable("tag_generations", {
  tag: text("tag").primaryKey(),
  generation: integer("generation").notNull(),
})

function selectDb(rows: unknown[], capture?: { where?: SQL }): AnyDrizzleDatabase {
  return {
    select: () => ({
      from: () => ({
        where: (where: SQL) => {
          if (capture) capture.where = where
          return { limit: (n: number) => Promise.resolve(n === 1 ? rows : []) }
        },
      }),
    }),
  } as unknown as AnyDrizzleDatabase
}

function insertDb(rows: unknown[]): AnyDrizzleDatabase {
  return {
    insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ returning: () => Promise.resolve(rows) }) }) }),
  } as unknown as AnyDrizzleDatabase
}

describe("DbTagGenerationStore mutation kills", () => {
  it("filters on the requested tag with a bound parameter and a limit of one", async () => {
    const capture: { where?: SQL } = {}
    const store = createDbTagGenerationStore({ db: selectDb([{ generation: 3 }], capture), table: generationTable })
    await expect(store.getTagGeneration("users:42")).resolves.toBe("3")
    const query = new SQLiteSyncDialect().sqlToQuery(capture.where as SQL)
    expect(query.sql).toBe("tag = ?")
    expect(query.params).toEqual(["users:42"])
  })

  it.each([["a string", "5"], ["null", null], ["undefined", undefined], ["a bigint", 5n]])(
    "treats a non-numeric stored generation (%s) as 0",
    async (_label, generation) => {
      const store = createDbTagGenerationStore({ db: selectDb([{ generation }]), table: generationTable })
      await expect(store.getTagGeneration("t")).resolves.toBe("0")
    },
  )

  it("returns 0 when the select yields no row", async () => {
    const store = createDbTagGenerationStore({ db: selectDb([]), table: generationTable })
    await expect(store.getTagGeneration("t")).resolves.toBe("0")
  })

  it("stringifies a zero generation instead of defaulting", async () => {
    const store = createDbTagGenerationStore({ db: selectDb([{ generation: 0 }]), table: generationTable })
    await expect(store.getTagGeneration("t")).resolves.toBe("0")
    const advance = createDbTagGenerationStore({ db: insertDb([{ generation: 0 }]), table: generationTable })
    await expect(advance.advanceTagGeneration("t")).resolves.toBe("0")
  })

  it.each([["no row", []], ["a string generation", [{ generation: "2" }]], ["a null generation", [{ generation: null }]]])(
    "fails advance with a CacheAdapterError carrying a cause for %s",
    async (_label, rows) => {
      const store = createDbTagGenerationStore({ db: insertDb(rows), table: generationTable })
      const failure = await store.advanceTagGeneration("t").catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(CacheAdapterError)
      expect((failure as CacheAdapterError).operation).toBe("advanceTagGeneration")
      expect((failure as CacheAdapterError).message).toBe("Cache operation failed: advanceTagGeneration")
      expect(((failure as CacheAdapterError).cause as Error).message).toBe(
        "Shared generation store did not return an incremented generation",
      )
    },
  )
})

describe("CacheBackedRateLimitStore mutation kills", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function recordingCache(initial?: { count: number; resetAt: number }) {
    const get = vi.fn((_key: string) => Promise.resolve(initial))
    const set = vi.fn((_key: string, _value: unknown, _ttl?: number) => Promise.resolve())
    return { cache: { get, set } as unknown as CacheAdapter, get, set }
  }

  it("is not atomic", () => {
    expect(new CacheBackedRateLimitStore(recordingCache().cache).supportsAtomic).toBe(false)
  })

  it("opens a fresh window under the rate bucket key with a ttl equal to the window", async () => {
    const { cache, get, set } = recordingCache()
    const result = await new CacheBackedRateLimitStore(cache).increment("ip:1", 5_000)
    const key = buildKey("rate", "ip:1", "bucket")
    expect(get).toHaveBeenCalledWith(key)
    expect(set).toHaveBeenCalledWith(key, { count: 1, resetAt: 6_000 }, 5_000)
    expect(result).toEqual({ count: 1, resetAt: 6_000 })
  })

  it("continues a live window and uses the remaining time as ttl", async () => {
    const { cache, set } = recordingCache({ count: 4, resetAt: 3_500 })
    const result = await new CacheBackedRateLimitStore(cache).increment("k", 10_000)
    expect(result).toEqual({ count: 5, resetAt: 3_500 })
    expect(set.mock.calls[0]?.[2]).toBe(2_500)
  })

  it("does not mutate the stored bucket object", async () => {
    const stored = { count: 1, resetAt: 3_000 }
    const { cache } = recordingCache(stored)
    await new CacheBackedRateLimitStore(cache).increment("k", 10_000)
    expect(stored).toEqual({ count: 1, resetAt: 3_000 })
  })

  it("starts a new window when the stored one ends exactly now", async () => {
    const { cache } = recordingCache({ count: 9, resetAt: 1_000 })
    const result = await new CacheBackedRateLimitStore(cache).increment("k", 2_000)
    expect(result).toEqual({ count: 1, resetAt: 3_000 })
  })

  it("keeps a window that ends one millisecond from now", async () => {
    const { cache, set } = recordingCache({ count: 9, resetAt: 1_001 })
    const result = await new CacheBackedRateLimitStore(cache).increment("k", 2_000)
    expect(result).toEqual({ count: 10, resetAt: 1_001 })
    expect(set.mock.calls[0]?.[2]).toBe(1)
  })
})

describe("AtomicCacheBackedRateLimitStore mutation kills", () => {
  it("delegates increment and incrementAtomically to the backend with the namespaced key", async () => {
    const incrementRateLimitAtomically = vi.fn((_key: string, _windowMs: number) =>
      Promise.resolve({ count: 3, resetAt: 99 }),
    )
    const store = new AtomicCacheBackedRateLimitStore({ incrementRateLimitAtomically })
    const key = buildKey("rate", "user:1", "bucket")
    await expect(store.increment("user:1", 700)).resolves.toEqual({ count: 3, resetAt: 99 })
    await expect(store.incrementAtomically("user:1", 800)).resolves.toEqual({ count: 3, resetAt: 99 })
    expect(incrementRateLimitAtomically.mock.calls).toEqual([[key, 700], [key, 800]])
  })
})

interface StoreInternals {
  buckets: Map<string, { count: number; resetAt: number }>
  sweepCursor: Iterator<string> | undefined
}

function internals(store: InMemoryRateLimitStore): StoreInternals {
  return store as unknown as StoreInternals
}

describe("InMemoryRateLimitStore mutation kills", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects maxBuckets %s with an exact message", (maxBuckets) => {
    const build = () => new InMemoryRateLimitStore(() => 0, { maxBuckets })
    expect(build).toThrow(ConfigurationError)
    expect(build).toThrow("InMemoryRateLimitStore maxBuckets must be a positive safe integer")
  })

  it("rejects an unsupported algorithm naming it", async () => {
    const store = new InMemoryRateLimitStore(() => 0)
    const request = { key: "k", windowMs: 10, algorithm: "token-bucket", cost: 1 } as never
    await expect(store.consumeAtomically(request)).rejects.toThrow("Unsupported rate-limit algorithm: token-bucket")
  })

  it("applies the request cost and returns a copy of the bucket", async () => {
    const store = new InMemoryRateLimitStore(() => 100)
    const first = await store.consumeAtomically({ key: "k", windowMs: 50, algorithm: "fixed-window", cost: 3 })
    expect(first).toEqual({ count: 3, resetAt: 150 })
    first.count = 99
    const second = await store.consumeAtomically({ key: "k", windowMs: 50, algorithm: "fixed-window", cost: 2 })
    expect(second).toEqual({ count: 5, resetAt: 150 })
  })

  it("fails closed with an exact UnavailableError at capacity", async () => {
    const store = new InMemoryRateLimitStore(() => 0, { maxBuckets: 1 })
    await store.increment("a", 1_000)
    const failure = await store.increment("b", 1_000).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(UnavailableError)
    expect((failure as Error).message).toBe("In-memory rate-limit store is at capacity.")
    expect(internals(store).buckets.has("b")).toBe(false)
  })

  describe("sweeping", () => {
    function fill(now: { value: number }, total: number, shortAt: readonly number[], maxBuckets = 1_000) {
      const store = new InMemoryRateLimitStore(() => now.value, { maxBuckets })
      return { store, setup: async () => {
        for (let i = 0; i < total; i++) {
          await store.increment(`k${i}`, shortAt.includes(i) ? 10 : 100_000)
        }
        internals(store).sweepCursor = undefined
      } }
    }

    it("inspects exactly 32 buckets per call", async () => {
      const now = { value: 0 }
      const { store, setup } = fill(now, 40, Array.from({ length: 40 }, (_, i) => i))
      await setup()
      now.value = 100
      await store.increment("fresh", 1_000)
      // 40 expired - 32 swept + the new bucket.
      expect(internals(store).buckets.size).toBe(9)
    })

    it("sweeps a bucket that expires exactly now", async () => {
      const now = { value: 0 }
      const { store, setup } = fill(now, 2, [0])
      await setup()
      now.value = 10
      await store.increment("other", 1_000)
      expect(internals(store).buckets.has("k0")).toBe(false)
    })

    it("does not sweep a bucket that expires after now", async () => {
      const now = { value: 0 }
      const { store, setup } = fill(now, 2, [0])
      await setup()
      now.value = 9
      await store.increment("other", 1_000)
      expect(internals(store).buckets.has("k0")).toBe(true)
    })

    it("restarts the sweep from the beginning after the cursor is exhausted", async () => {
      const now = { value: 0 }
      const { store, setup } = fill(now, 3, [1])
      await setup()
      const exhausted = internals(store).buckets.keys()
      for (const _key of exhausted) void _key
      internals(store).sweepCursor = exhausted
      now.value = 10
      await store.increment("other", 1_000)
      expect(internals(store).buckets.has("k1")).toBe(false)
    })

    it("renews a bucket expiring exactly now instead of continuing it", async () => {
      const now = { value: 0 }
      const shortIdx = 40
      const { store, setup } = fill(now, 41, [shortIdx])
      await setup()
      now.value = 10
      // k40 is beyond the 32-bucket sweep, so only the window check can renew it.
      await expect(store.consumeAtomically({ key: "k40", windowMs: 10, algorithm: "fixed-window", cost: 1 })).resolves.toEqual({ count: 1, resetAt: 20 })
      now.value = 19
      await expect(store.consumeAtomically({ key: "k40", windowMs: 10, algorithm: "fixed-window", cost: 1 })).resolves.toEqual({ count: 2, resetAt: 20 })
    })

    it("moves a renewed bucket to the end of the sweep order", async () => {
      const now = { value: 0 }
      const { store, setup } = fill(now, 41, [40])
      await setup()
      now.value = 10
      await store.increment("k40", 10)
      expect(Array.from(internals(store).buckets.keys()).at(-1)).toBe("k40")
      expect(internals(store).buckets.size).toBe(41)
    })

    it("lets an existing key renew at capacity without a capacity sweep", async () => {
      const now = { value: 0 }
      const { store, setup } = fill(now, 40, [35, 38], 40)
      await setup()
      now.value = 10
      // k38 is beyond the per-call sweep; renewing it must not trigger the (larger) capacity sweep.
      await store.increment("k38", 10)
      expect(internals(store).buckets.size).toBe(40)
      expect(internals(store).buckets.has("k35")).toBe(true)
    })

    it("admits a new key at capacity once the capacity sweep frees expired buckets", async () => {
      const now = { value: 0 }
      const { store, setup } = fill(now, 40, [36, 39], 40)
      await setup()
      now.value = 10
      await expect(store.increment("fresh", 1_000)).resolves.toEqual({ count: 1, resetAt: 1_010 })
      expect(internals(store).buckets.size).toBe(39)
      expect(internals(store).buckets.has("k36")).toBe(false)
      expect(internals(store).buckets.has("k39")).toBe(false)
    })

    it("still fails closed at capacity when the capacity sweep finds nothing expired", async () => {
      const now = { value: 0 }
      const { store, setup } = fill(now, 40, [], 40)
      await setup()
      now.value = 10
      await expect(store.increment("fresh", 1_000)).rejects.toBeInstanceOf(UnavailableError)
      expect(internals(store).buckets.size).toBe(40)
    })
  })
})
