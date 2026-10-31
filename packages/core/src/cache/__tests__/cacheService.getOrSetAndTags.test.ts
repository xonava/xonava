import { describe, expect, it, vi } from "vitest"
import { ConfigurationError, ValidationError } from "../../domain"
import {
  CacheAdapterError,
  CacheOverloadError,
  CacheService,
  type CacheAdapter,
  type CacheConfig,
} from "../cache"

function createAdapter(): CacheAdapter {
  return {
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => true),
    has: vi.fn(async () => true),
    clear: vi.fn(async () => undefined),
    addToTag: vi.fn(async () => undefined),
    getTagGeneration: undefined,
    getTagKeys: vi.fn(async () => []),
    deleteTag: vi.fn(async () => undefined),
  } as unknown as CacheAdapter
}

interface GenerationHarness {
  readonly adapter: CacheAdapter
  readonly generations: Map<string, string>
}

function createGenerationAdapter(critical = false): GenerationHarness {
  const generations = new Map<string, string>()
  const base = createAdapter()
  const adapter: CacheAdapter = {
    ...base,
    ...(critical ? { capabilities: { tagGenerationConsistency: "linearizable", coherenceScope: "shared" } as const } : {}),
    getTagGeneration: vi.fn(async (tag: string) => generations.get(tag)),
    advanceTagGeneration: vi.fn(async (tag: string) => {
      const next = String(Number(generations.get(tag) ?? "0") + 1)
      generations.set(tag, next)
      return next
    }),
  }
  return { adapter, generations }
}

function cacheOf(adapter: CacheAdapter, extra: Partial<CacheConfig> = {}): CacheService {
  return new CacheService({ adapter, ...extra })
}

function criticalOf(harness: GenerationHarness, extra: Partial<CacheConfig> = {}): CacheService {
  return cacheOf(harness.adapter, { correctnessCritical: true, ...extra })
}

/** Storage key for a generation string, as built by the service. */
function genKey(key: string, generation: string): string {
  return `__generation__:${JSON.stringify(generation)}:${key}`
}

function remote(epoch: number, ...pairs: string[]): string {
  return JSON.stringify([`local:${epoch}`, ...pairs])
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected rejection")
    },
    (error: unknown) => error,
  )
}

