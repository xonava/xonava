import { describe, expect, it, vi } from "vitest"
import { CacheAdapterError } from "core/cache"
import { CacheBackedRateLimitStore } from "../cacheBackedRateLimitStore"
import { InMemoryRateLimitStore } from "../inMemoryRateLimitStore"
import { InMemoryCacheAdapter } from "../inMemoryCacheAdapter"
import { KvCacheAdapter } from "../kvCacheAdapter"

describe("cache reliability", () => {
  it("clones values on both memory cache boundaries", async () => {
    const cache = new InMemoryCacheAdapter()
    const value = { nested: { count: 1 }, items: ["a"] }
    await cache.set("key", value)

    value.nested.count = 9
    const first = await cache.get<typeof value>("key")
    expect(first).toEqual({ nested: { count: 1 }, items: ["a"] })

    first!.nested.count = 7
    expect(await cache.get<typeof value>("key")).toEqual({ nested: { count: 1 }, items: ["a"] })
  })

  it("surfaces KV failures with the operation that failed", async () => {
    const kv = {
      get: vi.fn(async () => { throw new Error("unavailable") }),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    }
    const cache = new KvCacheAdapter(kv)

    await expect(cache.get("key")).rejects.toMatchObject({
      name: "CacheAdapterError",
      operation: "kv.get",
    } satisfies Partial<CacheAdapterError>)
  })

  it("does not claim atomic rate-limit increments without an atomic adapter primitive", () => {
    const cache = new InMemoryCacheAdapter()
    expect("incrementAtomically" in new CacheBackedRateLimitStore(cache)).toBe(false)
  })

  it("does not turn a rate-limit storage failure into an allowed request", async () => {
    const cache = new InMemoryCacheAdapter()
    vi.spyOn(cache, "get").mockRejectedValue(new Error("unavailable"))
    const store = new CacheBackedRateLimitStore(cache)

    await expect(store.increment("key", 1_000)).rejects.toThrow("unavailable")
  })

  it("provides atomic rate-limit increments for the memory adapter", async () => {
    const store = new InMemoryRateLimitStore()
    const first = await store.incrementAtomically("bucket", 1_000)
    const second = await store.incrementAtomically("bucket", 1_000)
    expect(second.count).toBe(first.count + 1)
  })

  it("does not let stale tag membership delete a newer key reuse", async () => {
    const cache = new InMemoryCacheAdapter()
    await cache.set("reused", "new")
    await cache.addToTag("rows", "reused")
    await cache.set("reused", "newer")
    await cache.deleteTag("rows")
    await expect(cache.get("reused")).resolves.toBe("newer")
  })

  it("uses one KV namespace and fences reused tagged keys", async () => {
    const values = new Map<string, string>()
    const kv = {
      get: vi.fn(async (key: string, options?: { type: "json" }) => {
        const value = values.get(key)
        if (value === undefined) return null
        return options?.type === "json" ? JSON.parse(value) as unknown : value
      }),
      put: vi.fn(async (key: string, value: string) => { values.set(key, value) }),
      delete: vi.fn(async (key: string) => { values.delete(key) }),
      list: vi.fn(async () => ({ keys: [], list_complete: true })),
    }
    const cache = new KvCacheAdapter(kv as never)

    await cache.set("reused", "new")
    await cache.addToTag("rows", "reused")
    await cache.set("reused", "newer")
    await cache.deleteTag("rows")

    await expect(cache.get("reused")).resolves.toBe("newer")
    expect([...values.keys()].every((key) => key.startsWith("__cache__:"))).toBe(true)
  })

  it("advertises atomic shared generation advancement via KV put", async () => {
    const kv = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ keys: [], list_complete: true })),
    }
    const cache = new KvCacheAdapter(kv as never)

    expect("advanceTagGeneration" in cache).toBe(true)
    expect(cache.capabilities).toEqual({ tagGenerationConsistency: "eventual", coherenceScope: "shared" })
    const generation = await cache.advanceTagGeneration("rows")
    expect(typeof generation).toBe("string")
    expect(generation.length).toBeGreaterThan(0)
    expect(kv.put).toHaveBeenCalled()
  })

  it("declares process scope for the in-memory adapter", () => {
    const cache = new InMemoryCacheAdapter()
    expect(cache.capabilities).toEqual({ tagGenerationConsistency: "linearizable", coherenceScope: "process" })
  })
})
