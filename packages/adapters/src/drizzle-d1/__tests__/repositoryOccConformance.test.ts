import { describe, expect, it, vi } from "vitest"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Predicate, ConfigurationError, OptimisticConcurrencyError, NotFoundError } from "core/domain"
import type { VersionedRepository } from "core/persistence"
import { createDrizzleRepository, type DrizzleSessionLike, type DrizzleUpdateResult } from "adapters/drizzle-d1"
import type { DrizzleColumnMap } from "adapters/drizzle-d1"

const productTable = sqliteTable("products", {
  id: text("id"),
  tenantId: text("tenant_id"),
  name: text("name"),
  version: integer("version"),
  createdAt: integer("created_at", { mode: "timestamp" }),
})

function createBaseArgs(db: DrizzleSessionLike) {
  return {
    db,
    table: productTable,
    entity: {
      name: "product",
      primaryKey: "id",
      versionField: "version",
      fields: {
        id: { type: "string" },
        tenantId: { type: "string", nullable: true },
        name: { type: "string" },
        version: { type: "number" },
        createdAt: { type: "date" },
      },
    },
    columnMap: {
      id: productTable.id,
      tenantId: productTable.tenantId,
      name: productTable.name,
      version: { name: "version" } as unknown as DrizzleColumnMap[string],
      createdAt: productTable.createdAt,
    } satisfies DrizzleColumnMap,
  } as const
}

function createMockDb(opts: { affectedRows?: number } = {}) {
  const productRow = { id: "product-1", tenantId: "tenant-1", name: "Widget", version: 1, createdAt: new Date() }
  return {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => [productRow],
          orderBy: () => ({
            limit: () => ({
              offset: async () => [productRow],
            }),
          }),
        }),
      }),
    })),
    insert: () => ({ values: async () => ({}) }),
    update: () => ({
      set: () => ({
        where: async (): Promise<DrizzleUpdateResult> => ({
          affectedRows: opts.affectedRows ?? 1,
        }),
      }),
    }),
    delete: () => ({
      where: async (): Promise<DrizzleUpdateResult> => ({
        affectedRows: opts.affectedRows ?? 1,
      }),
    }),
  } as unknown as DrizzleSessionLike
}

