import { afterEach, describe, expect, it, vi } from "vitest"
import { CacheService } from "@xonava/core/cache"
import { ConfigurationError, ValidationError } from "@xonava/core/domain"
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
      if (new TextEncoder().encode(key).length > 512) throw new Error("KV PUT failed: 414 UriTooLong (keys are limited to 512 bytes)")
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
    // A value key spelled like the LEGACY counter location of tag "t" is rejected.
    await expect(adapter.set("__generation__:t", "not-a-generation")).rejects.toBeInstanceOf(ValidationError)
    // The new-layout counter is out of reach of any cache key.
    expect(kv.store.get("__cachegen__:t")).toBe(counter)
    expect(await adapter.getTagGeneration("t")).toBe(generation)
    // A legacy counter that is changed out of band only changes the observed
    // (composite) generation: a fail-safe extra invalidation, never a return to
    // the previously observed generation.
    kv.store.set("__cache__:__generation__:t", JSON.stringify("not-a-generation"))
    const afterOverwrite = await adapter.getTagGeneration("t")
    expect(afterOverwrite).not.toBe(generation)
    await adapter.clear()
    expect(kv.store.get("__cachegen__:t")).toBe(counter)
    expect(await adapter.getTagGeneration("t")).toBe(afterOverwrite)
  })

  describe("reserved internal key prefixes", () => {
    const reserved = ["__tag__:x", "__revision__:k", "__generation__:t", "__generation__:", "__generation__:0:k"]

    it.each(reserved)("rejects raw key %s on every key-taking operation without touching storage", async (key) => {
      const kv = createFakeKv()
      const adapter = new KvCacheAdapter(kv as never)
      await adapter.advanceTagGeneration("x")
      await adapter.addToTag("x", "plain")
      const before = new Map(kv.store)
      const calls: Array<() => Promise<unknown>> = [
        () => adapter.get(key),
        () => adapter.set(key, "v"),
        () => adapter.has(key),
        () => adapter.delete(key),
        () => adapter.addToTag("x", key),
      ]
      for (const call of calls) await expect(call()).rejects.toBeInstanceOf(ValidationError)
      expect(new Map(kv.store)).toEqual(before)
    })

    it("a raw tag-list key cannot read or overwrite the tag membership list", async () => {
      const kv = createFakeKv()
      const adapter = new KvCacheAdapter(kv as never)
      await adapter.set("member", 1)
      await adapter.addToTag("x", "member")
      await expect(adapter.get("__tag__:x")).rejects.toBeInstanceOf(ValidationError)
      await expect(adapter.set("__tag__:x", "owned")).rejects.toBeInstanceOf(ValidationError)
      expect(await adapter.getTagKeys("x")).toEqual(["member"])
    })

    it("still accepts ordinary keys and CacheService generation-qualified storage keys", async () => {
      const kv = createFakeKv()
      const adapter = new KvCacheAdapter(kv as never)
      await adapter.set("__tag_not_reserved", 1)
      await adapter.set("tag:x", 2)
      await adapter.set('__generation__:"1:abc":user:1', 3)
      expect(await adapter.get('__generation__:"1:abc":user:1')).toBe(3)
      expect(await adapter.get("tag:x")).toBe(2)
    })
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
      kv.store.set(legacyKey("users"), JSON.stringify(`${Number(before.split(":")[0]) - 200}:00000000-0000-0000-0000-000000000000`))
      expect(await adapter.getTagGeneration("users")).not.toBe(before)
      expect(await new CacheService({ adapter }).getOrSet("user:1", async () => "fresh", ["users"])).toBe("fresh")
    })

    // Regression (third review): the pair was reported even when both counters were equal, so each
    // tag added ~150 bytes to generation-qualified keys and keys with 3+ tags passed KV's 512-byte cap.
    it("reports a single counter in the steady state, keeping cache keys short", async () => {
      const kv = createFakeKv()
      const adapter = new KvCacheAdapter(kv as never)
      const advanced = await adapter.advanceTagGeneration("users")
      expect(advanced).toMatch(/^\d+:[0-9a-f-]{36}$/)
      expect(await adapter.getTagGeneration("users")).toBe(advanced)
      const service = new CacheService({ adapter })
      const tags = ["tenant.records.alpha", "tenant.records.bravo", "tenant.records.charlie", "tenant.records.delta"]
      for (const tag of tags) await adapter.advanceTagGeneration(tag)
      expect(await service.getOrSet("records:list:page-1", async () => "v", tags)).toBe("v")
      for (const key of kv.store.keys()) expect(new TextEncoder().encode(key).length).toBeLessThanOrEqual(512)
    })

    describe("generation pair is self-healing and bounded", () => {
      const keyBytes = (kv: ReturnType<typeof createFakeKv>) => [...kv.store.keys()].map((name) => new TextEncoder().encode(name).length)

      it("a counter only the previous release wrote converges: current is adopted from legacy", async () => {
        const kv = createFakeKv()
        const adapter = new KvCacheAdapter(kv as never)
        kv.store.set(legacyKey("t"), JSON.stringify("123:abc"))
        const first = await adapter.getTagGeneration("t")
        expect(first).toBe("123:abc")
        expect(kv.store.get(newKey("t"))).toBe(JSON.stringify("123:abc"))
        expect(await adapter.getTagGeneration("t")).toBe(first)
        // The adopted counter still fences: an old instance advancing only legacy changes the generation.
        kv.store.set(legacyKey("t"), JSON.stringify("124:def"))
        expect(await adapter.getTagGeneration("t")).not.toBe(first)
      })

      it("adoption never throws when the write fails, and the reported token is still bounded", async () => {
        const kv = createFakeKv()
        const adapter = new KvCacheAdapter(kv as never)
        kv.store.set(legacyKey("t"), JSON.stringify("123:abc"))
        kv.put.mockRejectedValueOnce(new Error("kv write unavailable"))
        const token = await adapter.getTagGeneration("t")
        expect(token).toMatch(/^h:[A-Za-z0-9_-]{43}$/)
        expect(kv.store.has(newKey("t"))).toBe(false)
        // The next read adopts successfully.
        expect(await adapter.getTagGeneration("t")).toBe("123:abc")
      })

      it("adoption does not overwrite a counter a new-release invalidation wrote in between", async () => {
        const kv = createFakeKv()
        const adapter = new KvCacheAdapter(kv as never)
        kv.store.set(legacyKey("t"), JSON.stringify("123:abc"))
        const realGet = kv.get.getMockImplementation()!
        let currentReads = 0
        kv.get.mockImplementation(async (key: string, options?: { type: "json" }) => {
          if (key === newKey("t") && ++currentReads === 2) kv.store.set(newKey("t"), JSON.stringify("200:new"))
          return realGet(key, options)
        })
        await adapter.getTagGeneration("t")
        expect(kv.store.get(newKey("t"))).toBe(JSON.stringify("200:new"))
      })

      it("a diverged pair is reported as a fixed-length token, so many tags stay under KV's 512-byte key cap", async () => {
        const kv = createFakeKv()
        const adapter = new KvCacheAdapter(kv as never)
        const tags = Array.from({ length: 4 }, (_, i) => `tenant.records.${String(i).padStart(5, "0")}`)
        tags.forEach((tag, i) => {
          kv.store.set(newKey(tag), JSON.stringify(`10${i}:11111111-1111-1111-1111-111111111111`))
          kv.store.set(legacyKey(tag), JSON.stringify(`20${i}:22222222-2222-2222-2222-222222222222`))
        })
        for (const tag of tags) expect(await adapter.getTagGeneration(tag)).toMatch(/^h:[A-Za-z0-9_-]{43}$/)
        const service = new CacheService({ adapter })
        let resolved = 0
        const resolver = async () => { resolved += 1; return "v" }
        expect(await service.getOrSet("records:list:page-1", resolver, tags)).toBe("v")
        expect(await service.getOrSet("records:list:page-1", resolver, tags)).toBe("v")
        expect(resolved).toBe(1)
        expect(Math.max(...keyBytes(kv))).toBeLessThanOrEqual(512)
      })

      it("distinct pairs report distinct tokens and the order of the pair matters", async () => {
        const kv = createFakeKv()
        const adapter = new KvCacheAdapter(kv as never)
        const tokens = new Set<string>()
        for (const [current, legacy] of [["1:a", "2:b"], ["2:b", "1:a"], ["1:a", "1:b"], ["1:b", "1:a"], ["1:a", undefined], [undefined, "1:b"]] as const) {
          kv.store.delete(newKey("t")); kv.store.delete(legacyKey("t"))
          if (current !== undefined) kv.store.set(newKey("t"), JSON.stringify(current))
          if (legacy !== undefined) kv.store.set(legacyKey("t"), JSON.stringify(legacy))
          // current-missing pairs are healed (converged); keep the legacy-only case out of the pair set.
          const token = await adapter.getTagGeneration("t")
          tokens.add(token)
        }
        expect(tokens.size).toBe(6)
      })

      it("an invalidation of a diverged pair converges the counters and changes the token", async () => {
        const kv = createFakeKv()
        const adapter = new KvCacheAdapter(kv as never)
        kv.store.set(newKey("t"), JSON.stringify("1:a"))
        kv.store.set(legacyKey("t"), JSON.stringify("2:b"))
        const before = await adapter.getTagGeneration("t")
        const advanced = await adapter.advanceTagGeneration("t")
        expect(advanced).not.toBe(before)
        expect(await adapter.getTagGeneration("t")).toBe(advanced)
        expect(advanced).toMatch(/^\d+:[0-9a-f-]{36}$/)
      })

      it("concurrent new-release invalidations (W1.legacy, W2.legacy, W2.current, W1.current) fence at every step", async () => {
        const kv = createFakeKv()
        const adapter = new KvCacheAdapter(kv as never)
        const service = new CacheService({ adapter })
        await adapter.advanceTagGeneration("t")
        let db = "v0"
        const read = () => service.getOrSet("k", async () => db, ["t"])
        expect(await read()).toBe("v0")
        const tokens = [await adapter.getTagGeneration("t")]
        const step = async (key: string, value: string, fresh: string) => {
          kv.store.set(key, JSON.stringify(value))
          db = fresh
          const token = await adapter.getTagGeneration("t")
          expect(tokens).not.toContain(token)
          tokens.push(token)
          // A reader never sees data cached before this write.
          expect(await read()).toBe(fresh)
        }
        await step(legacyKey("t"), "100:w1", "v1") // W1.legacy
        await step(legacyKey("t"), "101:w2", "v2") // W2.legacy
        await step(newKey("t"), "101:w2", "v3") // W2.current: converged on W2's value
        await step(newKey("t"), "100:w1", "v4") // W1.current: diverged for good (current=W1, legacy=W2)
        expect(tokens.at(-1)).toMatch(/^h:/)
        expect(Math.max(...keyBytes(kv))).toBeLessThanOrEqual(512)
        // The diverged state is stable (no read-side rewriting) and bounded, and the next invalidation converges it.
        expect(await adapter.getTagGeneration("t")).toBe(tokens.at(-1))
        db = "v5"
        await adapter.advanceTagGeneration("t")
        expect(await read()).toBe("v5")
        expect(await adapter.getTagGeneration("t")).toMatch(/^\d+:[0-9a-f-]{36}$/)
      })
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
