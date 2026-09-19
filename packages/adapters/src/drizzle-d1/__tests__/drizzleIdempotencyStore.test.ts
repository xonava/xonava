import { describe, expect, it, vi } from "vitest"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { DrizzleD1IdempotencyStore } from "../drizzleIdempotencyStore"
import type { DrizzleSessionLike } from "../drizzleRepository"

const idempotencyTable = sqliteTable("idempotency_records", {
  id: text("id").primaryKey(),
  scope: text("scope"),
  key: text("key"),
  fingerprint: text("fingerprint"),
  token: text("token"),
  status: text("status"),
  result: text("result"),
  resourceEntity: text("resource_entity"),
  resourceId: text("resource_id"),
  pendingInvalidations: text("pending_invalidations"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
})

function createMockDb() {
  const insertResult = { meta: { changes: 0 } }
  const selectResult: unknown[] = []
  const updateResult = { meta: { changes: 0 } }

  const db = {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(async () => insertResult),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => selectResult),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => updateResult),
      })),
    })),
  }

  return { db, insertResult, selectResult, updateResult }
}

describe("DrizzleD1IdempotencyStore", () => {
  describe("acquire", () => {
    it("returns 'acquired' when insert succeeds (no conflict)", async () => {
      const { db, insertResult } = createMockDb()
      insertResult.meta.changes = 1
      const store = new DrizzleD1IdempotencyStore(db as unknown as DrizzleSessionLike, idempotencyTable)

      const result = await store.acquire({
        scope: "tenant:one",
        key: "key-1",
        fingerprint: "f",
        leaseDurationMs: 30_000,
      })

      expect(result.outcome).toBe("acquired")
      expect(result).toHaveProperty("token")
      expect(typeof (result as { token: string }).token).toBe("string")
    })

    it("returns 'conflict' when fingerprint differs", async () => {
      const { db, selectResult } = createMockDb()
      selectResult.push({ scope: "tenant:one", key: "key-1", fingerprint: "other-f", status: "in-progress", result: null, token: "old-token" })
      const store = new DrizzleD1IdempotencyStore(db as unknown as DrizzleSessionLike, idempotencyTable)

      const result = await store.acquire({
        scope: "tenant:one",
        key: "key-1",
        fingerprint: "f",
        leaseDurationMs: 30_000,
      })

      expect(result.outcome).toBe("conflict")
    })

    it("returns 'replay' when completed with a result", async () => {
      const { db, selectResult } = createMockDb()
      selectResult.push({
        scope: "tenant:one", key: "key-1", fingerprint: "f", status: "completed",
        result: JSON.stringify({ id: "created" }), token: "token", pendingInvalidations: null,
      })
      const store = new DrizzleD1IdempotencyStore(db as unknown as DrizzleSessionLike, idempotencyTable)

      const result = await store.acquire({
        scope: "tenant:one",
        key: "key-1",
        fingerprint: "f",
        leaseDurationMs: 30_000,
      })

      expect(result.outcome).toBe("replay")
      expect((result as { result: unknown }).result).toEqual({ id: "created" })
    })

    it("returns 'business-committed' when status is business-committed", async () => {
      const { db, selectResult } = createMockDb()
      selectResult.push({
        scope: "tenant:one", key: "key-1", fingerprint: "f", status: "business-committed",
        result: null, token: "token", pendingInvalidations: JSON.stringify(["tag-a"]),
        resourceEntity: "row", resourceId: "row-1",
      })
      const store = new DrizzleD1IdempotencyStore(db as unknown as DrizzleSessionLike, idempotencyTable)

      const result = await store.acquire({
        scope: "tenant:one",
        key: "key-1",
        fingerprint: "f",
        leaseDurationMs: 30_000,
      })

      expect(result.outcome).toBe("business-committed")
      expect((result as { resource: { entity: string; id: string } }).resource).toEqual({ entity: "row", id: "row-1" })
    })

    it("returns the numeric resource version from the typed envelope on business-committed rows", async () => {
      const { db, selectResult } = createMockDb()
      selectResult.push({
        scope: "tenant:one", key: "key-1", fingerprint: "f", status: "business-committed",
        result: null, token: "token", pendingInvalidations: null,
        resourceEntity: "row", resourceId: "row-1",
        resourceVersion: JSON.stringify({ type: "number", value: 2 }),
      })
      const store = new DrizzleD1IdempotencyStore(db as unknown as DrizzleSessionLike, idempotencyTable)

      const result = await store.acquire({
        scope: "tenant:one",
        key: "key-1",
        fingerprint: "f",
        leaseDurationMs: 30_000,
      })

      expect(result.outcome).toBe("business-committed")
      expect((result as { resource: { entity: string; id: string; version: string | number } }).resource)
        .toEqual({ entity: "row", id: "row-1", version: 2 })
    })

    it("rejects a bare string resource version instead of coercing it", async () => {
      const { db, selectResult } = createMockDb()
      selectResult.push({
        scope: "tenant:one", key: "key-1", fingerprint: "f", status: "business-committed",
        result: null, token: "token", pendingInvalidations: null,
        resourceEntity: "row", resourceId: "row-1",
        resourceVersion: "2",
      })
      const store = new DrizzleD1IdempotencyStore(db as unknown as DrizzleSessionLike, idempotencyTable)

      await expect(store.acquire({
        scope: "tenant:one",
        key: "key-1",
        fingerprint: "f",
        leaseDurationMs: 30_000,
      })).rejects.toThrow("expected numeric envelope")
    })

    it("takes over an expired lease with a new token", async () => {
      const { db, selectResult, updateResult } = createMockDb()
      selectResult.push({
        scope: "tenant:one", key: "key-1", fingerprint: "f", status: "in-progress",
        result: null, token: "expired-token",
      })
      updateResult.meta.changes = 1
      const store = new DrizzleD1IdempotencyStore(db as unknown as DrizzleSessionLike, idempotencyTable)

      const result = await store.acquire({
        scope: "tenant:one",
        key: "key-1",
        fingerprint: "f",
        leaseDurationMs: 30_000,
      })

      expect(result.outcome).toBe("acquired")
      expect((result as { token: string }).token).not.toBe("expired-token")
    })
  })

  describe("complete", () => {
    it("succeeds on business-committed row", async () => {
      const { db, updateResult } = createMockDb()
      updateResult.meta.changes = 1
      const store = new DrizzleD1IdempotencyStore(db as unknown as DrizzleSessionLike, idempotencyTable)

      await expect(store.complete({
        scope: "tenant:one",
        key: "key-1",
        fingerprint: "f",
        token: "token-1",
        result: { id: "created" },
      })).resolves.toBeUndefined()
    })

    it("throws when token does not match", async () => {
      const { db, updateResult } = createMockDb()
      updateResult.meta.changes = 0
      const store = new DrizzleD1IdempotencyStore(db as unknown as DrizzleSessionLike, idempotencyTable)

      await expect(store.complete({
        scope: "tenant:one",
        key: "key-1",
        fingerprint: "f",
        token: "wrong-token",
        result: { id: "created" },
      })).rejects.toThrow("lost ownership")
    })
  })

  describe("renew", () => {
    it("succeeds on in-progress row with matching token", async () => {
      const { db, updateResult } = createMockDb()
      updateResult.meta.changes = 1
      const store = new DrizzleD1IdempotencyStore(db as unknown as DrizzleSessionLike, idempotencyTable)

      await expect(store.renew({
        scope: "tenant:one",
        key: "key-1",
        fingerprint: "f",
        token: "token-1",
      })).resolves.toBeUndefined()
    })

    it("throws when token does not match", async () => {
      const { db, updateResult } = createMockDb()
      updateResult.meta.changes = 0
      const store = new DrizzleD1IdempotencyStore(db as unknown as DrizzleSessionLike, idempotencyTable)

      await expect(store.renew({
        scope: "tenant:one",
        key: "key-1",
        fingerprint: "f",
        token: "wrong-token",
      })).rejects.toThrow("lease renewal lost ownership")
    })
  })

  describe("lease duration validation", () => {
    it("rejects zero duration", async () => {
      const { db } = createMockDb()
      const store = new DrizzleD1IdempotencyStore(db as unknown as DrizzleSessionLike, idempotencyTable)

      await expect(store.acquire({
        scope: "tenant:one",
        key: "key-1",
        fingerprint: "f",
        leaseDurationMs: 0,
      })).rejects.toThrow("finite and within")
    })

    it("rejects negative duration", async () => {
      const { db } = createMockDb()
      const store = new DrizzleD1IdempotencyStore(db as unknown as DrizzleSessionLike, idempotencyTable)

      await expect(store.acquire({
        scope: "tenant:one",
        key: "key-1",
        fingerprint: "f",
        leaseDurationMs: -1000,
      })).rejects.toThrow("finite and within")
    })

    it("rejects duration exceeding 24 hours", async () => {
      const { db } = createMockDb()
      const store = new DrizzleD1IdempotencyStore(db as unknown as DrizzleSessionLike, idempotencyTable)

      await expect(store.acquire({
        scope: "tenant:one",
        key: "key-1",
        fingerprint: "f",
        leaseDurationMs: 24 * 60 * 60 * 1000 + 1,
      })).rejects.toThrow("finite and within")
    })

    it("accepts default duration when not specified", async () => {
      const { db, insertResult } = createMockDb()
      insertResult.meta.changes = 1
      const store = new DrizzleD1IdempotencyStore(db as unknown as DrizzleSessionLike, idempotencyTable)

      await expect(store.acquire({
        scope: "tenant:one",
        key: "key-1",
        fingerprint: "f",
      })).resolves.toHaveProperty("outcome", "acquired")
    })
  })
})