async function expectRejection(promise: Promise<unknown>, type: new (...args: never[]) => Error, message: string): Promise<Error> {
  const error = await rejection(promise)
  expect(error).toBeInstanceOf(type)
  expect((error as Error).message).toBe(message)
  return error as Error
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const KEY_MESSAGE = "Cache key must not exceed 2048 UTF-8 bytes"
const TAG_MESSAGE = "Cache tag must be non-empty and not exceed 256 UTF-8 bytes"

describe("cache input validation", () => {
  it("validates keys on every keyed operation", async () => {
    const adapter = createAdapter()
    const cache = cacheOf(adapter)
    const tooLong = "a".repeat(2049)
    await cache.get("a".repeat(2048))
    await cache.get("é".repeat(1024))
    await expectRejection(cache.get(tooLong), ValidationError, KEY_MESSAGE)
    await expectRejection(cache.get("é".repeat(1025)), ValidationError, KEY_MESSAGE)
    await expectRejection(cache.get(5 as never), ValidationError, KEY_MESSAGE)
    await expectRejection(cache.getOrSet(tooLong, async () => 1), ValidationError, KEY_MESSAGE)
    await expectRejection(cache.set(tooLong, 1), ValidationError, KEY_MESSAGE)
    await expectRejection(cache.delete(tooLong), ValidationError, KEY_MESSAGE)
    await expectRejection(cache.has(tooLong), ValidationError, KEY_MESSAGE)
    await expectRejection(cache.addToTag("tag", tooLong), ValidationError, KEY_MESSAGE)
    expect(adapter.set).not.toHaveBeenCalled()
    expect(adapter.delete).not.toHaveBeenCalled()
    expect(adapter.has).not.toHaveBeenCalled()
    expect(adapter.addToTag).not.toHaveBeenCalled()
    expect(adapter.get).toHaveBeenCalledTimes(2)
  })

  it("validates tags on every tagged operation", async () => {
    const adapter = createAdapter()
    const cache = cacheOf(adapter)
    await cache.invalidateTag("a".repeat(256))
    await cache.invalidateTag("é".repeat(128))
    await expectRejection(cache.invalidateTag(""), ValidationError, TAG_MESSAGE)
    await expectRejection(cache.invalidateTag("a".repeat(257)), ValidationError, TAG_MESSAGE)
    await expectRejection(cache.invalidateTag("é".repeat(129)), ValidationError, TAG_MESSAGE)
    await expectRejection(cache.invalidateTag(5 as never), ValidationError, TAG_MESSAGE)
    await expectRejection(cache.addToTag("", "key"), ValidationError, TAG_MESSAGE)
    expect(adapter.deleteTag).toHaveBeenCalledTimes(2)
    expect(adapter.addToTag).not.toHaveBeenCalled()
    await cache.addToTag("tag", "key")
    expect(adapter.addToTag).toHaveBeenCalledWith("tag", "key")
  })

  it("validates tag lists in getOrSet and invalidateTags", async () => {
    const adapter = createAdapter()
    const cache = cacheOf(adapter)
    const resolver = vi.fn(async () => "v")
    const hundred = Array.from({ length: 100 }, (_, index) => `t${index}`)
    await expect(cache.getOrSet("k", resolver, hundred)).resolves.toBe("v")
    const countMessage = "Cache calls accept at most 100 tags"
    await expectRejection(cache.getOrSet("k", resolver, [...hundred, "extra"]), ValidationError, countMessage)
    await expectRejection(cache.getOrSet("k", resolver, "tag" as never), ValidationError, countMessage)
    await expectRejection(cache.getOrSet("k", resolver, ["a", "a"]), ValidationError, "Cache tags must be unique")
    await expectRejection(cache.getOrSet("k", resolver, ["a", ""]), ValidationError, TAG_MESSAGE)
    await expectRejection(cache.invalidateTags(["a", "a"]), ValidationError, "Cache tags must be unique")
    await expectRejection(cache.invalidateTags([...hundred, "extra"]), ValidationError, countMessage)
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(adapter.deleteTag).not.toHaveBeenCalled()
    await cache.invalidateTags(["a", "b"])
    expect(vi.mocked(adapter.deleteTag).mock.calls).toEqual([["a"], ["b"]])
  })

  it("validates configuration and per-call TTLs", async () => {
    const adapter = createAdapter()
    const ttlConfig = "Cache defaultTtlMs must be a positive safe integer"
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => cacheOf(adapter, { defaultTtlMs: bad })).toThrow(ConfigurationError)
      expect(() => cacheOf(adapter, { defaultTtlMs: bad })).toThrow(ttlConfig)
      expect(() => cacheOf(adapter, { maxInFlight: bad })).toThrow("Cache maxInFlight must be a positive safe integer")
    }
    expect(() => cacheOf(adapter, { defaultTtlMs: 1, maxInFlight: 1 })).not.toThrow()

    const cache = cacheOf(adapter)
    const ttlMessage = "Cache TTL must be a positive safe integer"
    await expectRejection(cache.set("k", 1, 0), ValidationError, ttlMessage)
    await expectRejection(cache.getOrSet("k", async () => 1, [], 0), ValidationError, ttlMessage)
    await expectRejection(cache.set("k", 1, 1.5), ValidationError, ttlMessage)
    await cache.set("k", "v", 1)
    expect(adapter.set).toHaveBeenLastCalledWith("k", "v", 1)
    await cache.set("k", "v")
    expect(adapter.set).toHaveBeenLastCalledWith("k", "v", 120_000)
    await cache.getOrSet("other", async () => "x", [], 5)
    expect(adapter.set).toHaveBeenLastCalledWith("other", "x", 5)
    await cacheOf(adapter, { defaultTtlMs: 77 }).getOrSet("third", async () => "y")
    expect(adapter.set).toHaveBeenLastCalledWith("third", "y", 77)
  })
})

