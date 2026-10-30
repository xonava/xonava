import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ConfigurationError } from "@xonava/core/domain"
import { InMemoryCacheAdapter } from "../inMemoryCacheAdapter"

interface Internals {
  values: Map<string, unknown>
  tags: Map<string, Map<string, number>>
  keyTags: Map<string, Set<string>>
  revisions: Map<string, number>
  sweepCursor: Iterator<string> | undefined
}

function internals(cache: InMemoryCacheAdapter): Internals {
  return cache as unknown as Internals
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => {
  vi.useRealTimers()
})

/** Stores `total` entries; the indexes in `shortLived` expire after 10 ms, the rest never. */
async function populate(cache: InMemoryCacheAdapter, total: number, shortLived: readonly number[]): Promise<void> {
  for (let i = 0; i < total; i++) {
    await cache.set(`k${i}`, i, shortLived.includes(i) ? 10 : undefined)
  }
  internals(cache).sweepCursor = undefined
}

describe("InMemoryCacheAdapter construction", () => {
  it.each([0, -1, 1.5, Number.NaN])("rejects maxEntries %s with an exact message", (maxEntries) => {
    const build = () => new InMemoryCacheAdapter({ maxEntries })
    expect(build).toThrow(ConfigurationError)
    expect(build).toThrow("InMemoryCacheAdapter maxEntries must be a positive safe integer")
  })
})

describe("InMemoryCacheAdapter expiry", () => {
  it("expires an entry exactly at its expiry instant, not before", async () => {
    const cache = new InMemoryCacheAdapter()
    await cache.set("k", "v", 100)
    vi.setSystemTime(99)
    expect(await cache.has("k")).toBe(true)
    vi.setSystemTime(100)
    expect(await cache.has("k")).toBe(false)
    expect(await cache.get("k")).toBeUndefined()
  })

  it("keeps entries without a ttl indefinitely", async () => {
    const cache = new InMemoryCacheAdapter()
    await cache.set("k", "v")
    vi.setSystemTime(10 ** 13)
    expect(await cache.get("k")).toBe("v")
  })

  it("removes an expired entry the sweep did not reach when it is read, checked or deleted", async () => {
    const cache = new InMemoryCacheAdapter()
    await populate(cache, 40, [35, 36, 37])
    vi.setSystemTime(10)
    expect(await cache.get("k35")).toBeUndefined()
    expect(internals(cache).values.has("k35")).toBe(false)
    internals(cache).sweepCursor = undefined
    expect(await cache.has("k36")).toBe(false)
    expect(internals(cache).values.has("k36")).toBe(false)
    internals(cache).sweepCursor = undefined
    expect(await cache.delete("k37")).toBe(false)
    expect(await cache.delete("k0")).toBe(true)
  })

  it("sweeps exactly 32 entries per operation", async () => {
    const cache = new InMemoryCacheAdapter()
    await populate(cache, 40, Array.from({ length: 40 }, (_, i) => i))
    vi.setSystemTime(10)
    await cache.has("unrelated")
    expect(internals(cache).values.size).toBe(8)
  })

  it("resumes an exhausted sweep from the start and still removes expired entries", async () => {
    const cache = new InMemoryCacheAdapter()
    await populate(cache, 3, [1])
    const exhausted = internals(cache).values.keys()
    for (const _key of exhausted) void _key
    internals(cache).sweepCursor = exhausted
    vi.setSystemTime(10)
    await cache.has("unrelated")
    expect(internals(cache).values.has("k1")).toBe(false)
    expect(internals(cache).values.size).toBe(2)
  })

  it("resets the sweep cursor when the store is empty", async () => {
    const cache = new InMemoryCacheAdapter()
    const done = new Map<string, number>().keys()
    internals(cache).sweepCursor = done
    await cache.has("x")
    expect(internals(cache).sweepCursor).toBeUndefined()
  })

  it.each(["get", "set", "has", "delete", "addToTag", "getTagKeys"] as const)("%s runs the expiry sweep", async (op) => {
    const cache = new InMemoryCacheAdapter()
    await populate(cache, 3, [0, 1])
    vi.setSystemTime(10)
    const run = {
      get: () => cache.get("k2"),
      set: () => cache.set("fresh", 1),
      has: () => cache.has("k2"),
      delete: () => cache.delete("k2"),
      addToTag: () => cache.addToTag("t", "k2"),
      getTagKeys: () => cache.getTagKeys("t"),
    }[op]
    await run()
    expect(internals(cache).values.has("k0")).toBe(false)
    expect(internals(cache).values.has("k1")).toBe(false)
  })
})

