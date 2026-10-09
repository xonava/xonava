import { afterEach, describe, expect, it, vi } from "vitest"
import { CacheService } from "core/cache"
import { ConfigurationError } from "core/domain"
import { CacheBackedRateLimitStore } from "../cacheBackedRateLimitStore"
import { InMemoryCacheAdapter } from "../inMemoryCacheAdapter"
import { KvCacheAdapter } from "../kvCacheAdapter"

/** Fake Cloudflare KV that enforces the real minimum expirationTtl of 60s. */
function createFakeKv() {
  const store = new Map<string, string>()
  const ttls = new Map<string, number | undefined>()
  const kv = {
    store,
    ttls,
    get: vi.fn(async (key: string, options?: { type: "json" }) => {
      const value = store.get(key)
      if (value === undefined) return null
      return options?.type === "json" ? JSON.parse(value) as unknown : value
    }),
    put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
      if (options?.expirationTtl !== undefined && options.expirationTtl < 60) {
        throw new Error(`Invalid expiration_ttl of ${options.expirationTtl}. Expiration TTL must be at least 60.`)
      }
      store.set(key, value)
      ttls.set(key, options?.expirationTtl)
    }),
    delete: vi.fn(async (key: string) => { store.delete(key); ttls.delete(key) }),
    list: vi.fn(async (options?: { prefix?: string }) => ({
      keys: [...store.keys()].filter((name) => !options?.prefix || name.startsWith(options.prefix)).map((name) => ({ name })),
      list_complete: true,
    })),
  }
  return kv
}

afterEach(() => {
  vi.useRealTimers()
})

describe("defect 1: clear() keeps tag generations monotonic", () => {
  it("in-memory clear does not reset generations", async () => {
    const cache = new InMemoryCacheAdapter()
    await cache.advanceTagGeneration("users")
    await cache.clear()
    expect(await cache.getTagGeneration("users")).toBe("1")
    expect(await cache.advanceTagGeneration("users")).toBe("2")
  })

  it("in-memory: a resolver started before invalidate+clear cannot poison later readers", async () => {
    const mem = new InMemoryCacheAdapter()
    let db = "v1"
    const A = new CacheService({ adapter: mem })
    const B = new CacheService({ adapter: mem })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const pending = B.getOrSet("user:1", async () => { const v = db; await gate; return v }, ["users"])
    await new Promise((resolve) => setTimeout(resolve, 5))
    db = "v2"
    await A.invalidateTag("users")
    await A.clear()
    release()
    await pending
    const C = new CacheService({ adapter: mem })
    expect(await C.getOrSet("user:1", async () => db, ["users"])).toBe("v2")
  })

  it("KV clear keeps generation keys", async () => {
    const kv = createFakeKv()
    const cache = new KvCacheAdapter(kv as never)
    const generation = await cache.advanceTagGeneration("users")
    await cache.set("a", 1)
    await cache.clear()
    expect(await cache.getTagGeneration("users")).toBe(generation)
    expect(await cache.get("a")).toBeUndefined()
  })

  it("KV clear removes tagged (generation-qualified) values written by CacheService", async () => {
    // Regression: clear() skipped every `__generation__:` key, which also matched
    // CacheService's tagged storage keys `__generation__:"<gen>":<key>`.
    const kv = createFakeKv()
    const adapter = new KvCacheAdapter(kv as never)
    const service = new CacheService({ adapter })
    await adapter.advanceTagGeneration("users")
    expect(await service.getOrSet("user:1", async () => "v1", ["users"])).toBe("v1")
    await service.clear()
    const survivors = [...kv.store.keys()].filter((name) => name.includes("user:1"))
    expect(survivors).toEqual([])
    expect(await new CacheService({ adapter }).getOrSet("user:1", async () => "v2", ["users"])).toBe("v2")
  })

  it("KV generation counters cannot be overwritten by a cached value and survive clear", async () => {
    const kv = createFakeKv()
    const adapter = new KvCacheAdapter(kv as never)
    const generation = await adapter.advanceTagGeneration("t")
    const counter = kv.store.get("__cachegen__:t")
    // A value key spelled like the LEGACY counter location of tag "t".
    await adapter.set("__generation__:t", "not-a-generation")
    // The new-layout counter is out of reach of any cache key.
    expect(kv.store.get("__cachegen__:t")).toBe(counter)
    // The overwritten legacy counter only changes the observed (composite)
    // generation: a fail-safe extra invalidation, never a value read as a
    // generation and never a return to the previously observed generation.
    const afterOverwrite = await adapter.getTagGeneration("t")
    expect(afterOverwrite).not.toBe(generation)
    expect(afterOverwrite).not.toContain("not-a-generation")
    await adapter.clear()
    expect(kv.store.get("__cachegen__:t")).toBe(counter)
    expect(await adapter.getTagGeneration("t")).toBe(afterOverwrite)
  })

  describe("rolling deploy with instances on the previous counter layout", () => {
    const legacyKey = (tag: string) => `__cache__:__generation__:${tag}`
    const newKey = (tag: string) => `__cachegen__:${tag}`

    it("a counter only the previous layout has still fences: changing it changes the generation", async () => {
      const kv = createFakeKv()
      const adapter = new KvCacheAdapter(kv as never)
      expect(await adapter.getTagGeneration("legacy")).toBe("0")
      kv.store.set(legacyKey("legacy"), JSON.stringify("123:abc"))
      const first = await adapter.getTagGeneration("legacy")
      expect(first).not.toBe("0")
      kv.store.set(legacyKey("legacy"), JSON.stringify("124:def"))
      expect(await adapter.getTagGeneration("legacy")).not.toBe(first)
    })

    it("an old instance with a skewed clock still fences values cached by new instances (no ordering by time)", async () => {
      const kv = createFakeKv()
      const adapter = new KvCacheAdapter(kv as never)
      const service = new CacheService({ adapter })
      await adapter.advanceTagGeneration("users")
      const before = await adapter.getTagGeneration("users")
      expect(await service.getOrSet("user:1", async () => "stale", ["users"])).toBe("stale")
      // Old-release instance B, clock 200 ms behind, invalidates: it writes only the legacy key, with an OLDER timestamp.
      const [current] = JSON.parse(before) as [string, string]
      kv.store.set(legacyKey("users"), JSON.stringify(`${Number(current.split(":")[0]) - 200}:00000000-0000-0000-0000-000000000000`))
      expect(await adapter.getTagGeneration("users")).not.toBe(before)
      expect(await new CacheService({ adapter }).getOrSet("user:1", async () => "fresh", ["users"])).toBe("fresh")
    })

    it("advances both layouts (legacy first) so old instances observe new advances", async () => {
      const kv = createFakeKv()
      const adapter = new KvCacheAdapter(kv as never)
      const generation = await adapter.advanceTagGeneration("t")
      const raw = JSON.parse(kv.store.get(newKey("t"))!) as string
      expect(JSON.parse(kv.store.get(legacyKey("t"))!)).toBe(raw)
      expect(kv.put.mock.calls.map(([key]) => key)).toEqual([legacyKey("t"), newKey("t")])
      expect(await adapter.getTagGeneration("t")).toBe(generation)
    })

    it("clear keeps both counter layouts but removes tagged values stored under the legacy prefix", async () => {
      const kv = createFakeKv()
      const adapter = new KvCacheAdapter(kv as never)
      const generation = await adapter.advanceTagGeneration("users")
      await new CacheService({ adapter }).getOrSet("user:1", async () => "v1", ["users"])
      await adapter.clear()
      expect(kv.store.has(legacyKey("users"))).toBe(true)
      expect(await adapter.getTagGeneration("users")).toBe(generation)
      expect([...kv.store.keys()].filter((name) => name.includes("user:1"))).toEqual([])
    })
  })
})

