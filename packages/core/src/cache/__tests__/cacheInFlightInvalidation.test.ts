import { describe, expect, it, vi } from "vitest"
import { CacheOverloadError, CacheService, type CacheAdapter } from "../cache"

function memoryAdapter(capabilities?: CacheAdapter["capabilities"]): CacheAdapter & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>()
  const generations = new Map<string, number>()
  return {
    values,
    ...(capabilities ? { capabilities } : {}),
    get: async <T>(key: string) => values.get(key) as T | undefined,
    set: vi.fn(async (key: string, value: unknown) => { values.set(key, value) }),
    delete: vi.fn(async (key: string) => values.delete(key)),
    has: vi.fn(async (key: string) => values.has(key)),
    clear: vi.fn(async () => { values.clear() }),
    addToTag: vi.fn(async () => undefined),
    getTagKeys: vi.fn(async () => []),
    deleteTag: vi.fn(async () => undefined),
    getTagGeneration: async (tag: string) => String(generations.get(tag) ?? 0),
    advanceTagGeneration: async (tag: string) => { const next = (generations.get(tag) ?? 0) + 1; generations.set(tag, next); return String(next) },
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe("cache in-flight invalidation", () => {
  it("does not write a stale in-flight lookup back after delete", async () => {
    const adapter = memoryAdapter()
    const cache = new CacheService({ adapter })
    const oldRow = deferred<string>()
    const staleResolver = vi.fn(() => oldRow.promise)
    const stale = cache.getOrSet("user:1", staleResolver)
    await vi.waitFor(() => expect(staleResolver).toHaveBeenCalledOnce())

    await cache.delete("user:1")
    oldRow.resolve("old")
    await expect(stale).resolves.toBe("old")

    expect(adapter.values.has("user:1")).toBe(false)
    const freshResolver = vi.fn(async () => "new")
    await expect(cache.getOrSet("user:1", freshResolver)).resolves.toBe("new")
    expect(freshResolver).toHaveBeenCalledOnce()
  })

  it("starts a fresh lookup for callers arriving after delete instead of joining the stale one", async () => {
    const adapter = memoryAdapter()
    const cache = new CacheService({ adapter })
    const oldRow = deferred<string>()
    const staleResolver = vi.fn(() => oldRow.promise)
    const stale = cache.getOrSet("user:1", staleResolver)
    await vi.waitFor(() => expect(staleResolver).toHaveBeenCalledOnce())

    await cache.delete("user:1")
    const freshResolver = vi.fn(async () => "new")
    await expect(cache.getOrSet("user:1", freshResolver)).resolves.toBe("new")
    expect(freshResolver).toHaveBeenCalledOnce()

    oldRow.resolve("old")
    await expect(stale).resolves.toBe("old")
    expect(adapter.values.get("user:1")).toBe("new")
  })

  it("does not let an in-flight lookup overwrite an explicit set", async () => {
    const adapter = memoryAdapter()
    const cache = new CacheService({ adapter })
    const oldRow = deferred<string>()
    const staleResolver = vi.fn(() => oldRow.promise)
    const stale = cache.getOrSet("user:1", staleResolver)
    await vi.waitFor(() => expect(staleResolver).toHaveBeenCalledOnce())

    await cache.set("user:1", "explicit")
    oldRow.resolve("old")
    await expect(stale).resolves.toBe("old")
    expect(adapter.values.get("user:1")).toBe("explicit")
  })

  it("removes a stale value whose backend write raced a delete", async () => {
    const adapter = memoryAdapter()
    const writeStarted = deferred<void>()
    const releaseWrite = deferred<void>()
    adapter.set = vi.fn(async (key: string, value: unknown) => {
      writeStarted.resolve()
      await releaseWrite.promise
      adapter.values.set(key, value)
    })
    const cache = new CacheService({ adapter })
    const stale = cache.getOrSet("user:1", async () => "old")
    await writeStarted.promise

    await cache.delete("user:1")
    releaseWrite.resolve()
    await expect(stale).resolves.toBe("old")
    expect(adapter.values.has("user:1")).toBe(false)
  })

  it("removes a stale value whose backend write raced a clear", async () => {
    const adapter = memoryAdapter()
    const writeStarted = deferred<void>()
    const releaseWrite = deferred<void>()
    adapter.set = vi.fn(async (key: string, value: unknown) => {
      writeStarted.resolve()
      await releaseWrite.promise
      adapter.values.set(key, value)
    })
    const cache = new CacheService({ adapter })
    const stale = cache.getOrSet("user:1", async () => "old")
    await writeStarted.promise

    await cache.clear()
    releaseWrite.resolve()
    await expect(stale).resolves.toBe("old")
    expect(adapter.values.has("user:1")).toBe(false)
  })

  it("keeps detached resolvers counted against maxInFlight and releases them when they settle", async () => {
    const adapter = memoryAdapter()
    const cache = new CacheService({ adapter, maxInFlight: 1 })
    const oldRow = deferred<string>()
    const staleResolver = vi.fn(() => oldRow.promise)
    const stale = cache.getOrSet("user:1", staleResolver)
    await vi.waitFor(() => expect(staleResolver).toHaveBeenCalledOnce())

    await cache.delete("user:1")
    await expect(cache.getOrSet("user:1", async () => "new")).rejects.toBeInstanceOf(CacheOverloadError)
    oldRow.resolve("old")
    await expect(stale).resolves.toBe("old")
    await expect(cache.getOrSet("user:1", async () => "new")).resolves.toBe("new")
  })

  it("settles every waiter that joined a lookup before it was detached", async () => {
    const adapter = memoryAdapter()
    const cache = new CacheService({ adapter })
    const oldRow = deferred<string>()
    const resolver = vi.fn(() => oldRow.promise)
    const first = cache.getOrSet("user:1", resolver)
    const second = cache.getOrSet("user:1", resolver)
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce())

    await cache.delete("user:1")
    oldRow.resolve("old")
    await expect(Promise.all([first, second])).resolves.toEqual(["old", "old"])
    expect(resolver).toHaveBeenCalledOnce()
    expect(adapter.values.has("user:1")).toBe(false)
  })

  it("starts fresh after a tag invalidation and never writes the pre-invalidation value under the live generation", async () => {
    const adapter = memoryAdapter()
    const cache = new CacheService({ adapter })
    const oldRow = deferred<string>()
    const staleResolver = vi.fn(() => oldRow.promise)
    const stale = cache.getOrSet("user:1", staleResolver, ["users"])
    await vi.waitFor(() => expect(staleResolver).toHaveBeenCalledOnce())

    await cache.invalidateTag("users")
    const freshResolver = vi.fn(async () => "new")
    await expect(cache.getOrSet("user:1", freshResolver, ["users"])).resolves.toBe("new")
    oldRow.resolve("old")
    await expect(stale).resolves.toBe("old")
    expect(freshResolver).toHaveBeenCalledOnce()
    await expect(cache.getOrSet("user:1", async () => "other", ["users"])).resolves.toBe("new")
  })
})

