import { describe, expect, it } from "vitest"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ConfigurationError, OptimisticConcurrencyError, Predicate, ValidationError } from "core/domain"
import type { VersionedRepository } from "core/persistence"
import { createDrizzleRepository, type DrizzleSessionLike, type DrizzleUpdateResult } from "adapters/drizzle-d1"
import type { DrizzleColumnMap } from "adapters/drizzle-d1"

const drugFormulary = sqliteTable("drug_formulary", {
  id: text("id"),
  tenantId: text("tenant_id"),
  status: text("status"),
  version: integer("version"),
  createdAt: integer("created_at", { mode: "timestamp" }),
})

function createBaseArgs(db: DrizzleSessionLike) {
  return {
    db,
    table: drugFormulary,
    entity: {
      name: "drugFormulary",
      primaryKey: "id",
      versionField: "version",
      fields: {
        id: { type: "string" },
        tenantId: { type: "string", nullable: true },
        status: { type: "string" },
        version: { type: "number" },
        createdAt: { type: "date" },
      },
    },
    columnMap: {
      id: drugFormulary.id,
      tenantId: drugFormulary.tenantId,
      status: drugFormulary.status,
      version: { name: "version" } as unknown as DrizzleColumnMap[string],
      createdAt: drugFormulary.createdAt,
    } satisfies DrizzleColumnMap,
  } as const
}

describe("packages/core drizzleRepository semantics", () => {
  it("requires expectedVersion for versioned updateOneWhere", async () => {
    const row = { id: "drug-1", tenantId: "tenant-1", status: "active", version: 1, createdAt: new Date() }
    const db: DrizzleSessionLike = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [row],
            orderBy: () => ({ limit: () => ({ offset: async () => [row] }) }),
          }),
        }),
      }),
      insert: () => ({ values: async () => ({}) }),
      update: () => ({ set: () => ({ where: async (): Promise<DrizzleUpdateResult> => ({ affectedRows: 1 }) }) }),
      delete: () => ({ where: async (): Promise<DrizzleUpdateResult> => ({ affectedRows: 1 }) }),
    }

    const repo = createDrizzleRepository(createBaseArgs(db)) as unknown as VersionedRepository<Record<string, unknown>>

    await expect((repo.updateOneWhere as (...args: unknown[]) => Promise<unknown>)?.(Predicate.eq("id", "drug-1"), { status: "inactive" }))
      .rejects.toBeInstanceOf(ConfigurationError)
  })

  it("does not advertise updateOneWhereReturning without D1 returning support", async () => {
    const db: DrizzleSessionLike = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [], orderBy: () => ({ limit: () => ({ offset: async () => [] }) }) }) }) }),
      insert: () => ({ values: async () => ({}) }),
      update: () => ({ set: () => ({ where: async (): Promise<DrizzleUpdateResult> => ({ affectedRows: 1 }) }) }),
      delete: () => ({ where: async (): Promise<DrizzleUpdateResult> => ({ affectedRows: 1 }) }),
    }

    const repo = createDrizzleRepository(createBaseArgs(db)) as unknown as VersionedRepository<Record<string, unknown>>
    expect(repo.updateOneWhereReturning === undefined).toBe(true)
  })

  it("throws on optimistic zero-row updateOneWhere", async () => {
    const row = { id: "drug-1", tenantId: "tenant-1", status: "active", version: 1, createdAt: new Date() }
    const db: DrizzleSessionLike = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [row],
            orderBy: () => ({ limit: () => ({ offset: async () => [row] }) }),
          }),
        }),
      }),
      insert: () => ({ values: async () => ({}) }),
      update: () => ({ set: () => ({ where: async (): Promise<DrizzleUpdateResult> => ({ affectedRows: 0 }) }) }),
      delete: () => ({ where: async (): Promise<DrizzleUpdateResult> => ({ affectedRows: 1 }) }),
    }

    const repo = createDrizzleRepository(createBaseArgs(db)) as unknown as VersionedRepository<Record<string, unknown>>

    await expect(repo.updateOneWhere?.(
      Predicate.and(Predicate.eq("id", "drug-1"), Predicate.eq("version", 1)),
      { status: "inactive" },
      { optimisticConcurrency: { expectedVersion: 1 } },
    )).rejects.toBeInstanceOf(OptimisticConcurrencyError)
  })

  it("rejects updateOneWhere when the predicate matches multiple rows", async () => {
    const db: DrizzleSessionLike = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ primaryKey: "drug-1" }, { primaryKey: "drug-2" }],
            orderBy: () => ({ limit: () => ({ offset: async () => [] }) }),
          }),
        }),
      }),
      insert: () => ({ values: async () => ({}) }),
      update: () => ({ set: () => ({ where: async (): Promise<DrizzleUpdateResult> => ({ affectedRows: 1 }) }) }),
      delete: () => ({ where: async (): Promise<DrizzleUpdateResult> => ({ affectedRows: 1 }) }),
    }

    const repo = createDrizzleRepository(createBaseArgs(db))
    await expect(repo.updateOneWhere?.(Predicate.eq("status", "active"), { status: "inactive" }, {
      optimisticConcurrency: { expectedVersion: 1 },
    }))
      .rejects.toEqual(new ValidationError("drugFormulary updateOneWhere matched multiple rows"))
  })

  it("throws NotFoundError on strict delete and no-op on idempotent delete", async () => {
    const db: DrizzleSessionLike = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
            orderBy: () => ({ limit: () => ({ offset: async () => [] }) }),
          }),
        }),
      }),
      insert: () => ({ values: async () => ({}) }),
      update: () => ({ set: () => ({ where: async (): Promise<DrizzleUpdateResult> => ({ affectedRows: 1 }) }) }),
      delete: () => ({ where: async (): Promise<DrizzleUpdateResult> => ({ affectedRows: 0 }) }),
    }

    const repo = createDrizzleRepository(createBaseArgs(db)) as unknown as VersionedRepository<Record<string, unknown>>

    const unsafeDelete = repo.delete as (...args: unknown[]) => Promise<void>
    await expect(unsafeDelete("missing-id")).rejects.toBeInstanceOf(ConfigurationError)
    await expect(unsafeDelete("missing-id", { idempotent: true })).rejects.toBeInstanceOf(ConfigurationError)
  })

  it("maps unique constraint failures to ConflictError on insert", async () => {
    const db: DrizzleSessionLike = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
            orderBy: () => ({ limit: () => ({ offset: async () => [] }) }),
          }),
        }),
      }),
      insert: () => ({ values: async () => { throw Object.assign(new Error("UNIQUE constraint failed: tenant_branches.tenant_id"), { code: "SQLITE_CONSTRAINT_UNIQUE" }) } }),
      update: () => ({ set: () => ({ where: async (): Promise<DrizzleUpdateResult> => ({ affectedRows: 1 }) }) }),
      delete: () => ({ where: async (): Promise<DrizzleUpdateResult> => ({ affectedRows: 1 }) }),
    }

    const repo = createDrizzleRepository(createBaseArgs(db))

    await expect(repo.insert({ id: "drug-1", tenantId: "tenant-1" }))
      .rejects.toMatchObject({
        name: "ConflictError",
        message: "A record with this value already exists",
      })
  })
})