describe("correctness-critical construction", () => {
  it("requires linearizable, shared capabilities and both generation primitives", () => {
    const message = "Cache operation failed: shared tag generation unavailable"
    const full = createGenerationAdapter(true).adapter
    expect(() => cacheOf(full, { correctnessCritical: true })).not.toThrow()
    const withoutCapabilities = { ...full }
    delete (withoutCapabilities as { capabilities?: unknown }).capabilities
    expect(() => cacheOf(withoutCapabilities, { correctnessCritical: true })).toThrow(CacheAdapterError)
    expect(() => cacheOf(withoutCapabilities, { correctnessCritical: true })).toThrow(message)
    const caps = full.capabilities
    expect(() => cacheOf({ ...full, capabilities: { ...caps, tagGenerationConsistency: "eventual" } }, { correctnessCritical: true })).toThrow(message)
    expect(() => cacheOf({ ...full, capabilities: { ...caps, coherenceScope: "process" } }, { correctnessCritical: true })).toThrow(message)
    expect(() => cacheOf({ ...full, getTagGeneration: undefined } as never, { correctnessCritical: true })).toThrow(message)
    expect(() => cacheOf({ ...full, advanceTagGeneration: undefined } as never, { correctnessCritical: true })).toThrow(message)
    // The same adapters are fine when the flag is off.
    expect(() => cacheOf({ ...full, getTagGeneration: undefined } as never)).not.toThrow()
  })
})