describe("defect 2: KV short TTLs", () => {
  it("clamps expirationTtl to KV's 60s minimum and enforces the real TTL on read", async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const kv = createFakeKv()
    const cache = new KvCacheAdapter(kv as never)
    await cache.set("short", { a: 1 }, 1_500)
    expect(kv.ttls.get("__cache__:short")).toBe(60)
    expect(await cache.get("short")).toEqual({ a: 1 })
    expect(await cache.has("short")).toBe(true)
    vi.setSystemTime(1_000_000 + 1_500)
    expect(await cache.get("short")).toBeUndefined()
    expect(await cache.has("short")).toBe(false)
    expect(kv.store.has("__cache__:short")).toBe(false)
  })

  it("uses ceil(ttl/1000) when above the minimum", async () => {
    const kv = createFakeKv()
    const cache = new KvCacheAdapter(kv as never)
    await cache.set("long", 1, 120_001)
    expect(kv.ttls.get("__cache__:long")).toBe(121)
  })

  it("cache-backed rate limiting over KV works with short windows", async () => {
    const kv = createFakeKv()
    const store = new CacheBackedRateLimitStore(new KvCacheAdapter(kv as never))
    await expect(store.increment("ip", 10_000)).resolves.toMatchObject({ count: 1 })
    await expect(store.increment("ip", 10_000)).resolves.toMatchObject({ count: 2 })
  })
})

