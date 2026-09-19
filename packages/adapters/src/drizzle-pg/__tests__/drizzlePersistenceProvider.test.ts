import { pgTable, text, integer } from "drizzle-orm/pg-core"
import { PgDialect } from "drizzle-orm/pg-core/dialect"
import type { SQL } from "drizzle-orm/sql/sql"
import { describe, expect, it, vi } from "vitest"
import { ConfigurationError, Predicate, OptimisticConcurrencyError, RetryablePersistenceError } from "core/domain"
import { internalRepositoryForDescriptor } from "../../repository/dynamicRepository"
import type { AuditRecord } from "core/events"
import type { EntityDescriptor, InteractiveTransactionProvider, VersionedEntityDescriptor } from "core/persistence"
import { createDrizzlePersistenceProvider, DrizzleEntityRegistry, getDrizzleSession } from "adapters/drizzle-pg"
import { createDrizzleRepository } from "adapters/drizzle-pg"
import { createPgSession, createDrizzleAuditSinkFactory, type DrizzleSessionLike, type PgDatabaseLike } from "adapters/drizzle-pg"
import { defineEntity } from "core/entity"

const table = pgTable("test_rows", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  version: integer("version").notNull(),
})

interface TestRow {
  id: string
  name: string
  version: number
}

const entity: EntityDescriptor<TestRow> = {
  name: "test",
  primaryKey: "id",
  versionField: "version",
  fields: {
    id: { type: "string" },
    name: { type: "string" },
    version: { type: "number" },
  },
}

const columnMap = { id: table.id, name: table.name, version: table.version }

function returningPromise<T>(rows: T[]): Promise<T[]> & { returning: <R>() => Promise<R[]> } {
  const promise = Promise.resolve(rows) as Promise<T[]> & { returning: <R>() => Promise<R[]> }
  promise.returning = async <R>() => rows as unknown as R[]
  return promise
}

interface TestDatabase {
  select: ReturnType<typeof vi.fn>
  insert: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  transaction: ReturnType<typeof vi.fn>
}

function createDb(overrides: { inserted?: TestRow[]; updated?: TestRow[] } = {}): TestDatabase {
  const inserted = overrides.inserted ?? [{ id: "row-1", name: "created", version: 1 }]
  const updated = overrides.updated ?? [{ id: "row-1", name: "updated", version: 2 }]
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => []) })),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(() => returningPromise(inserted)) })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => returningPromise(updated)) })),
    })),
    delete: vi.fn(() => ({ where: vi.fn(() => returningPromise([])) })),
    transaction: vi.fn(),
  }
  return db
}

function createProvider(db: TestDatabase): InteractiveTransactionProvider {
  const registry = new DrizzleEntityRegistry()
  registry.register(entity, table, columnMap)
  return createDrizzlePersistenceProvider({
    db: db as unknown as PgDatabaseLike,
    registry,
  })
}

