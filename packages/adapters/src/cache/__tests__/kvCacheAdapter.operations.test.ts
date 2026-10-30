import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CacheAdapterError } from "@xonava/core/cache"
import { ValidationError } from "@xonava/core/domain"
import { KV_MAX_TAG_MEMBERS, KV_MIN_EXPIRATION_TTL_SECONDS, KvCacheAdapter } from "../kvCacheAdapter"

type PutOptions = { expirationTtl?: number } | undefined

/** Map-backed KV namespace with the Cloudflare surface the adapter uses, plus call recording. */
class FakeKv {
  readonly store = new Map<string, string>()
  readonly puts: Array<{ key: string; value: string; options: PutOptions }> = []
  readonly deletes: string[] = []
  readonly lists: Array<{ prefix?: string; cursor?: string; limit?: number } | undefined> = []
  pageSize = 1_000
  failOn: "get" | "put" | "delete" | "list" | undefined
  failKey: string | undefined
  readonly boom = new Error("kv boom")

  private maybeFail(op: "get" | "put" | "delete" | "list", key?: string): void {
    if (this.failOn === op && (this.failKey === undefined || this.failKey === key)) throw this.boom
  }

  get(key: string, options?: { type: "json" }): Promise<unknown> {
    try {
      // The adapter always reads JSON; a call without that option would return text on the real namespace.
      if (options?.type !== "json") throw new Error("kv.get without { type: 'json' }")
      this.maybeFail("get", key)
    } catch (error) {
      return Promise.reject(error as Error)
    }
    const raw = this.store.get(key)
    return Promise.resolve(raw === undefined ? null : (JSON.parse(raw) as unknown))
  }

  put(key: string, value: string, options?: PutOptions): Promise<void> {
    try {
      this.maybeFail("put", key)
    } catch (error) {
      return Promise.reject(error as Error)
    }
    this.puts.push({ key, value, options })
    this.store.set(key, value)
    return Promise.resolve()
  }

  delete(key: string): Promise<void> {
    try {
      this.maybeFail("delete", key)
    } catch (error) {
      return Promise.reject(error as Error)
    }
    this.deletes.push(key)
    this.store.delete(key)
    return Promise.resolve()
  }

  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    keys: Array<{ name: string }>
    list_complete: boolean
    cursor?: string
  }> {
    try {
      this.maybeFail("list")
    } catch (error) {
      return Promise.reject(error as Error)
    }
    this.lists.push(options)
    const all = [...this.store.keys()].filter((k) => k.startsWith(options?.prefix ?? "")).sort()
    const remaining = options?.cursor === undefined ? all : all.filter((k) => k > (options.cursor as string))
    const page = remaining.slice(0, this.pageSize)
    const done = remaining.length <= this.pageSize
    return Promise.resolve({ keys: page.map((name) => ({ name })), list_complete: done, ...(done ? {} : { cursor: page[page.length - 1] as string }) })
  }

  seed(key: string, value: unknown): void {
    this.store.set(key, JSON.stringify(value))
  }

  json(key: string): unknown {
    const raw = this.store.get(key)
    return raw === undefined ? undefined : (JSON.parse(raw) as unknown)
  }
}

function setup() {
  const kv = new FakeKv()
  return { kv, cache: new KvCacheAdapter(kv as never) }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})
afterEach(() => {
  vi.useRealTimers()
})