describe("getOrSet cache hits and misses", () => {
  it("treats falsy cached values as hits and never consults generations without tags", async () => {
    const { adapter } = createGenerationAdapter()
    const cache = cacheOf(adapter)
    const resolver = vi.fn(async () => "fresh")
    for (const cached of [0, null, "", false]) {
      vi.mocked(adapter.get).mockResolvedValueOnce(cached as never)
      await expect(cache.getOrSet("k", resolver)).resolves.toBe(cached)
    }
    expect(resolver).not.toHaveBeenCalled()
    expect(adapter.getTagGeneration).not.toHaveBeenCalled()
    await expect(cache.getOrSet("k", resolver)).resolves.toBe("fresh")
    expect(adapter.set).toHaveBeenCalledWith("k", "fresh", 120_000)
    expect(adapter.getTagGeneration).not.toHaveBeenCalled()
    expect(adapter.addToTag).not.toHaveBeenCalled()
  })

  it("stores tagged values under their remote generation key and indexes each tag", async () => {
    const { adapter, generations } = createGenerationAdapter()
    generations.set("a", "7")
    const cache = cacheOf(adapter)
    await expect(cache.getOrSet("k", async () => "v", ["a", "b"])).resolves.toBe("v")
    const storageKey = genKey("k", remote(0, "a", "7", "b", "0"))
    expect(adapter.get).toHaveBeenCalledWith(storageKey)
    expect(adapter.set).toHaveBeenCalledWith(storageKey, "v", 120_000)
    expect(vi.mocked(adapter.addToTag).mock.calls).toEqual([["a", storageKey], ["b", storageKey]])
    expect(vi.mocked(adapter.getTagGeneration!).mock.calls).toEqual([["a"], ["b"], ["a"], ["b"]])
  })

  it("returns a tagged hit after re-validating the generation", async () => {
    const { adapter } = createGenerationAdapter()
    vi.mocked(adapter.get).mockResolvedValue("cached" as never)
    const cache = cacheOf(adapter)
    const resolver = vi.fn(async () => "fresh")
    await expect(cache.getOrSet("k", resolver, ["t"])).resolves.toBe("cached")
    expect(resolver).not.toHaveBeenCalled()
    expect(adapter.getTagGeneration).toHaveBeenCalledTimes(2)
  })

  it("recomputes when the generation moved while the cached value was read", async () => {
    const { adapter, generations } = createGenerationAdapter()
    vi.mocked(adapter.get).mockImplementationOnce(async () => {
      generations.set("t", "9")
      return "old" as never
    })
    const cache = cacheOf(adapter)
    await expect(cache.getOrSet("k", async () => "fresh", ["t"])).resolves.toBe("fresh")
    expect(adapter.set).not.toHaveBeenCalled()
  })

  it("recomputes when a clear lands while the generation is re-checked", async () => {
    const { adapter } = createGenerationAdapter()
    const cache = cacheOf(adapter)
    vi.mocked(adapter.get).mockResolvedValueOnce("old" as never)
    vi.mocked(adapter.getTagGeneration!).mockImplementation(async () => {
      if (vi.mocked(adapter.getTagGeneration!).mock.calls.length === 2) void cache.clear()
      return "1"
    })
    await expect(cache.getOrSet("k", async () => "fresh", ["t"])).resolves.toBe("fresh")
    expect(adapter.set).not.toHaveBeenCalled()
  })

  it("discards a cached value read across a clear and never writes the resolver result", async () => {
    const adapter = createAdapter()
    const cache = cacheOf(adapter)
    vi.mocked(adapter.get).mockImplementationOnce(async () => {
      await cache.clear()
      return "stale" as never
    })
    await expect(cache.getOrSet("k", async () => "fresh")).resolves.toBe("fresh")
    expect(adapter.set).not.toHaveBeenCalled()
  })

  it("does not write when a tag generation moves during the resolver", async () => {
    const { adapter } = createGenerationAdapter()
    const cache = cacheOf(adapter)
    const value = await cache.getOrSet("k", async () => {
      await cache.invalidateTag("t")
      return "v"
    }, ["t"])
    expect(value).toBe("v")
    expect(adapter.set).not.toHaveBeenCalled()
    expect(adapter.addToTag).not.toHaveBeenCalled()
  })

  it("keeps a swallowed addToTag failure from failing the lookup", async () => {
    const adapter = createAdapter()
    vi.mocked(adapter.addToTag).mockRejectedValue(new Error("index down"))
    await expect(cacheOf(adapter).getOrSet("k", async () => "v", ["t", "u"])).resolves.toBe("v")
    expect(adapter.addToTag).toHaveBeenCalledTimes(2)
  })

  it("evicts a value whose backend write raced an invalidation", async () => {
    const adapter = createAdapter()
    const cache = cacheOf(adapter)
    vi.mocked(adapter.set).mockImplementationOnce(async () => {
      await cache.clear()
    })
    await expect(cache.getOrSet("k", async () => "v", ["t"])).resolves.toBe("v")
    expect(adapter.delete).toHaveBeenCalledTimes(1)
    expect(vi.mocked(adapter.delete).mock.calls[0]![0]).toBe(genKey("k", "fallback:0"))
    expect(adapter.addToTag).not.toHaveBeenCalled()
  })
})