describe("PostgreSQL persistence provider", () => {
  it("passes the normalized optimistic concurrency version field to the repository", async () => {
    const definition = defineEntity({
      moduleKey: "tenant.test",
      entity: { name: "test", fields: entity.fields },
      entityScope: { kind: "platform", acknowledged: true },
      policy: { skipCapabilityCheck: true },
      validation: { createBody: {} as never, updateBody: {} as never },
      optimisticConcurrency: { versionField: "version" as const },
    })
    const db = createDb()
    const repository = createDrizzleRepository({ db: createPgSession(db as unknown as PgDatabaseLike), table, entity: definition.entity, columnMap })

    await repository.update("row-1", { name: "updated" }, { optimisticConcurrency: { expectedVersion: 1 } })

    const updateBuilder = db.update.mock.results[0]?.value as { set: { mock: { calls: unknown[][] } } }
    expect((updateBuilder.set.mock.calls[0]?.[0] as Record<string, unknown>).version).toBeDefined()
  })

  it("runs the callback with a transaction-scoped provider", async () => {
    const db = createDb()
    db.transaction.mockImplementation(async (callback: (tx: PgDatabaseLike) => Promise<unknown>) => callback(createDb() as unknown as PgDatabaseLike))
    const provider = createProvider(db)
    const result = await provider.runInTransaction(async (scoped) => {
      expect(scoped).not.toBe(provider)
      expect(scoped.capabilities.interactiveTransactions).toBe(true)
      expect(scoped.capabilities.exactDecimal).toBe(false)
      await internalRepositoryForDescriptor(scoped, entity).insert({ id: "row-1", name: "created", version: 1 })
      return "completed"
    }, { isolationLevel: "serializable", accessMode: "read write" })

    expect(result).toBe("completed")
    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "serializable",
      accessMode: "read write",
    })
  })

  it("reports only PostgreSQL capabilities that the provider supports", () => {
    const provider = createProvider(createDb())

    expect(provider.capabilities).toMatchObject({
      interactiveTransactions: true,
      atomicBatch: false,
      maxPageSize: 100,
    })
    expect(provider.capabilities.maxBindParams).toBeUndefined()
    expect(provider.capabilities.maxStatementBytes).toBeUndefined()
  })

  it("preserves the configurable maxPageSize capability", () => {
    const registry = new DrizzleEntityRegistry()
    registry.register(entity, table, columnMap)
    const provider = createDrizzlePersistenceProvider({
      db: createDb() as unknown as PgDatabaseLike,
      registry,
      limits: { maxPageSize: 7 },
    })

    expect(provider.capabilities.maxPageSize).toBe(7)
  })

  it("rejects nested transactions", async () => {
    const db = createDb()
    db.transaction.mockImplementation(async (callback: (tx: PgDatabaseLike) => Promise<unknown>) => callback(createDb() as unknown as PgDatabaseLike))
    const provider = createProvider(db)

    await expect(provider.runInTransaction(async (scoped) => {
      return await (scoped as InteractiveTransactionProvider).runInTransaction<string>(async () => "nested")
    }))
      .rejects.toThrow("Nested PostgreSQL transactions are not supported")
  })

  it("stores and retrieves sessions for the root and scoped providers", async () => {
    const db = createDb()
    let scopedProvider: InteractiveTransactionProvider | undefined
    db.transaction.mockImplementation(async (callback: (tx: PgDatabaseLike) => Promise<unknown>) => callback(createDb() as unknown as PgDatabaseLike))
    const provider = createProvider(db)
    expect(getDrizzleSession(provider)).toBeTruthy()
    await provider.runInTransaction(async (scoped) => {
      scopedProvider = scoped as InteractiveTransactionProvider
      expect(getDrizzleSession(scoped)).toBeTruthy()
    })
    expect(scopedProvider).toBeTruthy()
    expect(scopedProvider).toBeDefined()
    expect(getDrizzleSession(scopedProvider as InteractiveTransactionProvider)).not.toBe(getDrizzleSession(provider))
  })

  it("uses PostgreSQL returning for inserts and updates", async () => {
    const db = createDb()
    const repository = createDrizzleRepository({ db: createPgSession(db as unknown as PgDatabaseLike), table, entity, columnMap })

    await expect(repository.insert({ id: "row-1", name: "created", version: 1 })).resolves.toEqual({ id: "row-1", name: "created", version: 1 })
    await expect(repository.update("row-1", { name: "updated" }, {
      optimisticConcurrency: { expectedVersion: 1 },
    })).resolves.toEqual({ id: "row-1", name: "updated", version: 2 })
  })

  it("increments the version and includes the expected version in the update predicate", async () => {
    const db = createDb()
    const repository = createDrizzleRepository({ db: createPgSession(db as unknown as PgDatabaseLike), table, entity, columnMap })

    await repository.update("row-1", { name: "updated" }, { optimisticConcurrency: { expectedVersion: 1 } })

    const updateBuilder = db.update.mock.results[0]?.value as {
      set: { mock: { calls: unknown[][]; results: Array<{ value: { where: { mock: { calls: unknown[][] } } } }> } }
    }
    const setData = updateBuilder.set.mock.calls[0]?.[0] as Record<string, unknown>
    expect(setData.name).toBe("updated")
    expect(setData.version).toBeDefined()
    expect(updateBuilder.set.mock.results[0]?.value.where).toHaveBeenCalled()
    const whereExpression = updateBuilder.set.mock.results[0]?.value.where.mock.calls[0]?.[0] as SQL<unknown>
    const whereQuery = new PgDialect().sqlToQuery(whereExpression)
    expect(whereQuery.params).toContain(1)
    expect(whereQuery.sql).toContain(`"test_rows"."version" < ${Number.MAX_SAFE_INTEGER}`)
    expect(whereQuery.params).not.toContain(Number.MAX_SAFE_INTEGER)
  })

  it("rejects caller-provided version field to prevent manual version override", async () => {
    const db = createDb()
    const repository = createDrizzleRepository({ db: createPgSession(db as unknown as PgDatabaseLike), table, entity, columnMap })

    await expect(repository.update("row-1", { name: "updated", version: 99 }, {
      optimisticConcurrency: { expectedVersion: 1 },
    }))
      .rejects.toThrow("Cannot set version field")
  })

  it("does not expose updateManyWhere for versioned entities", () => {
    const repository = createDrizzleRepository({
       db: {} as unknown as DrizzleSessionLike,
      table,
       entity: entity as VersionedEntityDescriptor<TestRow>,
      columnMap,
    })
    expect("updateManyWhere" in repository).toBe(false)
  })

  it("rejects an empty insert returning result with a structured configuration error", async () => {
    const db = createDb({ inserted: [] })
    const repository = createDrizzleRepository({ db: createPgSession(db as unknown as PgDatabaseLike), table, entity, columnMap })

    await expect(repository.insert({ id: "row-1", name: "created", version: 1 })).rejects.toBeInstanceOf(ConfigurationError)
  })

  it("persists audit occurredAt in the createdAt column", async () => {
    const values = vi.fn(() => Promise.resolve())
    const db = { insert: vi.fn(() => ({ values })) }
    const provider = createProvider(createDb())
    const sink = createDrizzleAuditSinkFactory(table).create(provider)
    const occurredAt = new Date("2026-01-01T00:00:00.000Z")
    const record: AuditRecord = {
      id: "audit-1",
      occurredAt,
      action: "update",
      resourceType: "test",
      resourceId: "row-1",
      actor: { id: "user-1", kind: "human", authentication: { kind: "authenticated", method: "test", authenticatedAt: "2026-09-10T00:00:00.000Z" } },
      tenantId: null,
      oldValue: null,
      newValue: null,
    }

    // The factory resolves the provider session, so replace that session's insert method.
    const session = getDrizzleSession(provider) as unknown as { insert: typeof db.insert }
    session.insert = db.insert
    await sink.write(record)
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ id: record.id, createdAt: occurredAt }))
    expect((values.mock.calls as unknown[][])[0]?.[0]).not.toHaveProperty("occurredAt")
  })

  it("reports optimistic concurrency conflicts when returning is empty", async () => {
    const db = createDb({ updated: [] })
    const repository = createDrizzleRepository({ db: createPgSession(db as unknown as PgDatabaseLike), table, entity, columnMap })

    if (!repository.updateOneWhere) throw new Error("updateOneWhere is required for this adapter test")
    await expect(repository.updateOneWhere(Predicate.eq("id", "row-1"), { name: "stale" }, {
      optimisticConcurrency: { expectedVersion: 1 },
    })).rejects.toBeInstanceOf(OptimisticConcurrencyError)
  })

  it("allows one writer and rejects the next stale writer", async () => {
    const returningResults = [
      [{ id: "row-1", name: "first", version: 4 }],
      [],
    ]
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [{ primaryKey: "row-1" }]) })) })) })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => returningPromise(returningResults.shift() ?? [])),
        })),
      })),
    } as unknown as TestDatabase
    const repository = createDrizzleRepository({ db: createPgSession(db as unknown as PgDatabaseLike), table, entity, columnMap })

     await expect(repository.updateOneWhereReturning?.(Predicate.eq("id", "row-1"), { name: "first" }, {
       optimisticConcurrency: { expectedVersion: 3 },
     })).resolves.toEqual({ id: "row-1", name: "first", version: 4 })
    await expect(repository.updateOneWhere?.(Predicate.eq("id", "row-1"), { name: "stale" }, {
      optimisticConcurrency: { expectedVersion: 3 },
    })).rejects.toBeInstanceOf(OptimisticConcurrencyError)
  })

  it.each([
    ["40001", "Serialization failure detected"],
    ["40P01", "Deadlock detected"],
  ]) ("maps PostgreSQL retryable error %s to a retryable persistence error", async (code, message) => {
    const failure = Object.assign(new Error(`database error ${code}`), { code })
    const returning = Promise.resolve([]) as unknown as Promise<unknown[]> & { returning: () => Promise<unknown[]> }
    returning.returning = () => Promise.reject(failure)
    const db = {
      insert: vi.fn(() => ({ values: vi.fn(() => returning) })),
    } as unknown as TestDatabase
    const repository = createDrizzleRepository({ db: createPgSession(db as unknown as PgDatabaseLike), table, entity, columnMap })

    await expect(repository.insert({ id: "row-1", name: "created", version: 1 })).rejects.toSatisfy((error: unknown) =>
      error instanceof RetryablePersistenceError &&
      error.message.includes(message) &&
      error.details !== undefined &&
      typeof error.details === "object" &&
      error.details !== null &&
      "postgresCode" in error.details &&
      error.details.postgresCode === code,
    )
  })
})