describe("KvCacheAdapter reads", () => {
  it("returns plain legacy JSON entries untouched", async () => {
    const { kv, cache } = setup()
    kv.seed("__cache__:a", "text")
    kv.seed("__cache__:b", 42)
    kv.seed("__cache__:c", [1, 2])
    kv.seed("__cache__:d", { x: 1 })
    kv.seed("__cache__:e", { $cacheEnvelope: 2, v: "no" })
    kv.seed("__cache__:f", true)
    kv.seed("__cache__:g", { $cacheEnvelope: "1", v: "no" })
    expect(await cache.get("a")).toBe("text")
    expect(await cache.get("b")).toBe(42)
    expect(await cache.get("c")).toEqual([1, 2])
    expect(await cache.get("d")).toEqual({ x: 1 })
    expect(await cache.get("e")).toEqual({ $cacheEnvelope: 2, v: "no" })
    expect(await cache.get("f")).toBe(true)
    expect(await cache.get("g")).toEqual({ $cacheEnvelope: "1", v: "no" })
    expect(await cache.has("c")).toBe(true)
  })

  it("decodes enveloped values and returns undefined for a missing key", async () => {
    const { kv, cache } = setup()
    kv.seed("__cache__:k", { $cacheEnvelope: 1, v: { $cache: "BigInt", v: "12" } })
    expect(await cache.get("k")).toBe(12n)
    expect(await cache.get("missing")).toBeUndefined()
    expect(await cache.has("missing")).toBe(false)
  })

  it("keeps an envelope without an expiry forever", async () => {
    const { cache } = setup()
    await cache.set("k", "v")
    vi.setSystemTime(Date.now() + 10 ** 12)
    expect(await cache.get("k")).toBe("v")
  })

  it("expires an envelope exactly at its logical expiry and best-effort deletes it", async () => {
    const { kv, cache } = setup()
    await cache.set("k", "v", 5_000)
    vi.setSystemTime(1_000_000 + 4_999)
    expect(await cache.get("k")).toBe("v")
    expect(kv.deletes).toEqual([])
    vi.setSystemTime(1_000_000 + 5_000)
    expect(await cache.get("k")).toBeUndefined()
    expect(kv.deletes).toEqual(["__cache__:k"])
  })

  it("still reports a miss when deleting the expired entry fails", async () => {
    const { kv, cache } = setup()
    await cache.set("k", "v", 1_000)
    vi.setSystemTime(1_000_000 + 1_000)
    kv.failOn = "delete"
    expect(await cache.get("k")).toBeUndefined()
    expect(await cache.has("k")).toBe(false)
  })

  it("wraps read failures with the operation and the cause", async () => {
    const { kv, cache } = setup()
    kv.failOn = "get"
    for (const [op, run] of [["get", () => cache.get("k")], ["has", () => cache.has("k")], ["delete", () => cache.delete("k")]] as const) {
      const failure = await run().catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(CacheAdapterError)
      expect((failure as CacheAdapterError).operation).toBe(`kv.${op}`)
      const cause = (failure as CacheAdapterError).cause
      // delete reads through has(), so its cause is the wrapped has failure.
      expect(op === "delete" ? (cause as CacheAdapterError).cause : cause).toBe(kv.boom)
    }
  })
})

describe("KvCacheAdapter reserved keys", () => {
  it.each(["__tag__:x", "__revision__:x", "__generation__:x", "__generation__:"])("rejects %s everywhere a caller key is accepted", async (key) => {
    const { cache } = setup()
    for (const run of [() => cache.get(key), () => cache.set(key, 1), () => cache.delete(key), () => cache.has(key), () => cache.addToTag("t", key)]) {
      const failure = await run().catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ValidationError)
      expect((failure as Error).message).toBe("Cache key collides with a reserved internal key prefix")
    }
  })

  it.each(['__generation__:"1":k', "__tag__x", "__revisionx", "_generation__:x", "plain"])("accepts %s", async (key) => {
    const { cache } = setup()
    await cache.set(key, "v")
    expect(await cache.get(key)).toBe("v")
  })

  it("lets a non-string key through to the store", async () => {
    const { kv, cache } = setup()
    kv.seed("__cache__:123", "num")
    expect(await cache.get(123 as never)).toBe("num")
  })
})