describe("D1 repository OCC conformance", () => {
  it.each([Number.MAX_SAFE_INTEGER, -1, 1.5, "1", null])("rejects invalid increment source %s before update", async (expectedVersion) => {
    const update = vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => ({ affectedRows: 1 })) })) }))
    const db = { ...createMockDb(), update } as unknown as DrizzleSessionLike
    const repo = createDrizzleRepository(createBaseArgs(db))

    await expect(repo.update("product-1", { name: "Gadget" }, { optimisticConcurrency: { expectedVersion: expectedVersion as never } })).rejects.toBeInstanceOf(ConfigurationError)
    expect(update).not.toHaveBeenCalled()
  })

  it("succeeds on updateOneWhere with correct expectedVersion", async () => {
    const productRow = { id: "product-1", tenantId: "tenant-1", name: "Widget", version: 1, createdAt: new Date() }
    const db: DrizzleSessionLike = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [productRow],
            orderBy: () => ({
              limit: () => ({
                offset: async () => [productRow],
              }),
            }),
          }),
        }),
      }),
      insert: () => ({ values: async () => ({}) }),
      update: () => ({ set: () => ({ where: async (): Promise<DrizzleUpdateResult> => ({ affectedRows: 1 }) }) }),
      delete: () => ({ where: async (): Promise<DrizzleUpdateResult> => ({ affectedRows: 1 }) }),
    }

    const repo = createDrizzleRepository(createBaseArgs(db)) as unknown as VersionedRepository<Record<string, unknown>>
    const result = await repo.updateOneWhere?.(
      Predicate.eq("id", "product-1"),
      { name: "Gadget" },
      { optimisticConcurrency: { expectedVersion: 1 } },
    )
    expect(result).toEqual({ updatedCount: 1 })
  })

  it("throws OptimisticConcurrencyError on updateOneWhere with wrong expectedVersion", async () => {
    const productRow = { id: "product-1", tenantId: "tenant-1", name: "Widget", version: 1, createdAt: new Date() }
    const db: DrizzleSessionLike = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [productRow],
            orderBy: () => ({
              limit: () => ({
                offset: async () => [productRow],
              }),
            }),
          }),
        }),
      }),
      insert: () => ({ values: async () => ({}) }),
      update: () => ({ set: () => ({ where: async (): Promise<DrizzleUpdateResult> => ({ affectedRows: 0 }) }) }),
      delete: () => ({ where: async (): Promise<DrizzleUpdateResult> => ({ affectedRows: 0 }) }),
    }

    const repo = createDrizzleRepository(createBaseArgs(db)) as unknown as VersionedRepository<Record<string, unknown>>
    await expect(
      repo.updateOneWhere?.(
        Predicate.eq("id", "product-1"),
        { name: "Gadget" },
        { optimisticConcurrency: { expectedVersion: 99 } },
      ),
    ).rejects.toBeInstanceOf(OptimisticConcurrencyError)
  })

  it("succeeds on delete with correct expectedVersion", async () => {
    const db = createMockDb({ affectedRows: 1 })
    const repo = createDrizzleRepository(createBaseArgs(db)) as unknown as VersionedRepository<Record<string, unknown>>

    await expect(
      repo.delete("product-1", { optimisticConcurrency: { expectedVersion: 1 } }),
    ).resolves.toBeUndefined()
  })

  it("allows deleting a row at the maximum safe entity version", async () => {
    const deleteWhere = vi.fn(async (): Promise<DrizzleUpdateResult> => ({ affectedRows: 1 }))
    const db = { ...createMockDb(), delete: vi.fn(() => ({ where: deleteWhere })) } as unknown as DrizzleSessionLike
    const repo = createDrizzleRepository(createBaseArgs(db)) as unknown as VersionedRepository<Record<string, unknown>>

    await expect(
      repo.delete("product-1", { optimisticConcurrency: { expectedVersion: Number.MAX_SAFE_INTEGER } }),
    ).resolves.toBeUndefined()
    expect(deleteWhere).toHaveBeenCalledOnce()
  })

  it("throws NotFoundError on delete with wrong expectedVersion", async () => {
    const db = createMockDb({ affectedRows: 0 })
    const repo = createDrizzleRepository(createBaseArgs(db))

    await expect(
      repo.delete("product-1", { optimisticConcurrency: { expectedVersion: 99 } }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it("throws ConfigurationError when supplying version field directly in updateOneWhere", async () => {
    const db = createMockDb({ affectedRows: 1 })
    const repo = createDrizzleRepository(createBaseArgs(db)) as unknown as VersionedRepository<Record<string, unknown>>

    await expect(
      (repo.updateOneWhere as (...args: unknown[]) => Promise<unknown>)?.(Predicate.eq("id", "product-1"), { version: 5 }),
    ).rejects.toBeInstanceOf(ConfigurationError)
  })

  it("throws ConfigurationError when optimisticConcurrency requested on entity without versionField", async () => {
    const simpleTable = sqliteTable("simple_entities", {
      id: text("id"),
      name: text("name"),
    })
    const db = createMockDb({ affectedRows: 1 })
    const repo = createDrizzleRepository({
      db,
      table: simpleTable,
      entity: {
        name: "simpleEntity",
        primaryKey: "id",
        fields: { id: { type: "string" }, name: { type: "string" } },
      },
      columnMap: {
        id: simpleTable.id,
        name: simpleTable.name,
      } satisfies DrizzleColumnMap,
    })

    await expect(
      repo.updateOneWhere?.(
        Predicate.eq("id", "entity-1"),
        { name: "updated" },
        { optimisticConcurrency: { expectedVersion: 1 } },
      ),
    ).rejects.toBeInstanceOf(ConfigurationError)
  })
})
