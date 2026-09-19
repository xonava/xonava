import { describe, expect, it, vi } from "vitest"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import { Predicate, ConfigurationError, OptimisticConcurrencyError, NotFoundError } from "core/domain"
import type { VersionedRepository } from "core/persistence"
import { createDrizzleRepository, type DrizzleSessionLike } from "adapters/drizzle-pg"
import type { DrizzleColumnMap } from "adapters/drizzle-pg"

const productTable = pgTable("products", {
  id: text("id"),
  tenantId: text("tenant_id"),
  name: text("name"),
  version: integer("version"),
  createdAt: text("created_at"),
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
        createdAt: { type: "string" },
      },
    },
    columnMap: {
      id: productTable.id,
      tenantId: productTable.tenantId,
      name: productTable.name,
      version: productTable.version,
      createdAt: productTable.createdAt,
    } satisfies DrizzleColumnMap,
  } as const
}

/**
 * Creates a mock `where()` return value that satisfies the PG DrizzleSessionLike
 * interface: `Promise<DrizzleUpdateResult> & { returning: <T>() => Promise<T[]> }`.
 */
function whereResult(rowsAffected: number, returningRows: Record<string, unknown>[]) {
  const promise = Promise.resolve({ rowCount: rowsAffected, rowsAffected })
  return Object.assign(promise, {
    returning: vi.fn(async () => returningRows),
  })
}

function selectResult(rows: Record<string, unknown>[]) {
  return {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => rows,
          orderBy: () => ({
            limit: () => ({
              offset: async () => rows,
            }),
          }),
        }),
      }),
    })),
  }
}

function updateMock(rowsAffected: number, returningRows: Record<string, unknown>[]) {
  return vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => whereResult(rowsAffected, returningRows)),
    })),
  }))
}

function deleteMock(rowsAffected: number, returningRows: Record<string, unknown>[]) {
  return vi.fn(() => ({
    where: vi.fn(() => whereResult(rowsAffected, returningRows)),
  }))
}