describe("KvCacheAdapter writes", () => {
  it("stores an envelope plus a revision, without options when no ttl is given", async () => {
    const { kv, cache } = setup()
    await cache.set("k", { a: 1 })
    expect(kv.puts).toHaveLength(2)
    expect(kv.puts[0]).toEqual({ key: "__cache__:k", value: JSON.stringify({ $cacheEnvelope: 1, v: { a: 1 } }), options: undefined })
    expect(kv.puts[1]?.key).toBe("__cache__:__revision__:k")
    expect(kv.puts[1]?.options).toBeUndefined()
    expect(kv.json("__cache__:__revision__:k")).toMatch(/^1000000:[0-9a-f-]{36}$/)
  })

  it.each([
    [1_500, 60],
    [60_000, 60],
    [60_001, 61],
    [120_000, 120],
    [125_001, 126],
  ])("maps ttl %i ms to expirationTtl %i s for both entries", async (ttlMs, seconds) => {
    const { kv, cache } = setup()
    await cache.set("k", 1, ttlMs)
    expect(kv.puts.map((p) => p.options)).toEqual([{ expirationTtl: seconds }, { expirationTtl: seconds }])
    expect((kv.json("__cache__:k") as { e: number }).e).toBe(1_000_000 + ttlMs)
    expect(KV_MIN_EXPIRATION_TTL_SECONDS).toBe(60)
  })

  it("validates the ttl before writing anything", async () => {
    const { kv, cache } = setup()
    await expect(cache.set("k", 1, 0)).rejects.toThrow("Cache ttlMs must be a positive safe integer")
    expect(kv.puts).toEqual([])
  })

  it("does not wrap serialization errors as adapter failures", async () => {
    const { cache } = setup()
    await expect(cache.set("k", () => 1)).rejects.not.toBeInstanceOf(CacheAdapterError)
  })

  it.each(["k", "revision"] as const)("wraps a failing %s put", async (which) => {
    const { kv, cache } = setup()
    kv.failOn = "put"
    kv.failKey = which === "k" ? "__cache__:k" : "__cache__:__revision__:k"
    const failure = await cache.set("k", 1).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CacheAdapterError)
    expect((failure as CacheAdapterError).operation).toBe("kv.set")
    expect((failure as CacheAdapterError).cause).toBe(kv.boom)
  })

  it("delete removes value and revision and reports prior existence", async () => {
    const { kv, cache } = setup()
    await cache.set("k", 1)
    expect(await cache.delete("k")).toBe(true)
    expect(kv.deletes).toEqual(["__cache__:k", "__cache__:__revision__:k"])
    expect(kv.store.size).toBe(0)
    expect(await cache.delete("k")).toBe(false)
  })

  it("wraps a failing delete", async () => {
    const { kv, cache } = setup()
    kv.failOn = "delete"
    const failure = await cache.delete("k").catch((error: unknown) => error)
    expect((failure as CacheAdapterError).operation).toBe("kv.delete")
    expect((failure as CacheAdapterError).cause).toBe(kv.boom)
  })
})

describe("KvCacheAdapter clear", () => {
  it("deletes cache-namespace keys across pages, keeping generation counters and legacy counters", async () => {
    const { kv, cache } = setup()
    kv.pageSize = 2
    kv.seed("__cache__:a", { $cacheEnvelope: 1, v: 1 })
    kv.seed("__cache__:b", { $cacheEnvelope: 1, v: 2 })
    kv.seed("__cache__:__tag__:t", ["a"])
    kv.seed("__cache__:__revision__:a", "r")
    kv.seed("__cache__:__generation__:legacyTag", "gen")
    kv.seed('__cache__:__generation__:"gen":x', { $cacheEnvelope: 1, v: 3 })
    kv.seed("__cachegen__:t", "current")
    kv.seed("other", "outside")
    await cache.clear()
    expect([...kv.store.keys()].sort()).toEqual(["__cache__:__generation__:legacyTag", "__cachegen__:t", "other"])
    expect(kv.lists).toHaveLength(3)
    expect(kv.lists[0]).toEqual({ prefix: "__cache__:" })
    expect(kv.lists[1]).toEqual({ cursor: expect.stringMatching(/^__cache__:/) as string, prefix: "__cache__:" })
  })

  it("lists once with the prefix when everything fits one page", async () => {
    const { kv, cache } = setup()
    kv.seed("__cache__:a", 1)
    await cache.clear()
    expect(kv.lists).toEqual([{ prefix: "__cache__:" }])
    expect(kv.store.size).toBe(0)
  })

  it.each(["list", "delete"] as const)("wraps a failing %s", async (op) => {
    const { kv, cache } = setup()
    kv.seed("__cache__:a", 1)
    kv.failOn = op
    const failure = await cache.clear().catch((error: unknown) => error)
    expect((failure as CacheAdapterError).operation).toBe("kv.clear")
    expect((failure as CacheAdapterError).cause).toBe(kv.boom)
  })
})