describe("defect 3: bounded growth", () => {
  it("in-memory: delete prunes revisions and tag memberships", async () => {
    const cache = new InMemoryCacheAdapter()
    for (let i = 0; i < 100; i++) {
      await cache.set(`k${i}`, i)
      await cache.addToTag("t", `k${i}`)
    }
    for (let i = 0; i < 100; i++) await cache.delete(`k${i}`)
    const internals = cache as unknown as { revisions: Map<string, number>; tags: Map<string, Map<string, number>> }
    expect(internals.revisions.size).toBe(0)
    expect(await cache.getTagKeys("t")).toEqual([])
    expect(internals.tags.size).toBe(0)
  })

  it("in-memory: expired entries are swept without being read", async () => {
    vi.useFakeTimers({ now: 1_000 })
    const cache = new InMemoryCacheAdapter()
    for (let i = 0; i < 1_000; i++) {
      await cache.set(`k${i}`, i, 1)
      await cache.addToTag("t", `k${i}`)
    }
    vi.setSystemTime(2_000)
    for (let i = 0; i < 200; i++) await cache.get("other")
    const internals = cache as unknown as { values: Map<string, unknown>; revisions: Map<string, number> }
    expect(internals.values.size).toBe(0)
    expect(internals.revisions.size).toBe(0)
    expect(await cache.getTagKeys("t")).toEqual([])
  })

  it("in-memory: maxEntries evicts least recently used entries", async () => {
    const cache = new InMemoryCacheAdapter({ maxEntries: 3 })
    await cache.set("a", 1)
    await cache.set("b", 2)
    await cache.set("c", 3)
    await cache.get("a")
    await cache.addToTag("t", "b")
    await cache.set("d", 4)
    expect(await cache.has("b")).toBe(false)
    expect(await cache.get("a")).toBe(1)
    expect(await cache.get("c")).toBe(3)
    expect(await cache.get("d")).toBe(4)
    expect(await cache.getTagKeys("t")).toEqual([])
  })

  it("in-memory: has a sane default cap", async () => {
    const cache = new InMemoryCacheAdapter()
    for (let i = 0; i < 10_050; i++) await cache.set(`k${i}`, i)
    expect((cache as unknown as { values: Map<string, unknown> }).values.size).toBeLessThanOrEqual(10_000)
  })

  it("in-memory: rejects an invalid maxEntries", () => {
    expect(() => new InMemoryCacheAdapter({ maxEntries: 0 })).toThrow(ConfigurationError)
  })

  it("KV: revision keys share the value TTL", async () => {
    const kv = createFakeKv()
    const cache = new KvCacheAdapter(kv as never)
    await cache.set("a", 1, 90_000)
    expect(kv.ttls.get("__cache__:__revision__:a")).toBe(90)
  })

  it("KV: tag member lists are deduped and capped", async () => {
    const kv = createFakeKv()
    const cache = new KvCacheAdapter(kv as never)
    for (let i = 0; i < 50; i++) {
      await cache.set("x", i)
      await cache.addToTag("t", "x")
    }
    expect(await cache.getTagKeys("t")).toEqual(["x"])
    for (let i = 0; i < 1_100; i++) await cache.addToTag("big", `k${i}`)
    const keys = await cache.getTagKeys("big")
    expect(keys.length).toBeLessThanOrEqual(1_000)
    expect(keys).toContain("k1099")
    expect(keys).not.toContain("k0")
  })

  it("KV: deduped tag members still fence reused keys", async () => {
    const kv = createFakeKv()
    const cache = new KvCacheAdapter(kv as never)
    await cache.set("x", "old")
    await cache.addToTag("t", "x")
    await cache.set("x", "new")
    await cache.addToTag("t", "x")
    await cache.deleteTag("t")
    expect(await cache.get("x")).toBeUndefined()
  })
})

describe("defect 7: identical value codec across adapters", () => {
  const adapters = () => [
    ["memory", new InMemoryCacheAdapter()] as const,
    ["kv", new KvCacheAdapter(createFakeKv() as never)] as const,
  ]

  it.each(adapters())("%s round-trips Date, BigInt, Map, Set and drops nested undefined", async (_name, cache) => {
    const value = {
      at: new Date(0),
      big: 12345678901234567890n,
      map: new Map<string, unknown>([["k", new Date(5)]]),
      set: new Set([1, 2n]),
      missing: undefined,
      nested: [{ $cache: "spoof", v: 1 }, undefined],
      nan: Number.NaN,
    }
    await cache.set("v", value)
    const back = await cache.get<typeof value>("v")
    expect(back!.at).toBeInstanceOf(Date)
    expect(back!.at.getTime()).toBe(0)
    expect(back!.big).toBe(12345678901234567890n)
    expect(back!.map).toEqual(new Map([["k", new Date(5)]]))
    expect(back!.set).toEqual(new Set([1, 2n]))
    expect(Object.hasOwn(back!, "missing")).toBe(false)
    expect(back!.nested).toEqual([{ $cache: "spoof", v: 1 }, null])
    expect(back!.nan).toBeNaN()
    await cache.set("b", 7n)
    expect(await cache.get("b")).toBe(7n)
  })

  it.each(adapters())("%s rejects top-level undefined and non-serializable values", async (_name, cache) => {
    await expect(cache.set("u", undefined)).rejects.toBeInstanceOf(ConfigurationError)
    await expect(cache.set("f", { fn: () => 1 })).rejects.toBeInstanceOf(ConfigurationError)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await expect(cache.set("c", cyclic)).rejects.toBeInstanceOf(ConfigurationError)
  })
})

describe("defect 8: TTL validation", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects ttl %s in both adapters", async (ttl) => {
    await expect(new InMemoryCacheAdapter().set("k", 1, ttl)).rejects.toBeInstanceOf(ConfigurationError)
    await expect(new KvCacheAdapter(createFakeKv() as never).set("k", 1, ttl)).rejects.toBeInstanceOf(ConfigurationError)
  })

  it("accepts undefined as no TTL", async () => {
    const cache = new InMemoryCacheAdapter()
    await cache.set("k", 1, undefined)
    expect(await cache.get("k")).toBe(1)
  })
})
