import { describe, expect, it } from "vitest"
import type { CacheAdapter } from "@xonava/core/cache"

export interface CacheAdapterContractOptions {
  createAdapter: () => CacheAdapter
}

/** Runs storage, replacement, deletion, and tag invalidation checks for a cache adapter. */
export function runCacheAdapterContractTests(
  label: string,
  options: CacheAdapterContractOptions,
): void {
  describe(`Cache adapter contract: ${label}`, { concurrent: false }, () => {
    it("stores, reads, detects, replaces, and deletes values", async () => {
      const cache = options.createAdapter()
      await cache.set("contract:key", { value: 1 })
      expect(await cache.has("contract:key")).toBe(true)
      expect(await cache.get<{ value: number }>("contract:key")).toEqual({ value: 1 })

      await cache.set("contract:key", { value: 2 })
      expect(await cache.get<{ value: number }>("contract:key")).toEqual({ value: 2 })
      expect(await cache.delete("contract:key")).toBe(true)
      expect(await cache.get("contract:key")).toBeUndefined()
      expect(await cache.delete("contract:key")).toBe(false)
    })

    it("invalidates every value associated with a tag", async () => {
      const cache = options.createAdapter()
      await cache.set("contract:a", "a")
      await cache.set("contract:b", "b")
      await cache.addToTag("contract:rows", "contract:a")
      await cache.addToTag("contract:rows", "contract:b")
      await cache.addToTag("contract:rows", "contract:a")

      expect((await cache.getTagKeys("contract:rows")).sort()).toEqual(["contract:a", "contract:b"])
      await cache.deleteTag("contract:rows")
      expect(await cache.get("contract:a")).toBeUndefined()
      expect(await cache.get("contract:b")).toBeUndefined()
      expect(await cache.getTagKeys("contract:rows")).toEqual([])
    })

    it("clears values and tag indexes", async () => {
      const cache = options.createAdapter()
      await cache.set("contract:clear", true)
      await cache.addToTag("contract:clear-tag", "contract:clear")
      await cache.clear()
      expect(await cache.has("contract:clear")).toBe(false)
      expect(await cache.getTagKeys("contract:clear-tag")).toEqual([])
    })
  })
}