describe("KvCacheAdapter tags", () => {
  it("records tag members with the current revision and dedupes by key", async () => {
    const { kv, cache } = setup()
    await cache.set("a", 1)
    await cache.addToTag("t", "a")
    const revision = kv.json("__cache__:__revision__:a") as string
    expect(kv.json("__cache__:__tag__:t")).toEqual([{ key: "__cache__:a", revision }])
    const putsBefore = kv.puts.length
    await cache.addToTag("t", "a")
    expect(kv.puts).toHaveLength(putsBefore)
    vi.setSystemTime(1_000_500)
    await cache.set("a", 2)
    const newRevision = kv.json("__cache__:__revision__:a") as string
    expect(newRevision).not.toBe(revision)
    await cache.set("b", 1)
    await cache.addToTag("t", "b")
    await cache.addToTag("t", "a")
    expect(kv.json("__cache__:__tag__:t")).toEqual([
      { key: "__cache__:b", revision: kv.json("__cache__:__revision__:b") },
      { key: "__cache__:a", revision: newRevision },
    ])
    expect((await cache.getTagKeys("t")).sort()).toEqual(["a", "b"])
  })

  it("upgrades legacy string members and treats a missing revision as empty", async () => {
    const { kv, cache } = setup()
    kv.seed("__cache__:__tag__:t", ["old"])
    await cache.addToTag("t", "fresh")
    expect(kv.json("__cache__:__tag__:t")).toEqual([
      { key: "__cache__:old", revision: "" },
      { key: "__cache__:fresh", revision: "" },
    ])
    // The same key with the same (empty) revision is a no-op, a legacy member is matched by canonical key.
    const before = kv.puts.length
    await cache.addToTag("t", "old")
    expect(kv.puts).toHaveLength(before)
    expect((await cache.getTagKeys("t")).sort()).toEqual(["fresh", "old"])
  })

  it("keeps only the newest KV_MAX_TAG_MEMBERS members", async () => {
    const { kv, cache } = setup()
    kv.seed("__cache__:__tag__:t", Array.from({ length: KV_MAX_TAG_MEMBERS }, (_, i) => `k${i}`))
    await cache.addToTag("t", "newest")
    const members = kv.json("__cache__:__tag__:t") as Array<{ key: string }>
    expect(members).toHaveLength(KV_MAX_TAG_MEMBERS)
    expect(members[0]?.key).toBe("__cache__:k1")
    expect(members.at(-1)?.key).toBe("__cache__:newest")
  })

  it("getTagKeys returns logical keys, tolerates string members and an absent tag", async () => {
    const { kv, cache } = setup()
    expect(await cache.getTagKeys("none")).toEqual([])
    kv.seed("__cache__:__tag__:t", ["plain", { key: "__cache__:ns", revision: "r" }, { key: "bare", revision: "r" }])
    expect(await cache.getTagKeys("t")).toEqual(["plain", "ns", "bare"])
  })

  it("deleteTag removes members whose revision still matches (and their revision) and the tag list", async () => {
    const { kv, cache } = setup()
    await cache.set("same", 1)
    await cache.set("moved", 1)
    await cache.addToTag("t", "same")
    await cache.addToTag("t", "moved")
    vi.setSystemTime(1_000_900)
    await cache.set("moved", 2)
    kv.seed("__cache__:legacy", "x")
    kv.seed("__cache__:__tag__:t", [...(kv.json("__cache__:__tag__:t") as unknown[]), "legacy"])
    kv.deletes.length = 0
    await cache.deleteTag("t")
    expect(kv.store.has("__cache__:same")).toBe(false)
    expect(kv.store.has("__cache__:__revision__:same")).toBe(false)
    expect(kv.store.has("__cache__:moved")).toBe(true)
    expect(kv.store.has("__cache__:__revision__:moved")).toBe(true)
    expect(kv.store.has("__cache__:legacy")).toBe(false)
    expect(kv.store.has("__cache__:__tag__:t")).toBe(false)
    // A legacy member has no revision to remove.
    expect(kv.deletes).not.toContain("__cache__:__revision__:legacy")
    expect(kv.deletes.at(-1)).toBe("__cache__:__tag__:t")
  })

  it("deleteTag on an unknown tag still clears the tag key", async () => {
    const { kv, cache } = setup()
    await cache.deleteTag("none")
    expect(kv.deletes).toEqual(["__cache__:__tag__:none"])
  })

  it.each(["addToTag", "getTagKeys", "deleteTag"] as const)("%s wraps store failures", async (op) => {
    const { kv, cache } = setup()
    kv.seed("__cache__:__tag__:t", [{ key: "__cache__:a", revision: "r" }])
    kv.failOn = "get"
    const run = op === "addToTag" ? () => cache.addToTag("t", "a") : op === "getTagKeys" ? () => cache.getTagKeys("t") : () => cache.deleteTag("t")
    const failure = await run().catch((error: unknown) => error)
    expect((failure as CacheAdapterError).operation).toBe(`kv.${op}`)
    expect((failure as CacheAdapterError).cause).toBe(kv.boom)
  })
})