describe("PostgreSQL repository OCC conformance", () => {
  it.each([-1, 1.5, "1", null])("rejects invalid increment source %s before update", async (expectedVersion) => {
    const update = updateMock(1, [{ id: "product-1", version: expectedVersion }])
    const db = { ...selectResult([{ id: "product-1", version: 1 }]), update, delete: deleteMock(1, []) } as unknown as DrizzleSessionLike
    const repo = createDrizzleRepository(createBaseArgs(db))

    await expect(repo.update("product-1", { name: "Gadget" }, { optimisticConcurrency: { expectedVersion: expectedVersion as never } })).rejects.toBeInstanceOf(ConfigurationError)
    expect(update).not.toHaveBeenCalled()
  })

  it("succeeds on update with correct expectedVersion", async () => {
    const productRow = { id: "product-1", tenantId: "tenant-1", name: "Widget", version: 1, createdAt: "2026-01-01T00:00:00.000Z" }
    const updatedRow = { ...productRow, name: "Gadget", version: 2 }
    const db = {
      ...selectResult([productRow]),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => [productRow]),
        })),
      })),
      update: updateMock(1, [updatedRow]),
      delete: deleteMock(1, []),
    } as unknown as DrizzleSessionLike

    const repo = createDrizzleRepository(createBaseArgs(db))
    const result = await repo.updateOneWhere?.(
      Predicate.eq("id", "product-1"),
      { name: "Gadget" },
      { optimisticConcurrency: { expectedVersion: 1 } },
    )
    expect(result).toEqual({ updatedCount: 1 })
  })

  it("throws OptimisticConcurrencyError on update with wrong expectedVersion", async () => {
    const productRow = { id: "product-1", tenantId: "tenant-1", name: "Widget", version: 1, createdAt: "2026-01-01T00:00:00.000Z" }
    const db = {
      ...selectResult([productRow]),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => [productRow]),
        })),
      })),
      update: updateMock(0, []),
      delete: deleteMock(0, []),
    } as unknown as DrizzleSessionLike

    const repo = createDrizzleRepository(createBaseArgs(db))
    await expect(
      repo.updateOneWhere?.(
        Predicate.eq("id", "product-1"),
        { name: "Gadget" },
        { optimisticConcurrency: { expectedVersion: 99 } },
      ),
    ).rejects.toBeInstanceOf(OptimisticConcurrencyError)
  })

  it("succeeds on delete with correct expectedVersion", async () => {
    const productRow = { id: "product-1", tenantId: "tenant-1", name: "Widget", version: 1, createdAt: "2026-01-01T00:00:00.000Z" }
    const db = {
      ...selectResult([productRow]),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => [productRow]),
        })),
      })),
      update: updateMock(1, []),
      delete: deleteMock(1, [productRow]),
    } as unknown as DrizzleSessionLike

    const repo = createDrizzleRepository(createBaseArgs(db))
    await expect(
      repo.delete("product-1", { optimisticConcurrency: { expectedVersion: 1 } }),
    ).resolves.toBeUndefined()
  })

  it("throws NotFoundError on delete with wrong expectedVersion", async () => {
    const productRow = { id: "product-1", tenantId: "tenant-1", name: "Widget", version: 2, createdAt: "2026-01-01T00:00:00.000Z" }
    const db = {
      ...selectResult([productRow]),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => [productRow]),
        })),
      })),
      update: updateMock(1, []),
      delete: deleteMock(0, []),
    } as unknown as DrizzleSessionLike

    const repo = createDrizzleRepository(createBaseArgs(db))
    await expect(
      repo.delete("product-1", { optimisticConcurrency: { expectedVersion: 99 } }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it("throws ConfigurationError when supplying version field directly in update", async () => {
    const productRow = { id: "product-1", tenantId: "tenant-1", name: "Widget", version: 1, createdAt: "2026-01-01T00:00:00.000Z" }
    const db = {
      ...selectResult([productRow]),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => [productRow]),
        })),
      })),
      update: updateMock(1, [productRow]),
      delete: deleteMock(1, []),
    } as unknown as DrizzleSessionLike

    const repo = createDrizzleRepository(createBaseArgs(db)) as unknown as VersionedRepository<Record<string, unknown>>
    // PG update() rejects version field injection before touching the DB
    await expect(
      (repo.update as (...args: unknown[]) => Promise<unknown>)("product-1", { version: 5 }),
    ).rejects.toBeInstanceOf(ConfigurationError)
  })

  it("rejects version field injection in where-based updates", async () => {
    const productRow = { id: "product-1", tenantId: "tenant-1", name: "Widget", version: 1, createdAt: "2026-01-01T00:00:00.000Z" }
    const db = {
      ...selectResult([productRow]),
      update: updateMock(1, [productRow]),
    } as unknown as DrizzleSessionLike
    const repo = createDrizzleRepository(createBaseArgs(db)) as unknown as VersionedRepository<Record<string, unknown>>

    await expect((repo.updateOneWhere as (...args: unknown[]) => Promise<unknown>)?.(Predicate.eq("id", "product-1"), { version: 5 })).rejects.toBeInstanceOf(ConfigurationError)
    await expect((repo.updateOneWhereReturning as (...args: unknown[]) => Promise<unknown>)(Predicate.eq("id", "product-1"), { version: 5 })).rejects.toBeInstanceOf(ConfigurationError)
  })

  it("throws ConfigurationError when optimisticConcurrency requested on entity without versionField", async () => {
    const tableWithoutVersion = pgTable("simple_entities", {
      id: text("id"),
      name: text("name"),
    })
    const simpleRow = { id: "entity-1", name: "Widget" }
    const db = {
      ...selectResult([simpleRow]),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => [simpleRow]),
        })),
      })),
      update: updateMock(1, [simpleRow]),
      delete: deleteMock(1, []),
    } as unknown as DrizzleSessionLike

    const repo = createDrizzleRepository({
      db,
      table: tableWithoutVersion,
      entity: {
        name: "simpleEntity",
        primaryKey: "id",
        fields: { id: { type: "string" }, name: { type: "string" } },
      },
      columnMap: {
        id: tableWithoutVersion.id,
        name: tableWithoutVersion.name,
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
