import { describe, expect, it, vi } from "vitest"
import type { CacheAdapter } from "@xonava/core/cache"
import { ConfigurationError } from "@xonava/core/domain"
import { getCacheAdapter, type CacheAdapterFactories, type CacheProviderConfig } from "../cacheProviderFactory"

function stubAdapter(name: string): CacheAdapter {
  return { name } as unknown as CacheAdapter
}

function makeFactories() {
  const memoryAdapter = stubAdapter("memory")
  const kvAdapter = stubAdapter("kv")
  const memory = vi.fn(() => memoryAdapter)
  const kv = vi.fn(() => Promise.resolve(kvAdapter))
  const factories: CacheAdapterFactories = { memory, kv }
  return { factories, memory, kv, memoryAdapter, kvAdapter }
}

describe("getCacheAdapter engine dispatch", () => {
  it("builds the in-memory adapter only for the memory engine", async () => {
    const { factories, memory, kv, memoryAdapter } = makeFactories()
    await expect(getCacheAdapter({ engine: "memory" }, factories)).resolves.toBe(memoryAdapter)
    expect(memory).toHaveBeenCalledTimes(1)
    expect(kv).not.toHaveBeenCalled()
  })

  it("builds the KV adapter only for the kv engine", async () => {
    const { factories, memory, kv, kvAdapter } = makeFactories()
    await expect(getCacheAdapter({ engine: "kv" }, factories)).resolves.toBe(kvAdapter)
    expect(kv).toHaveBeenCalledTimes(1)
    expect(memory).not.toHaveBeenCalled()
  })

  it("rejects an unknown engine with a ConfigurationError naming it", async () => {
    const { factories, memory, kv } = makeFactories()
    const config = { engine: "redis" } as unknown as CacheProviderConfig
    const failure = await getCacheAdapter(config, factories).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ConfigurationError)
    expect((failure as Error).message).toBe("Unknown cache engine: redis")
    expect(memory).not.toHaveBeenCalled()
    expect(kv).not.toHaveBeenCalled()
  })
})

describe("getCacheAdapter memoisation", () => {
  it("returns the same promise per engine for the same factories", async () => {
    const { factories, memory } = makeFactories()
    const first = getCacheAdapter({ engine: "memory" }, factories)
    const second = getCacheAdapter({ engine: "memory" }, factories)
    expect(second).toBe(first)
    await first
    expect(memory).toHaveBeenCalledTimes(1)
  })

  it("keeps a separate adapter per engine", async () => {
    const { factories, memoryAdapter, kvAdapter } = makeFactories()
    const memory = await getCacheAdapter({ engine: "memory" }, factories)
    const kv = await getCacheAdapter({ engine: "kv" }, factories)
    expect(memory).toBe(memoryAdapter)
    expect(kv).toBe(kvAdapter)
    expect(await getCacheAdapter({ engine: "kv" }, factories)).toBe(kvAdapter)
  })

  it("does not share adapters between different factory sets", async () => {
    const a = makeFactories()
    const b = makeFactories()
    expect(await getCacheAdapter({ engine: "memory" }, a.factories)).toBe(a.memoryAdapter)
    expect(await getCacheAdapter({ engine: "memory" }, b.factories)).toBe(b.memoryAdapter)
    expect(a.memory).toHaveBeenCalledTimes(1)
    expect(b.memory).toHaveBeenCalledTimes(1)
  })

  it("evicts a failed creation so the next call retries", async () => {
    const adapter = stubAdapter("kv")
    const kv = vi.fn<() => Promise<CacheAdapter>>()
    kv.mockRejectedValueOnce(new Error("kv down")).mockResolvedValueOnce(adapter)
    const factories: CacheAdapterFactories = { memory: () => stubAdapter("memory"), kv }

    await expect(getCacheAdapter({ engine: "kv" }, factories)).rejects.toThrow("kv down")
    await expect(getCacheAdapter({ engine: "kv" }, factories)).resolves.toBe(adapter)
    expect(kv).toHaveBeenCalledTimes(2)
    // The successful promise is now cached.
    await getCacheAdapter({ engine: "kv" }, factories)
    expect(kv).toHaveBeenCalledTimes(2)
  })

  it("evicts only the failed engine", async () => {
    const memoryAdapter = stubAdapter("memory")
    const memory = vi.fn(() => memoryAdapter)
    const factories: CacheAdapterFactories = { memory, kv: () => Promise.reject(new Error("nope")) }
    await getCacheAdapter({ engine: "memory" }, factories)
    await expect(getCacheAdapter({ engine: "kv" }, factories)).rejects.toThrow("nope")
    await getCacheAdapter({ engine: "memory" }, factories)
    expect(memory).toHaveBeenCalledTimes(1)
  })
})