describe("KvCacheAdapter tag generations", () => {
  function digest(pair: unknown[]): string {
    return `h:${createHash("sha256").update(JSON.stringify(pair)).digest("base64url")}`
  }

  it("reports 0 when neither counter exists", async () => {
    const { kv, cache } = setup()
    expect(await cache.getTagGeneration("t")).toBe("0")
    expect(kv.puts).toEqual([])
  })

  it("advances both counters to one shared value that reads back unchanged", async () => {
    const { kv, cache } = setup()
    const generation = await cache.advanceTagGeneration("t")
    expect(generation).toMatch(/^1000000:[0-9a-f-]{36}$/)
    expect(kv.puts.map((p) => p.key)).toEqual(["__cache__:__generation__:t", "__cachegen__:t"])
    expect(kv.json("__cachegen__:t")).toBe(generation)
    expect(kv.json("__cache__:__generation__:t")).toBe(generation)
    expect(await cache.getTagGeneration("t")).toBe(generation)
    expect(await cache.advanceTagGeneration("t")).not.toBe(generation)
  })

  it("reports a fixed-size digest of the pair when the counters differ", async () => {
    const { kv, cache } = setup()
    kv.seed("__cachegen__:t", "new")
    kv.seed("__cache__:__generation__:t", "old")
    const value = await cache.getTagGeneration("t")
    expect(value).toBe(digest(["new", "old"]))
    expect(value).toHaveLength(2 + 43)
  })

  it("adopts a legacy-only counter into the current key and then reports it unchanged", async () => {
    const { kv, cache } = setup()
    kv.seed("__cache__:__generation__:t", "legacy-gen")
    expect(await cache.getTagGeneration("t")).toBe("legacy-gen")
    expect(kv.json("__cachegen__:t")).toBe("legacy-gen")
  })

  it("does not overwrite a current counter that appeared during adoption", async () => {
    const { kv, cache } = setup()
    kv.seed("__cache__:__generation__:t", "legacy-gen")
    const realGet = kv.get.bind(kv)
    let currentReads = 0
    vi.spyOn(kv, "get").mockImplementation(async (key: string, options?: { type: "json" }) => {
      if (key === "__cachegen__:t") {
        currentReads += 1
        if (currentReads === 2) kv.seed("__cachegen__:t", "raced")
      }
      return realGet(key, options)
    })
    expect(await cache.getTagGeneration("t")).toBe(digest(["raced", "legacy-gen"]))
    expect(kv.json("__cachegen__:t")).toBe("raced")
  })

  it("falls back to the pair token when adoption fails", async () => {
    const { kv, cache } = setup()
    kv.seed("__cache__:__generation__:t", "legacy-gen")
    kv.failOn = "put"
    expect(await cache.getTagGeneration("t")).toBe(digest([null, "legacy-gen"]))
  })

  it("reports the pair when only the current counter exists", async () => {
    const { kv, cache } = setup()
    kv.seed("__cachegen__:t", "cur")
    expect(await cache.getTagGeneration("t")).toBe(digest(["cur", null]))
  })

  it("ignores non-string counter values", async () => {
    const { kv, cache } = setup()
    kv.seed("__cachegen__:t", 5)
    kv.seed("__cache__:__generation__:t", { a: 1 })
    expect(await cache.getTagGeneration("t")).toBe("0")
  })

  it("wraps read and advance failures", async () => {
    const { kv, cache } = setup()
    kv.failOn = "get"
    let failure = await cache.getTagGeneration("t").catch((error: unknown) => error)
    expect((failure as CacheAdapterError).operation).toBe("kv.getTagGeneration")
    expect((failure as CacheAdapterError).cause).toBe(kv.boom)
    kv.failOn = "put"
    failure = await cache.advanceTagGeneration("t").catch((error: unknown) => error)
    expect((failure as CacheAdapterError).operation).toBe("kv.advanceTagGeneration")
    expect((failure as CacheAdapterError).cause).toBe(kv.boom)
  })

  it("advertises eventual generations with shared coherence", () => {
    expect(setup().cache.capabilities).toEqual({ tagGenerationConsistency: "eventual", coherenceScope: "shared" })
  })
})
