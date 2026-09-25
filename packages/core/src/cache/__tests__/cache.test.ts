import { describe, expect, it, vi } from "vitest"
import {
  buildKey,
  CacheOverloadError,
  CacheService,
  MAX_CACHE_KEY_BYTES,
  MAX_CACHE_TAG_BYTES,
  MAX_CACHE_TAGS_PER_CALL,
  serializeCacheKeyPart,
  type CacheAdapter,
} from "../cache"

function createAdapter(capabilities?: CacheAdapter["capabilities"]): CacheAdapter {
  return {
    ...(capabilities ? { capabilities } : {}),
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => true),
    has: vi.fn(async () => true),
    clear: vi.fn(async () => undefined),
    addToTag: vi.fn(async () => undefined),
    getTagKeys: vi.fn(async () => []),
    deleteTag: vi.fn(async () => undefined),
  }
}

describe("cache ports", () => {
  it("serializes special values deterministically", () => {
    const value = serializeCacheKeyPart({
      z: new Set([1n, Number.NaN]),
      a: new Map([[new Date("2026-01-01T00:00:00.000Z"), Number.POSITIVE_INFINITY]]),
      missing: undefined,
    })
    expect(value).toContain('"$type":"BigInt"')
    expect(value).toContain('"$type":"NaN"')
    expect(value).toContain('"$type":"Date"')
    expect(value).toContain('"$type":"Infinity"')
    expect(buildKey("clinic", "tenant-a", "patients")).toBe("clinic:tenant-a:patients")
    expect(serializeCacheKeyPart({ finite: 1, flag: false, empty: null })).toContain('"finite":1')
    expect(serializeCacheKeyPart(Number.NEGATIVE_INFINITY)).toContain('"-Infinity"')
    expect(serializeCacheKeyPart("plain")).toBe('"plain"')
  })

  it("rejects executable and non-plain cache-key shapes without invoking accessors", () => {
    let reads = 0
    const accessor = Object.defineProperty({}, "secret", { enumerable: true, get() { reads++; return "value" } })
    class Custom { value = 1 }
    class CustomMap extends Map<unknown, unknown> {}

    expect(() => serializeCacheKeyPart(accessor)).toThrow(/data properties/)
    expect(reads).toBe(0)
    expect(() => serializeCacheKeyPart(new Custom())).toThrow(/plain objects/)
    expect(() => serializeCacheKeyPart(new CustomMap())).toThrow(/Map subclasses/)
    expect(() => serializeCacheKeyPart(Symbol("key"))).toThrow(/symbol/)
    expect(() => serializeCacheKeyPart(() => "key")).toThrow(/function/)
  })

  it("caches resolver results and manages tags", async () => {
    const adapter = createAdapter()
    const cache = new CacheService({ adapter, defaultTtlMs: 1000 })
    const resolver = vi.fn(async () => ({ id: "value" }))

    await expect(cache.getOrSet("key", resolver, ["patients"])).resolves.toEqual({ id: "value" })
    expect(resolver).toHaveBeenCalledOnce()
    const mocks = adapter as unknown as {
      set: ReturnType<typeof vi.fn>
      addToTag: ReturnType<typeof vi.fn>
      deleteTag: ReturnType<typeof vi.fn>
    }
    const setMock = mocks.set
    const addToTagMock = mocks.addToTag
    const deleteTagMock = mocks.deleteTag
    expect(setMock).toHaveBeenCalledWith(expect.stringContaining("__generation__"), { id: "value" }, 1000)
    expect(addToTagMock).toHaveBeenCalledWith("patients", expect.stringContaining("__generation__"))
    await cache.invalidateTags(["patients", "dashboard"])
    expect(deleteTagMock).toHaveBeenCalledTimes(2)
  })

  it("single-flights concurrent misses for one key", async () => {
    const adapter = createAdapter()
    const cache = new CacheService({ adapter })
    let resolve!: (value: { id: string }) => void
    const resolver = vi.fn(() => new Promise<{ id: string }>((done) => { resolve = done }))

    const first = cache.getOrSet("key", resolver)
    const second = cache.getOrSet("key", resolver)
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce())
    resolve({ id: "shared" })

    await expect(Promise.all([first, second])).resolves.toEqual([{ id: "shared" }, { id: "shared" }])
  })

  it("does not resurrect a resolver result after tag invalidation", async () => {
    const values = new Map<string, unknown>()
    let generation = "0"
    let resolve!: (value: string) => void
    const setMock = vi.fn(async (key: string, value: unknown) => { values.set(key, value) })
    const adapter: CacheAdapter = {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      set: setMock,
      delete: vi.fn(async (key: string) => values.delete(key)),
      has: vi.fn(async (key: string) => values.has(key)),
      clear: vi.fn(async () => { values.clear() }),
      addToTag: vi.fn(async () => undefined),
      getTagKeys: vi.fn(async () => []),
      deleteTag: vi.fn(async () => undefined),
      getTagGeneration: vi.fn(async () => generation),
      advanceTagGeneration: vi.fn(async (_tag: string) => { generation = String(Number(generation) + 1); return generation }),
    }
    const cache = new CacheService({ adapter })

    const stale = cache.getOrSet("key", () => new Promise<string>((done) => { resolve = done }), ["rows"])
    await Promise.resolve()
    await Promise.resolve()
    await cache.invalidateTag("rows")
    resolve("stale")
    await expect(stale).resolves.toBe("stale")

    const fresh = cache.getOrSet("key", async () => "fresh", ["rows"])
    await expect(fresh).resolves.toBe("fresh")
    expect(setMock).toHaveBeenLastCalledWith(expect.stringContaining("__generation__"), "fresh", 120000)
  })

  it("does not retain generation state per unique tag", async () => {
    const adapter: CacheAdapter = {
      get: async () => undefined,
      set: async () => undefined,
      delete: async () => true,
      has: async () => false,
      clear: async () => undefined,
      addToTag: async () => undefined,
      getTagKeys: async () => [],
      deleteTag: async () => undefined,
    }
    const cache = new CacheService({ adapter })

    for (let index = 0; index < 100_000; index++) await cache.invalidateTag(`tag-${index}`)

    const retainedMaps = Object.values(cache).filter((value): value is Map<unknown, unknown> => value instanceof Map)
    expect(retainedMaps).toHaveLength(1)
    expect(retainedMaps[0]?.size).toBe(0)
  })

  it("conservatively invalidates every local tagged key when one tag changes", async () => {
    const values = new Map<string, unknown>()
    const adapter: CacheAdapter = {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      set: async (key, value) => { values.set(key, value) },
      delete: async (key) => values.delete(key),
      has: async (key) => values.has(key),
      clear: async () => { values.clear() },
      addToTag: async () => undefined,
      getTagKeys: async () => [],
      deleteTag: async () => undefined,
    }
    const cache = new CacheService({ adapter })
    await cache.getOrSet("key", async () => "old", ["tag-a"])
    await cache.invalidateTag("tag-b")

    await expect(cache.getOrSet("key", async () => "fresh", ["tag-a"])).resolves.toBe("fresh")
  })

  it("fences a tagged resolver that started before clear", async () => {
    const adapter = createAdapter()
    const cache = new CacheService({ adapter })
    let finish!: (value: string) => void
    const stale = cache.getOrSet("key", () => new Promise<string>((resolve) => { finish = resolve }), ["tag"])
    await Promise.resolve()
    await Promise.resolve()

    await cache.clear()
    finish("stale")
    await expect(stale).resolves.toBe("stale")
    expect(adapter.set).not.toHaveBeenCalled()
  })

  it("fences an untagged resolver and its single-flight group across clear", async () => {
    const adapter = createAdapter()
    const cache = new CacheService({ adapter })
    let finish!: (value: string) => void
    const staleResolver = vi.fn(() => new Promise<string>((resolve) => { finish = resolve }))
    const stale = cache.getOrSet("key", staleResolver)
    await vi.waitFor(() => expect(staleResolver).toHaveBeenCalledOnce())

    await cache.clear()
    const freshResolver = vi.fn(async () => "fresh")
    await expect(cache.getOrSet("key", freshResolver)).resolves.toBe("fresh")
    finish("stale")
    await expect(stale).resolves.toBe("stale")

    expect(freshResolver).toHaveBeenCalledOnce()
    expect(adapter.set).toHaveBeenCalledTimes(1)
    expect(adapter.set).toHaveBeenCalledWith("key", "fresh", 120_000)
  })

  it("rechecks a tag generation before returning a raced cached value", async () => {
    const values = new Map<string, unknown>()
    let generation = "0"
    let releaseRead!: () => void
    const readPaused = new Promise<void>((resolve) => { releaseRead = resolve })
    const adapter: CacheAdapter = {
      get: async <T>(key: string) => {
        await readPaused
        return values.get(key) as T | undefined
      },
      set: async (key, value) => { values.set(key, value) },
      delete: async (key) => values.delete(key),
      has: async (key) => values.has(key),
      clear: async () => { values.clear() },
      addToTag: async () => undefined,
      getTagKeys: async () => [],
      deleteTag: async () => undefined,
      getTagGeneration: async () => generation,
      advanceTagGeneration: async (_tag) => { generation = String(Number(generation) + 1); return generation },
    }
    const cache = new CacheService({ adapter })
    const oldKey = '__generation__:"0":key'
    values.set(oldKey, "stale")
    const read = cache.getOrSet("key", async () => "fresh", ["rows"])
    await cache.invalidateTag("rows")
    releaseRead()
    await expect(read).resolves.toBe("fresh")
  })

  it("fails closed for tagged cache generation errors when correctness is critical", async () => {
    const adapter = createAdapter({ tagGenerationConsistency: "linearizable", coherenceScope: "shared" })
    adapter.getTagGeneration = vi.fn(async () => { throw new Error("generation unavailable") })
    adapter.advanceTagGeneration = vi.fn(async () => "1")
    const cache = new CacheService({ adapter, correctnessCritical: true })
    await expect(cache.getOrSet("key", async () => "fresh", ["rows"])).rejects.toThrow("generation unavailable")
  })

  it("fails closed for generation advance errors when correctness is critical", async () => {
    const adapter = createAdapter({ tagGenerationConsistency: "linearizable", coherenceScope: "shared" })
    adapter.getTagGeneration = vi.fn(async () => "0")
    adapter.advanceTagGeneration = vi.fn(async () => { throw new Error("advance unavailable") })
    const cache = new CacheService({ adapter, correctnessCritical: true })

    await expect(cache.invalidateTag("rows")).rejects.toMatchObject({
      name: "CacheAdapterError",
      operation: "advanceTagGeneration",
    })
  })

  it("fails closed when configuring correctness-critical cache without atomic shared generation", () => {
    const adapter = createAdapter({ tagGenerationConsistency: "linearizable" })
    expect(() => new CacheService({ adapter, correctnessCritical: true }))
      .toThrow("shared tag generation unavailable")
  })

  it("rejects eventual tag generation for correctness-critical cache", () => {
    const adapter = createAdapter({ tagGenerationConsistency: "eventual" })
    adapter.getTagGeneration = vi.fn(async () => "0")
    adapter.advanceTagGeneration = vi.fn(async () => "1")

    expect(() => new CacheService({ adapter, correctnessCritical: true }))
      .toThrow("shared tag generation unavailable")
  })

  it("rejects process-scoped tag generation for correctness-critical cache", () => {
    const adapter = createAdapter({ tagGenerationConsistency: "linearizable", coherenceScope: "process" })
    adapter.getTagGeneration = vi.fn(async () => "0")
    adapter.advanceTagGeneration = vi.fn(async () => "1")

    expect(() => new CacheService({ adapter, correctnessCritical: true }))
      .toThrow("shared tag generation unavailable")
  })

  it("accepts a shared linearizable composed adapter for correctness-critical caching", async () => {
    // Mirrors SharedGenerationCacheAdapter: a fast payload adapter whose tag
    // generations come from a separate, shared, linearizable generation store.
    const values = new Map<string, unknown>()
    const payload: CacheAdapter = {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      set: async (key, value) => { values.set(key, value) },
      delete: async (key) => values.delete(key),
      has: async (key) => values.has(key),
      clear: async () => { values.clear() },
      addToTag: async () => undefined,
      getTagKeys: async () => [],
      deleteTag: async () => undefined,
    }
    let generation = "0"
    const composed: CacheAdapter = {
      capabilities: { tagGenerationConsistency: "linearizable", coherenceScope: "shared" },
      ...payload,
      getTagGeneration: async () => generation,
      advanceTagGeneration: async () => { generation = String(Number(generation) + 1); return generation },
    }
    const cache = new CacheService({ adapter: composed, correctnessCritical: true })

    await expect(cache.getOrSet("key", async () => "fresh", ["rows"])).resolves.toBe("fresh")
    await cache.invalidateTag("rows")
    await expect(cache.getOrSet("key", async () => "fresh-after-invalidate", ["rows"])).resolves.toBe("fresh-after-invalidate")
    expect(generation).toBe("1")
  })

  it("delegates cache operations and returns cached values", async () => {
    const adapter = createAdapter()
    const mocks = adapter as unknown as { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>; has: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; deleteTag: ReturnType<typeof vi.fn> }
    mocks.get.mockResolvedValueOnce({ cached: true })
    const cache = new CacheService({ adapter })
    const resolver = vi.fn(async () => ({ cached: false }))
    await expect(cache.getOrSet("key", resolver)).resolves.toEqual({ cached: true })
    expect(resolver).not.toHaveBeenCalled()
    await expect(cache.get("key")).resolves.toBeUndefined()
    await cache.set("key", "value", 20)
    await expect(cache.delete("key")).resolves.toBe(true)
    await expect(cache.has("key")).resolves.toBe(true)
    await cache.clear()
    await cache.invalidateTag("tag")
    expect(mocks.set).toHaveBeenCalledWith("key", "value", 20)
    expect(mocks.deleteTag).toHaveBeenCalledWith("tag")
  })

  it("serializes arrays and negative infinity", () => {
    expect(serializeCacheKeyPart([undefined, Number.NEGATIVE_INFINITY])).toContain('"-Infinity"')
  })

  it("rejects caller-forged $type markers while keeping Date keys distinct", () => {
    expect(() => serializeCacheKeyPart({ $type: "Date", value: "x" })).toThrow()
    expect(() => serializeCacheKeyPart({ nested: { $type: "NaN" } })).toThrow()
    expect(serializeCacheKeyPart(new Date("2026-01-01T00:00:00.000Z"))).not.toBe(serializeCacheKeyPart(new Date("2026-12-31T00:00:00.000Z")))
    expect(serializeCacheKeyPart({ when: new Date("2026-01-01T00:00:00.000Z") })).not.toBe(serializeCacheKeyPart({ when: new Date("2026-12-31T00:00:00.000Z") }))
  })

  it("throws on cache key nesting beyond the maximum depth", () => {
    let deep: unknown = "leaf"
    for (let i = 0; i <= 101; i++) deep = { value: deep }
    expect(() => serializeCacheKeyPart(deep)).toThrow(/maximum depth/)
  })

  it("throws on cyclic cache key structures", () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => serializeCacheKeyPart(cycle)).toThrow(/cyclic/)

    const array: unknown[] = []
    array.push(array)
    expect(() => serializeCacheKeyPart(array)).toThrow(/cyclic/)

    const map = new Map<string, unknown>()
    map.set("self", map)
    expect(() => serializeCacheKeyPart(map)).toThrow(/cyclic/)

    const set = new Set<unknown>()
    set.add(set)
    expect(() => serializeCacheKeyPart(set)).toThrow(/cyclic/)
  })

  it("canonicalizes Map and Set insertion order in cache keys", () => {
    expect(serializeCacheKeyPart(new Map([[1, "a"], [2, "b"]])))
      .toBe(serializeCacheKeyPart(new Map([[2, "b"], [1, "a"]])))
    expect(serializeCacheKeyPart(new Set(["x", "y"])))
      .toBe(serializeCacheKeyPart(new Set(["y", "x"])))
    expect(serializeCacheKeyPart(new Set([2, 10])))
      .toBe(serializeCacheKeyPart(new Set([10, 2])))
  })

  it("throws when a cache key object exceeds the key count limit", () => {
    const big: Record<string, unknown> = {}
    for (let i = 0; i < 10_001; i++) big[`k${i}`] = i
    expect(() => serializeCacheKeyPart(big)).toThrow(/exceeds the maximum/)
  })

  it("bounds array items, total nodes, and serialized cache-key bytes", () => {
    expect(() => serializeCacheKeyPart(Array(10_001).fill(0))).toThrow(/items/)
    expect(() => serializeCacheKeyPart("x".repeat(3 * 1024))).toThrow(/bytes/)
    expect(() => serializeCacheKeyPart(Array.from({ length: 5_001 }, () => [0]))).toThrow(/nodes/)
  })

  it("throws when a joined cache key exceeds the encoded byte limit", () => {
    const long = "x".repeat(3 * 1024)
    expect(() => buildKey(long, "scope", "suffix")).toThrow(/exceeds the maximum/)
  })

  it("keeps cache operation and telemetry failures best effort", async () => {
    const error = new Error("cache unavailable")
    const adapter: CacheAdapter = {
      get: vi.fn(async () => { throw error }),
      set: vi.fn(async () => { throw error }),
      delete: vi.fn(async () => { throw error }),
      has: vi.fn(async () => { throw error }),
      clear: vi.fn(async () => { throw error }),
      addToTag: vi.fn(async () => undefined),
      getTagKeys: vi.fn(async () => []),
      deleteTag: vi.fn(async () => { throw error }),
    }
    const telemetry = { onError: vi.fn(() => { throw new Error("telemetry unavailable") }) }
    const cache = new CacheService({ adapter, telemetry })

    await expect(cache.get("key")).resolves.toBeUndefined()
    await expect(cache.set("key", "value")).resolves.toBeUndefined()
    await expect(cache.delete("key")).resolves.toBe(false)
    await expect(cache.has("key")).resolves.toBe(false)
    await expect(cache.clear()).resolves.toBeUndefined()
    await expect(cache.invalidateTag("tag")).resolves.toBeUndefined()
    expect(telemetry.onError).toHaveBeenCalled()
  })

  it("reports cache failures through unified telemetry without exposing cache keys", async () => {
    const emit = vi.fn()
    const adapter = { ...createAdapter(), get: vi.fn(async () => { throw new Error("down") }) }
    const cache = new CacheService({ adapter, telemetry: { emit } })
    await cache.get("tenant-secret-key")
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ name: "cache.operation.failure" }))
    expect(JSON.stringify(emit.mock.calls)).not.toContain("tenant-secret-key")
  })

  it("falls back across unreliable tag generation and tag writes", async () => {
    const adapter = createAdapter() as CacheAdapter & { getTagGeneration: () => Promise<string | undefined> }
    adapter.getTagGeneration = vi.fn(async () => { throw new Error("generation unavailable") })
    adapter.addToTag = vi.fn(async () => { throw new Error("tag unavailable") })
    const cache = new CacheService({ adapter })

    await expect(cache.getOrSet("key", async () => "value", ["tag"])).resolves.toBe("value")
    await expect(cache.invalidateTag("tag")).resolves.toBeUndefined()
  })

  it("fences successful backend generations across an outage and recovery", async () => {
    const values = new Map<string, unknown>()
    let available = true
    const adapter: CacheAdapter = {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      set: async (key, value) => { values.set(key, value) },
      delete: async (key) => values.delete(key),
      has: async (key) => values.has(key),
      clear: async () => { values.clear() },
      addToTag: async () => undefined,
      getTagKeys: async () => [],
      deleteTag: async () => undefined,
      getTagGeneration: async () => {
        if (!available) throw new Error("generation unavailable")
        return "0"
      },
      advanceTagGeneration: async () => "1",
    }
    const cache = new CacheService({ adapter })
    await cache.getOrSet("key", async () => "before-outage", ["tag"])

    available = false
    await expect(cache.getOrSet("key", async () => "during-outage", ["tag"])).resolves.toBe("during-outage")
    available = true

    await expect(cache.getOrSet("key", async () => "after-recovery", ["tag"])).resolves.toBe("after-recovery")
  })

  it("uses the local generation when a remote generation is absent", async () => {
    const adapter = createAdapter() as CacheAdapter & { getTagGeneration: () => Promise<string | undefined> }
    adapter.getTagGeneration = vi.fn(async () => undefined)
    const cache = new CacheService({ adapter })

    await expect(cache.getOrSet("key", async () => "value", ["tag"])).resolves.toBe("value")
    const getTagGeneration = vi.mocked(Reflect.get(adapter, "getTagGeneration") as ReturnType<typeof vi.fn>)
    expect(getTagGeneration).toHaveBeenCalledWith("tag")
  })

  it("rejects oversized keys and tags, excessive or duplicate tags, and invalid TTLs", async () => {
    const adapter = createAdapter()
    const cache = new CacheService({ adapter })

    await expect(cache.get("x".repeat(MAX_CACHE_KEY_BYTES + 1))).rejects.toThrow(/key/)
    await expect(cache.invalidateTag("é".repeat(Math.floor(MAX_CACHE_TAG_BYTES / 2) + 1))).rejects.toThrow(/tag/)
    await expect(cache.getOrSet("key", async () => "value", Array.from({ length: MAX_CACHE_TAGS_PER_CALL + 1 }, (_, index) => `tag-${index}`))).rejects.toThrow(/at most/)
    await expect(cache.getOrSet("key", async () => "value", ["duplicate", "duplicate"])).rejects.toThrow(/unique/)
    await expect(cache.getOrSet("key", async () => "value", [], 0)).rejects.toThrow(/positive safe integer/)
    await expect(cache.set("key", "value", Number.POSITIVE_INFINITY)).rejects.toThrow(/positive safe integer/)
    expect(() => new CacheService({ adapter, defaultTtlMs: Number.NaN })).toThrow(/defaultTtlMs/)
  })

  it("caps unresolved distinct resolvers while continuing to coalesce an existing key", async () => {
    const adapter = createAdapter()
    const cache = new CacheService({ adapter, maxInFlight: 1 })
    let finish!: (value: string) => void
    const resolver = vi.fn(() => new Promise<string>((resolve) => { finish = resolve }))
    const first = cache.getOrSet("first", resolver)
    await Promise.resolve()
    await Promise.resolve()

    const coalesced = cache.getOrSet("first", resolver)
    await expect(cache.getOrSet("second", async () => "second")).rejects.toBeInstanceOf(CacheOverloadError)
    expect(resolver).toHaveBeenCalledOnce()
    finish("done")
    await expect(Promise.all([first, coalesced])).resolves.toEqual(["done", "done"])
    await expect(cache.getOrSet("second", async () => "second")).resolves.toBe("second")
  })

  it("does not require telemetry when a cache operation fails", async () => {
    const adapter = createAdapter()
    adapter.get = vi.fn(async () => { throw new Error("cache unavailable") })
    const cache = new CacheService({ adapter })
    await expect(cache.get("key")).resolves.toBeUndefined()
  })
})
