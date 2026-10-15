import { describe, expect, it, vi } from "vitest"
import { integer, sqliteTable, SQLiteSyncDialect, text } from "drizzle-orm/sqlite-core"
import type { SQL } from "drizzle-orm"
import type { CacheAdapter } from "@xonava/core/cache"
import { CacheService } from "@xonava/core/cache"
import { InMemoryCacheAdapter } from "../inMemoryCacheAdapter"
import { SharedGenerationCacheAdapter } from "../sharedGenerationCacheAdapter"
import { createDbTagGenerationStore, type AnyDrizzleDatabase, type TagGenerationStore } from "../dbTagGenerationStore"

function createFakeGenerationStore(): { store: TagGenerationStore; generations: Map<string, string> } {
  const generations = new Map<string, string>()
  const store: TagGenerationStore = {
    getTagGeneration: vi.fn(async (tag: string) => generations.get(tag) ?? "0"),
    advanceTagGeneration: vi.fn(async (tag: string) => {
      const next = String(Number(generations.get(tag) ?? "0") + 1)
      generations.set(tag, next)
      return next
    }),
  }
  return { store, generations }
}

describe("SharedGenerationCacheAdapter", () => {
  it("composes a payload adapter with a shared generation store", async () => {
    const payload = new InMemoryCacheAdapter()
    const { store } = createFakeGenerationStore()
    const adapter = new SharedGenerationCacheAdapter({ payload, generations: store })

    await adapter.set("key", { value: 1 })
    await expect(adapter.get<{ value: number }>("key")).resolves.toEqual({ value: 1 })
    await adapter.addToTag("rows", "key")
    expect(await adapter.getTagKeys("rows")).toEqual(["key"])
    await adapter.deleteTag("rows")
    await expect(adapter.has("key")).resolves.toBe(false)
    await adapter.clear()

    expect(adapter.capabilities).toEqual({ tagGenerationConsistency: "linearizable", coherenceScope: "shared" })
    await expect(adapter.getTagGeneration("rows")).resolves.toBe("0")
    await expect(adapter.advanceTagGeneration("rows")).resolves.toBe("1")
    expect(store.getTagGeneration).toHaveBeenCalledWith("rows")
    expect(store.advanceTagGeneration).toHaveBeenCalledWith("rows")
  })

  it("fences correctness-critical reads and invalidations through the shared store", async () => {
    const payload = new InMemoryCacheAdapter()
    const { store } = createFakeGenerationStore()
    const adapter = new SharedGenerationCacheAdapter({ payload, generations: store })
    const cache = new CacheService({ adapter, correctnessCritical: true })

    await expect(cache.getOrSet("key", async () => "fresh", ["rows"])).resolves.toBe("fresh")
    await cache.invalidateTag("rows")
    await expect(cache.getOrSet("key", async () => "fresh-after-invalidate", ["rows"])).resolves.toBe("fresh-after-invalidate")
    expect(store.getTagGeneration).toHaveBeenCalled()
    expect(store.advanceTagGeneration).toHaveBeenCalledWith("rows")
  })

  it("does not resurrect a resolver result after a shared invalidation", async () => {
    const payload = new InMemoryCacheAdapter()
    const { store, generations } = createFakeGenerationStore()
    const adapter = new SharedGenerationCacheAdapter({ payload, generations: store })
    const cache = new CacheService({ adapter, correctnessCritical: true })

    let resolve!: (value: string) => void
    const stale = cache.getOrSet("key", () => new Promise<string>((done) => { resolve = done }), ["rows"])
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await cache.invalidateTag("rows")
    resolve("stale")
    await expect(stale).resolves.toBe("stale")
    expect(generations.get("rows")).toBe("1")

    const fresh = cache.getOrSet("key", async () => "fresh", ["rows"])
    await expect(fresh).resolves.toBe("fresh")
    expect(generations.get("rows")).toBe("1")
  })

  it("does not expose rate-limit primitives through the cache composition", () => {
    const withPrimitive = new SharedGenerationCacheAdapter({
      payload: new InMemoryCacheAdapter(),
      generations: createFakeGenerationStore().store,
    })
    expect("incrementRateLimitAtomically" in withPrimitive).toBe(false)

    const payloadWithout: CacheAdapter = {
      get: async () => undefined,
      set: async () => undefined,
      delete: async () => true,
      has: async () => false,
      clear: async () => undefined,
      addToTag: async () => undefined,
      getTagKeys: async () => [],
      deleteTag: async () => undefined,
    }
    const withoutPrimitive = new SharedGenerationCacheAdapter({
      payload: payloadWithout,
      generations: createFakeGenerationStore().store,
    })
    expect("incrementRateLimitAtomically" in withoutPrimitive).toBe(false)
  })
})

describe("DbTagGenerationStore", () => {
  const generationTable = sqliteTable("tag_generations", {
    tag: text("tag").primaryKey(),
    generation: integer("generation").notNull(),
  })

  it("returns 0 when a tag has never been advanced", async () => {
    const select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => []),
        })),
      })),
    }))
    const db = { select } as unknown as AnyDrizzleDatabase
    const store = createDbTagGenerationStore({ db, table: generationTable })

    await expect(store.getTagGeneration("rows")).resolves.toBe("0")
    expect(select).toHaveBeenCalled()
  })

  it("reads the stored generation for an existing tag", async () => {
    const where = vi.fn(() => ({ limit: vi.fn(async () => [{ generation: 7 }]) }))
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })),
    } as unknown as AnyDrizzleDatabase
    const store = createDbTagGenerationStore({ db, table: generationTable })

    await expect(store.getTagGeneration("rows")).resolves.toBe("7")
  })

  it("advances the generation with a single atomic upsert statement", async () => {
    const inserted: {
      data: unknown
      options: { target?: unknown; set?: { generation?: SQL } } | undefined
    } = { data: undefined, options: undefined }
    const insert = vi.fn(() => ({
      values: vi.fn((data: unknown) => {
        inserted.data = data
        return {
          onConflictDoUpdate: vi.fn((options: unknown) => {
            inserted.options = options as { target?: unknown; set?: { generation?: SQL } }
            return { returning: vi.fn(async () => [{ generation: 4 }]) }
          }),
        }
      }),
    }))
    const db = { insert } as unknown as AnyDrizzleDatabase
    const store = createDbTagGenerationStore({ db, table: generationTable })

    await expect(store.advanceTagGeneration("rows")).resolves.toBe("4")
    expect(inserted.data).toEqual({ tag: "rows", generation: 1 })
    const setExpression = inserted.options?.set?.generation
    expect(setExpression).toBeDefined()
    if (setExpression) {
      expect(new SQLiteSyncDialect().sqlToQuery(setExpression).sql).toContain('"generation" + 1')
    }
    expect(inserted.options?.target).toBe(generationTable.tag)
  })

  it("throws when the store does not return the incremented generation", async () => {
    const insert = vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn(() => ({ returning: vi.fn(async () => []) })),
      })),
    }))
    const db = { insert } as unknown as AnyDrizzleDatabase
    const store = createDbTagGenerationStore({ db, table: generationTable })

    await expect(store.advanceTagGeneration("rows")).rejects.toMatchObject({ name: "CacheAdapterError" })
  })
})