describe("single-flight bookkeeping", () => {
  it("removes settled lookups so later misses run their own resolver", async () => {
    const adapter = createAdapter()
    const cache = cacheOf(adapter)
    const resolver = vi.fn(async () => "v")
    await cache.getOrSet("k", resolver)
    await cache.getOrSet("k", resolver)
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it("releases capacity when a resolver rejects", async () => {
    const adapter = createAdapter()
    const cache = cacheOf(adapter, { maxInFlight: 1 })
    await expect(cache.getOrSet("a", async () => { throw new Error("boom") })).rejects.toThrow("boom")
    await expect(cache.getOrSet("b", async () => "ok")).resolves.toBe("ok")
  })

  it("rejects new misses beyond maxInFlight without running their resolver", async () => {
    const adapter = createAdapter()
    const cache = cacheOf(adapter, { maxInFlight: 2 })
    const gate = deferred<string>()
    const first = cache.getOrSet("a", () => gate.promise)
    const second = cache.getOrSet("b", () => gate.promise)
    const resolver = vi.fn(async () => "c")
    await expectRejection(cache.getOrSet("c", resolver), CacheOverloadError, "Cache resolver capacity exhausted (2 in flight)")
    expect(resolver).not.toHaveBeenCalled()
    gate.resolve("done")
    await expect(Promise.all([first, second])).resolves.toEqual(["done", "done"])
    await expect(cache.getOrSet("c", resolver)).resolves.toBe("c")
  })

  it("keeps a replacement lookup joinable when a detached one settles", async () => {
    const adapter = createAdapter()
    const cache = cacheOf(adapter)
    const first = deferred<string>()
    const second = deferred<string>()
    const resolvers = [vi.fn(() => first.promise), vi.fn(() => second.promise), vi.fn(async () => "third")]
    const a = cache.getOrSet("k", resolvers[0]!)
    await vi.waitFor(() => expect(resolvers[0]).toHaveBeenCalledTimes(1))
    await cache.set("k", "manual")
    const b = cache.getOrSet("k", resolvers[1]!)
    await vi.waitFor(() => expect(resolvers[1]).toHaveBeenCalledTimes(1))
    first.resolve("one")
    await expect(a).resolves.toBe("one")
    const c = cache.getOrSet("k", resolvers[2]!)
    second.resolve("two")
    await expect(c).resolves.toBe("two")
    await expect(b).resolves.toBe("two")
    expect(resolvers[2]).not.toHaveBeenCalled()
    expect(vi.mocked(adapter.set).mock.calls).toEqual([["k", "manual", 120_000], ["k", "two", 120_000]])
  })

  it("fences an in-flight lookup on set and on delete", async () => {
    for (const mutate of ["set", "delete"] as const) {
      const adapter = createAdapter()
      const cache = cacheOf(adapter)
      const gate = deferred<string>()
      const resolver = vi.fn(() => gate.promise)
      const pending = cache.getOrSet("k", resolver)
      await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(1))
      if (mutate === "set") await cache.set("k", "manual")
      else await expect(cache.delete("k")).resolves.toBe(true)
      const fresh = vi.fn(async () => "fresh")
      await expect(cache.getOrSet("k", fresh)).resolves.toBe("fresh")
      expect(fresh).toHaveBeenCalledTimes(1)
      gate.resolve("late")
      await expect(pending).resolves.toBe("late")
      const written = vi.mocked(adapter.set).mock.calls.map((call) => call[1])
      expect(written).not.toContain("late")
    }
  })
})

describe("adapter failure handling", () => {
  const boom = new Error("adapter down")

  it("swallows failures in best-effort mode and reports each operation", async () => {
    const adapter = createAdapter()
    const onError = vi.fn()
    const cache = cacheOf(adapter, { telemetry: { onError } })
    vi.mocked(adapter.get).mockRejectedValue(boom)
    vi.mocked(adapter.set).mockRejectedValue(boom)
    vi.mocked(adapter.delete).mockRejectedValue(boom)
    vi.mocked(adapter.has).mockRejectedValue(boom)
    vi.mocked(adapter.clear).mockRejectedValue(boom)
    vi.mocked(adapter.addToTag).mockRejectedValue(boom)
    vi.mocked(adapter.deleteTag).mockRejectedValue(boom)
    await expect(cache.get("k")).resolves.toBeUndefined()
    await expect(cache.set("k", 1)).resolves.toBeUndefined()
    await expect(cache.delete("k")).resolves.toBe(false)
    await expect(cache.has("k")).resolves.toBe(false)
    await expect(cache.clear()).resolves.toBeUndefined()
    await expect(cache.addToTag("t", "k")).resolves.toBeUndefined()
    await expect(cache.invalidateTag("t")).resolves.toBeUndefined()
    expect(onError.mock.calls.map((call) => call[0])).toStrictEqual([
      { operation: "get", key: "k", error: boom },
      { operation: "set", key: "k", error: boom },
      { operation: "delete", key: "k", error: boom },
      { operation: "has", key: "k", error: boom },
      { operation: "clear", error: boom },
      { operation: "addToTag", key: "k", error: boom },
      { operation: "invalidateTag", key: "t", error: boom },
    ])
  })

  it("rethrows the original failure in correctness-critical mode, except for clear", async () => {
    const harness = createGenerationAdapter(true)
    const { adapter } = harness
    const cache = criticalOf(harness)
    vi.mocked(adapter.get).mockRejectedValue(boom)
    vi.mocked(adapter.set).mockRejectedValue(boom)
    vi.mocked(adapter.delete).mockRejectedValue(boom)
    vi.mocked(adapter.has).mockRejectedValue(boom)
    vi.mocked(adapter.clear).mockRejectedValue(boom)
    vi.mocked(adapter.addToTag).mockRejectedValue(boom)
    expect(await rejection(cache.get("k"))).toBe(boom)
    expect(await rejection(cache.set("k", 1))).toBe(boom)
    expect(await rejection(cache.delete("k"))).toBe(boom)
    expect(await rejection(cache.has("k"))).toBe(boom)
    expect(await rejection(cache.addToTag("t", "k"))).toBe(boom)
    expect(await rejection(cache.getOrSet("k", async () => 1))).toBe(boom)
    await expect(cache.clear()).resolves.toBeUndefined()
  })

  it("returns the adapter results of has and delete", async () => {
    const adapter = createAdapter()
    const cache = cacheOf(adapter)
    vi.mocked(adapter.has).mockResolvedValueOnce(false)
    await expect(cache.has("k")).resolves.toBe(false)
    await expect(cache.has("k")).resolves.toBe(true)
    vi.mocked(adapter.delete).mockResolvedValueOnce(false)
    await expect(cache.delete("k")).resolves.toBe(false)
    await expect(cache.delete("k")).resolves.toBe(true)
  })
})

describe("telemetry", () => {
  it("emits a safe, keyless-aware failure event through a unified telemetry port", async () => {
    const adapter = createAdapter()
    const emit = vi.fn()
    const onError = vi.fn()
    const cache = cacheOf(adapter, { telemetry: { emit, onError } as never })
    vi.mocked(adapter.get).mockRejectedValue(new TypeError("secret detail"))
    vi.mocked(adapter.clear).mockRejectedValue("not an error")
    await cache.get("tenant-secret")
    await cache.clear()
    expect(onError).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledTimes(2)
    const [first, second] = emit.mock.calls.map((call) => call[0] as { name: string; severity: string; timestamp: Date; attributes: unknown })
    expect(first).toMatchObject({ name: "cache.operation.failure", severity: "error" })
    expect(first!.timestamp).toBeInstanceOf(Date)
    expect(first!.attributes).toEqual({ operation: "get", hasKey: true, errorType: "TypeError" })
    expect(second!.attributes).toEqual({ operation: "clear", hasKey: false, errorType: "unknown" })
    expect(JSON.stringify(emit.mock.calls)).not.toContain("tenant-secret")
    expect(JSON.stringify(emit.mock.calls)).not.toContain("secret detail")
  })

  it("survives a telemetry callback that throws and one that is missing", async () => {
    const adapter = createAdapter()
    vi.mocked(adapter.get).mockRejectedValue(new Error("x"))
    const throwing = cacheOf(adapter, { telemetry: { onError: () => { throw new Error("t") } } })
    await expect(throwing.get("k")).resolves.toBeUndefined()
    const empty = cacheOf(adapter, { telemetry: {} })
    await expect(empty.get("k")).resolves.toBeUndefined()
  })
})

describe("tag generation fallback epochs", () => {
  it("uses the fallback epoch when the adapter has no generation primitives", async () => {
    const adapter = createAdapter()
    const cache = cacheOf(adapter)
    await cache.getOrSet("k", async () => "v", ["t"])
    expect(adapter.get).toHaveBeenLastCalledWith(genKey("k", "fallback:0"))
    expect(adapter.set).toHaveBeenLastCalledWith(genKey("k", "fallback:0"), "v", 120_000)
    await cache.invalidateTag("t")
    await cache.getOrSet("k", async () => "v", ["t"])
    expect(adapter.get).toHaveBeenLastCalledWith(genKey("k", "fallback:1"))
    await cache.clear()
    await cache.getOrSet("k", async () => "v", ["t"])
    expect(adapter.get).toHaveBeenLastCalledWith(genKey("k", "fallback:2"))
    expect(adapter.deleteTag).toHaveBeenCalledWith("t")
  })

  it("advances the remote generation key epoch on clear", async () => {
    const { adapter } = createGenerationAdapter()
    const cache = cacheOf(adapter)
    await cache.getOrSet("k", async () => "v", ["t"])
    expect(adapter.get).toHaveBeenLastCalledWith(genKey("k", remote(0, "t", "0")))
    await cache.clear()
    await cache.getOrSet("k", async () => "v", ["t"])
    expect(adapter.get).toHaveBeenLastCalledWith(genKey("k", remote(1, "t", "0")))
  })

  it("enters fallback once, stays stable while unavailable and re-enters the remote epoch once on recovery", async () => {
    const { adapter } = createGenerationAdapter()
    const cache = cacheOf(adapter)
    let failing = true
    vi.mocked(adapter.getTagGeneration!).mockImplementation(async () => {
      if (failing) throw new Error("backend down")
      return undefined
    })
    const run = () => cache.getOrSet("k", async () => "v", ["t"])
    await run()
    await run()
    expect(vi.mocked(adapter.get).mock.calls).toEqual([[genKey("k", "fallback:1")], [genKey("k", "fallback:1")]])
    expect(vi.mocked(adapter.set).mock.calls.map((call) => call[0])).toEqual([genKey("k", "fallback:1"), genKey("k", "fallback:1")])
    failing = false
    await run()
    await run()
    const reads = vi.mocked(adapter.get).mock.calls.slice(2)
    expect(reads).toEqual([[genKey("k", remote(2, "t", "0"))], [genKey("k", remote(2, "t", "0"))]])
    expect(vi.mocked(adapter.set).mock.calls.slice(2).map((call) => call[0])).toEqual([genKey("k", remote(2, "t", "0")), genKey("k", remote(2, "t", "0"))])
  })

  it("rejects malformed or oversized backend generations", async () => {
    const { adapter, generations } = createGenerationAdapter()
    const cache = cacheOf(adapter)
    const accepted = "g".repeat(256)
    generations.set("t", accepted)
    await cache.getOrSet("k", async () => "v", ["t"])
    expect(adapter.get).toHaveBeenLastCalledWith(genKey("k", remote(0, "t", accepted)))
    generations.set("t", "g".repeat(257))
    await cache.getOrSet("k", async () => "v", ["t"])
    expect(adapter.get).toHaveBeenLastCalledWith(genKey("k", "fallback:1"))

    const harness = createGenerationAdapter(true)
    const critical = criticalOf(harness)
    harness.generations.set("t", "g".repeat(257))
    const message = "Cache operation failed: getTagGeneration"
    await expectRejection(critical.getOrSet("k", async () => "v", ["t"]), CacheAdapterError, message)
    vi.mocked(harness.adapter.getTagGeneration!).mockResolvedValue(5 as never)
    await expectRejection(critical.getOrSet("k", async () => "v", ["t"]), CacheAdapterError, message)
    harness.generations.set("t", "g".repeat(256))
    vi.mocked(harness.adapter.getTagGeneration!).mockImplementation(async (tag) => harness.generations.get(tag))
    await expect(critical.getOrSet("k", async () => "v", ["t"])).resolves.toBe("v")
  })

  it("fails closed when the generation primitive disappears between checks", async () => {
    const harness = createGenerationAdapter(true)
    const cache = criticalOf(harness)
    vi.mocked(harness.adapter.get).mockImplementationOnce(async () => {
      delete (harness.adapter as { getTagGeneration?: unknown }).getTagGeneration
      return "cached" as never
    })
    await expectRejection(cache.getOrSet("k", async () => "v", ["t"]), CacheAdapterError, "Cache operation failed: getTagGeneration")
  })

  it("rethrows generation read failures in correctness-critical mode", async () => {
    const harness = createGenerationAdapter(true)
    const cache = criticalOf(harness)
    const failure = new Error("generation read failed")
    vi.mocked(harness.adapter.getTagGeneration!).mockRejectedValue(failure)
    expect(await rejection(cache.getOrSet("k", async () => "v", ["t"]))).toBe(failure)
  })
})

describe("invalidateTag", () => {
  it("falls back to the local epoch when the adapter cannot advance", async () => {
    const harness = createGenerationAdapter()
    delete (harness.adapter as { advanceTagGeneration?: unknown }).advanceTagGeneration
    const cache = cacheOf(harness.adapter)
    await cache.invalidateTag("t")
    expect(harness.adapter.deleteTag).toHaveBeenCalledWith("t")
    await cache.getOrSet("k", async () => "v", ["t"])
    expect(harness.adapter.get).toHaveBeenLastCalledWith(genKey("k", remote(1, "t", "0")))
  })

  it("advances the local epoch and stays best effort when the backend advance fails", async () => {
    const harness = createGenerationAdapter()
    vi.mocked(harness.adapter.advanceTagGeneration!).mockRejectedValue(new Error("down"))
    const cache = cacheOf(harness.adapter)
    await expect(cache.invalidateTag("t")).resolves.toBeUndefined()
    expect(harness.adapter.deleteTag).toHaveBeenCalledWith("t")
    await cache.getOrSet("k", async () => "v", ["t"])
    expect(harness.adapter.get).toHaveBeenLastCalledWith(genKey("k", remote(1, "t", "0")))
  })

  it("advances the shared generation and skips the tag-index delete when correctness-critical", async () => {
    const harness = createGenerationAdapter(true)
    const cache = criticalOf(harness)
    await cache.invalidateTag("t")
    expect(harness.adapter.advanceTagGeneration).toHaveBeenCalledWith("t")
    expect(harness.generations.get("t")).toBe("1")
    expect(harness.adapter.deleteTag).not.toHaveBeenCalled()
    await cache.invalidateTags(["a", "b"])
    expect(harness.adapter.deleteTag).not.toHaveBeenCalled()
    expect(harness.generations.get("b")).toBe("1")
  })

  it("keeps CacheAdapterError identity and wraps other advance failures when correctness-critical", async () => {
    const harness = createGenerationAdapter(true)
    const cache = criticalOf(harness)
    const own = new CacheAdapterError("custom")
    vi.mocked(harness.adapter.advanceTagGeneration!).mockRejectedValueOnce(own)
    expect(await rejection(cache.invalidateTag("t"))).toBe(own)
    const cause = new Error("raw")
    vi.mocked(harness.adapter.advanceTagGeneration!).mockRejectedValueOnce(cause)
    const wrapped = await expectRejection(cache.invalidateTag("t"), CacheAdapterError, "Cache operation failed: advanceTagGeneration")
    expect(wrapped.cause).toBe(cause)
    expect((wrapped as CacheAdapterError).operation).toBe("advanceTagGeneration")
  })

  it("requires the generation primitives at call time when correctness-critical", async () => {
    const message = "Cache operation failed: shared tag generation unavailable"
    const noAdvance = createGenerationAdapter(true)
    const cacheA = criticalOf(noAdvance)
    delete (noAdvance.adapter as { advanceTagGeneration?: unknown }).advanceTagGeneration
    await expectRejection(cacheA.invalidateTag("t"), CacheAdapterError, message)
    await expectRejection(cacheA.getOrSet("k", async () => "v", ["t"]), CacheAdapterError, message)
    await expect(cacheA.getOrSet("k", async () => "v")).resolves.toBe("v")

    const noGet = createGenerationAdapter(true)
    const cacheB = criticalOf(noGet)
    delete (noGet.adapter as { getTagGeneration?: unknown }).getTagGeneration
    await expectRejection(cacheB.getOrSet("k", async () => "v", ["t"]), CacheAdapterError, message)

    const lenient = createAdapter()
    await expect(cacheOf(lenient).getOrSet("k", async () => "v", ["t"])).resolves.toBe("v")
  })
})