describe("InMemoryCacheAdapter capacity", () => {
  it("evicts the least recently used entry and refreshes recency on read and overwrite", async () => {
    const cache = new InMemoryCacheAdapter({ maxEntries: 3 })
    await cache.set("a", 1)
    await cache.set("b", 2)
    await cache.set("c", 3)
    await cache.set("a", 11)
    await cache.set("d", 4)
    expect(await cache.has("b")).toBe(false)
    expect(await cache.get("a")).toBe(11)
    await cache.get("c")
    await cache.set("e", 5)
    expect(await cache.has("d")).toBe(false)
    expect([...internals(cache).values.keys()]).toEqual(["a", "c", "e"])
  })

  it("does not evict when overwriting an existing key at capacity", async () => {
    const cache = new InMemoryCacheAdapter({ maxEntries: 2 })
    await cache.set("a", 1)
    await cache.set("b", 2)
    await cache.set("b", 3)
    expect(await cache.get("a")).toBe(1)
    expect(await cache.get("b")).toBe(3)
  })

  it("prefers sweeping expired entries over evicting a live one when full", async () => {
    const cache = new InMemoryCacheAdapter({ maxEntries: 40 })
    await populate(cache, 40, [33, 34, 35, 36, 37, 38])
    vi.setSystemTime(10)
    await cache.set("fresh", "x")
    expect(internals(cache).values.has("k0")).toBe(true)
    expect(internals(cache).values.size).toBe(35)
  })

  it("evicts exactly down to maxEntries when nothing has expired", async () => {
    const cache = new InMemoryCacheAdapter({ maxEntries: 3 })
    await populate(cache, 3, [])
    await cache.set("new", 1)
    expect([...internals(cache).values.keys()]).toEqual(["k1", "k2", "new"])
  })

  it("does not run the capacity sweep while below capacity", async () => {
    const cache = new InMemoryCacheAdapter({ maxEntries: 100 })
    await populate(cache, 70, Array.from({ length: 20 }, (_, i) => 40 + i))
    vi.setSystemTime(10)
    await cache.set("fresh", 1)
    expect(internals(cache).values.size).toBe(71)
  })

  it("does not sweep at capacity minus one", async () => {
    const cache = new InMemoryCacheAdapter({ maxEntries: 41 })
    await populate(cache, 40, [35, 36])
    vi.setSystemTime(10)
    await cache.set("fresh", 1)
    expect(internals(cache).values.size).toBe(41)
  })

  it("also sweeps at exactly full capacity", async () => {
    const cache = new InMemoryCacheAdapter({ maxEntries: 40 })
    await populate(cache, 40, [35, 36])
    vi.setSystemTime(10)
    await cache.set("fresh", 1)
    expect(internals(cache).values.size).toBe(39)
  })
})

describe("InMemoryCacheAdapter tags", () => {
  it("removing one member keeps the tag for the others and prunes the tag when the last goes", async () => {
    const cache = new InMemoryCacheAdapter()
    await cache.set("a", 1)
    await cache.set("b", 2)
    await cache.addToTag("t", "a")
    await cache.addToTag("t", "b")
    await cache.delete("a")
    expect(await cache.getTagKeys("t")).toEqual(["b"])
    expect(internals(cache).tags.size).toBe(1)
    expect(internals(cache).keyTags.has("a")).toBe(false)
    await cache.delete("b")
    expect(internals(cache).tags.size).toBe(0)
    expect(internals(cache).keyTags.size).toBe(0)
  })

  it("ignores membership for absent and expired keys", async () => {
    const cache = new InMemoryCacheAdapter()
    await cache.addToTag("t", "missing")
    expect(internals(cache).tags.size).toBe(0)
    expect(internals(cache).keyTags.size).toBe(0)
    await cache.set("e", 1, 5)
    vi.setSystemTime(5)
    await cache.addToTag("t", "e")
    expect(internals(cache).tags.size).toBe(0)
    expect(await cache.getTagKeys("t")).toEqual([])
  })

  it("getTagKeys returns [] for an unknown tag and hides expired members the sweep missed", async () => {
    const cache = new InMemoryCacheAdapter()
    expect(await cache.getTagKeys("none")).toEqual([])
    await populate(cache, 40, [38])
    await cache.addToTag("t", "k1")
    await cache.addToTag("t", "k38")
    internals(cache).sweepCursor = undefined
    vi.setSystemTime(10)
    expect(await cache.getTagKeys("t")).toEqual(["k1"])
  })

  it("deleteTag removes members at their tagged revision and drops the tag even for superseded members", async () => {
    const cache = new InMemoryCacheAdapter()
    await cache.set("same", 1)
    await cache.set("moved", 1)
    await cache.addToTag("t", "same")
    await cache.addToTag("t", "moved")
    await cache.set("moved", 2)
    await cache.deleteTag("t")
    expect(await cache.has("same")).toBe(false)
    expect(await cache.get("moved")).toBe(2)
    expect(await cache.getTagKeys("t")).toEqual([])
    expect(internals(cache).tags.size).toBe(0)
    // The superseded key keeps no stale membership.
    expect(internals(cache).keyTags.get("moved")?.size ?? 0).toBe(0)
  })

  it("deleteTag on an unknown tag is a no-op", async () => {
    const cache = new InMemoryCacheAdapter()
    await cache.set("a", 1)
    await expect(cache.deleteTag("none")).resolves.toBeUndefined()
    expect(await cache.get("a")).toBe(1)
  })

  it("clear drops values, tags and memberships but keeps generations", async () => {
    const cache = new InMemoryCacheAdapter()
    await cache.set("a", 1)
    await cache.addToTag("t", "a")
    const generation = await cache.advanceTagGeneration("t")
    await cache.clear()
    expect(internals(cache).values.size).toBe(0)
    expect(internals(cache).tags.size).toBe(0)
    expect(internals(cache).keyTags.size).toBe(0)
    expect(internals(cache).sweepCursor).toBeUndefined()
    await cache.set("a", 2)
    expect(await cache.getTagKeys("t")).toEqual([])
    expect(await cache.getTagGeneration("t")).toBe(generation)
  })

  it("generations start at the string 0 and advance monotonically per tag", async () => {
    const cache = new InMemoryCacheAdapter()
    expect(await cache.getTagGeneration("t")).toBe("0")
    expect(await cache.advanceTagGeneration("t")).toBe("1")
    expect(await cache.advanceTagGeneration("t")).toBe("2")
    expect(await cache.getTagGeneration("t")).toBe("2")
    expect(await cache.getTagGeneration("other")).toBe("0")
  })
})