describe("correctness-critical delete and has", () => {
  const capabilities = { tagGenerationConsistency: "linearizable", coherenceScope: "shared" } as const

  it("rethrows delete backend failures instead of reporting a miss", async () => {
    const adapter = memoryAdapter(capabilities)
    adapter.delete = vi.fn(async () => { throw new Error("delete unavailable") })
    const onError = vi.fn()
    const cache = new CacheService({ adapter, correctnessCritical: true, telemetry: { onError } })
    await expect(cache.delete("key")).rejects.toThrow("delete unavailable")
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ operation: "delete", key: "key" }))
  })

  it("rethrows has backend failures instead of reporting absence", async () => {
    const adapter = memoryAdapter(capabilities)
    adapter.has = vi.fn(async () => { throw new Error("has unavailable") })
    const cache = new CacheService({ adapter, correctnessCritical: true })
    await expect(cache.has("key")).rejects.toThrow("has unavailable")
  })

  it("keeps best-effort delete and has non-throwing outside correctness-critical mode", async () => {
    const adapter = memoryAdapter()
    adapter.delete = vi.fn(async () => { throw new Error("delete unavailable") })
    adapter.has = vi.fn(async () => { throw new Error("has unavailable") })
    const cache = new CacheService({ adapter })
    await expect(cache.delete("key")).resolves.toBe(false)
    await expect(cache.has("key")).resolves.toBe(false)
  })
})
