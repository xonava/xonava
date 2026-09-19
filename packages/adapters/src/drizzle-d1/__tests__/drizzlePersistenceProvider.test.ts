import { describe, expect, it, vi } from "vitest"
import { getTableName } from "drizzle-orm"
import { integer, SQLiteSyncDialect, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { SQL } from "drizzle-orm/sql/sql"
import { ConfigurationError, OptimisticConcurrencyError, Predicate } from "core/domain"
import { createDrizzlePersistenceProvider, createDrizzleRepository, DrizzleEntityRegistry, DrizzleAuditSink, DrizzleOutboxSink, D1BatchLimitExceededError, D1_IDEMPOTENCY_ASSERTION_CAPABILITY, fingerprintOutboxRecord, type DrizzleD1Command } from "adapters/drizzle-d1"
import type { AtomicBatchPlan, AtomicBatchResult, TenantScopedAtomicBatchPlan, TenantScopedWriteCommand } from "core/persistence"
import type { AuditRecord, OutboxRecord } from "core/events"
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import type { DrizzleSessionLike } from "adapters/drizzle-d1"
import { defineEntity } from "core/entity"
import { createTenantScopedPersistenceProvider } from "core/persistence"

const auditTable = { name: "audit" } as unknown as AnySQLiteTable
const outboxTable = sqliteTable("outbox", {
  id: text("id").primaryKey(),
  idempotencyScope: text("idempotency_scope"),
  idempotencyKey: text("idempotency_key"),
  eventFingerprint: text("event_fingerprint"),
}, (table) => [uniqueIndex("outbox_idempotency_unique").on(table.idempotencyScope, table.idempotencyKey)])
const rowsTable = sqliteTable("test_rows", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  version: integer("version").notNull(),
})
const tenantRowsTable = sqliteTable("tenant_rows", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
})

interface TestRow extends Record<string, unknown> {
  id: string
  name: string
  version: number
}

const entity = {
  name: "test",
  primaryKey: "id",
  versionField: "version",
  fields: {
    id: { type: "string" },
    name: { type: "string" },
    version: { type: "number" },
  },
} as const

const columnMap = { id: rowsTable.id, name: rowsTable.name, version: rowsTable.version }

const audit: AuditRecord = {
  id: "audit-1",
  occurredAt: new Date("2026-01-01T00:00:00.000Z"),
  action: "create",
  resourceType: "test",
  resourceId: "row-1",
  actor: { id: "user-1", kind: "human", authentication: { kind: "authenticated", method: "test", authenticatedAt: "2026-09-10T00:00:00.000Z" } },
  tenantId: "tenant-1",
  oldValue: null,
  newValue: { name: "created" },
}

const outbox: OutboxRecord = {
  id: "outbox-1",
  type: "test.created",
  version: 1,
  scope: { kind: "platform", platformKey: "test" },
  scopeId: "fscope:v1:eyJraW5kIjoicGxhdGZvcm0iLCJwbGF0Zm9ybUtleSI6InRlc3QifQ" as never,
  aggregateType: "test",
  aggregateId: "row-1",
  payload: { name: "created" },
  idempotencyKey: "test-created-row-1",
  occurredAt: new Date("2026-01-01T00:00:00.000Z"),
}

function createD1() {
  const commands: unknown[] = []
  const insertedValues: unknown[] = []
  const updateWhereClauses: unknown[] = []
  const deleteWhereClauses: unknown[] = []
  const conflictHandlers: ReturnType<typeof vi.fn>[] = []
  const select = vi.fn(() => ({
    toSQL: () => ({ sql: "select 1", params: [] }),
    from: vi.fn((table: unknown) => ({
      where: vi.fn(() => ({
        toSQL: () => ({ sql: "select 1", params: [] }),
        limit: vi.fn(async () => {
          if (getTableName(table as AnySQLiteTable) === "sqlite_master") return [{ triggerSql: "CREATE TRIGGER idempotency_commit_ownership_fence BEFORE INSERT ON `idempotency_commit_assertion` WHEN NEW.expected_affected_rows IS NULL AND NOT EXISTS (SELECT 1 FROM idempotency_records WHERE scope = NEW.scope AND key = NEW.key AND fingerprint = NEW.fingerprint AND token = NEW.token AND status = 'in-progress') BEGIN SELECT RAISE(ABORT, 'idempotency ownership lost'); END" }]
          return []
        }),
      })),
    })),
  }))
  const batch = vi.fn(async (statements: readonly unknown[]) => {
    commands.push(...statements)
    return statements.map((_, index) => ({ index, meta: { changes: 1 } }))
  })
  const raw = {
    batch,
    select,
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((data: unknown) => {
        insertedValues.push(data)
        const statement = {
          table,
          data,
          toSQL: () => ({ sql: `insert into ${String((table as { name?: string }).name ?? "table")}`, params: Object.values(data as Record<string, unknown>) }),
        }
        const onConflictDoNothing = vi.fn(async () => statement)
        conflictHandlers.push(onConflictDoNothing)
        return {
          ...statement,
          onConflictDoNothing,
        }
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((data: unknown) => ({
        where: vi.fn((filter: unknown) => {
          updateWhereClauses.push({ table, data, filter })
          return { table, data, filter, toSQL: () => ({ sql: "update test set name = ? where id = ?", params: [data, filter] }) }
        }),
      })),
    })),
    delete: vi.fn((table: unknown) => ({
      where: vi.fn((filter: unknown) => {
        deleteWhereClauses.push({ table, filter })
        return { table, filter, toSQL: () => ({ sql: "delete from test where id = ?", params: [filter] }) }
      }),
    })),
  }
  return { raw, batch, commands, insertedValues, updateWhereClauses, deleteWhereClauses, conflictHandlers, select }
}

function createPlan(items: AtomicBatchPlan<DrizzleD1Command>["items"]): AtomicBatchPlan<DrizzleD1Command> {
  return {
    items,
  }
}

function runnable(sql: string, params: readonly unknown[] = []): DrizzleD1Command {
  return { toSQL: () => ({ sql, params }) } as unknown as DrizzleD1Command
}

interface D1TestDatabase {
  batch: ReturnType<typeof vi.fn>
  insert: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
}

function asD1Database(db: D1TestDatabase): DrizzleD1Database<Record<string, never>> {
  return db as unknown as DrizzleD1Database<Record<string, never>>
}

describe("D1 persistence provider atomic batches", () => {
  it("uses adapter-owned tenant-safe builders for insert, update, and delete", async () => {
    const d1 = createD1()
    const tenantEntity = {
      name: "tenant-test",
      tenantField: "tenantId",
      primaryKey: "id",
      fields: {
        id: { type: "string" },
        tenantId: { type: "string" },
        name: { type: "string" },
      },
    } as const
    const registry = new DrizzleEntityRegistry().register(
      tenantEntity,
      tenantRowsTable,
      { id: tenantRowsTable.id, tenantId: tenantRowsTable.tenantId, name: tenantRowsTable.name },
    )
    const provider = createDrizzlePersistenceProvider({ db: asD1Database(d1.raw), registry })
    const scoped = createTenantScopedPersistenceProvider(provider, "tenant-a")
    const atomicProvider = scoped as typeof scoped & {
      executeAtomicBatch(plan: TenantScopedAtomicBatchPlan<DrizzleD1Command>): Promise<AtomicBatchResult>
    }
    const commands: TenantScopedWriteCommand[] = [
      { kind: "insert", entity: "tenant-test", values: { id: "row-1", name: "created" } },
      { kind: "update", entity: "tenant-test", filter: Predicate.eq("id", "row-1"), values: { name: "updated" }, expectedVersion: 1 },
      { kind: "delete", entity: "tenant-test", filter: Predicate.eq("id", "row-1"), expectedVersion: 1 },
    ] as const

    await atomicProvider.executeAtomicBatch({
       items: commands.map((command) => ({ kind: "command" as const, command })),
    })

    expect(d1.insertedValues[0]).toMatchObject({ id: "row-1", tenantId: "tenant-a" })
    const updateSql = new SQLiteSyncDialect().sqlToQuery(
      (d1.updateWhereClauses[0] as { filter: SQL }).filter,
    ).sql
    const deleteSql = new SQLiteSyncDialect().sqlToQuery(
      (d1.deleteWhereClauses[0] as { filter: SQL }).filter,
    ).sql
    expect(updateSql).toContain('"tenant_rows"."tenant_id" = ?')
    expect(deleteSql).toContain('"tenant_rows"."tenant_id" = ?')
  })

  it("rejects opaque commands during tenant-scoped execution", async () => {
    const d1 = createD1()
    const registry = new DrizzleEntityRegistry()
    const provider = createDrizzlePersistenceProvider({ db: asD1Database(d1.raw), registry })
    const scoped = createTenantScopedPersistenceProvider(provider, "tenant-a") as unknown as typeof provider & {
      executeAtomicBatch(plan: TenantScopedAtomicBatchPlan<DrizzleD1Command>): Promise<AtomicBatchResult>
    }

    await expect(scoped.executeAtomicBatch({
      items: [{ kind: "command", command: { sql: "unscoped" } as unknown as DrizzleD1Command }],
    })).rejects.toThrow("opaque Drizzle queries")
    expect(d1.batch).not.toHaveBeenCalled()
  })

  it("passes the normalized optimistic concurrency version field to the repository", async () => {
    const definition = defineEntity({
      moduleKey: "tenant.test",
      entity: { name: "test", fields: entity.fields },
      entityScope: { kind: "platform", acknowledged: true },
      policy: { skipCapabilityCheck: true },
      validation: { createBody: {} as never, updateBody: {} as never },
      optimisticConcurrency: { versionField: "version" as const },
    })
    const where = vi.fn(async () => ({ affectedRows: 1 }))
    const set = vi.fn(() => ({ where }))
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [{ primaryKey: "row-1" }]) })) })) })),
      update: vi.fn(() => ({ set })),
    } as unknown as DrizzleSessionLike
    const repository = createDrizzleRepository<TestRow>({ db, table: rowsTable, entity: definition.entity, columnMap })

    await expect(repository.updateOneWhere?.(Predicate.eq("id", "row-1"), { name: "updated" }, {
      optimisticConcurrency: { expectedVersion: 3 },
    })).resolves.toEqual({ updatedCount: 1 })
    const setCalls = set.mock.calls as unknown[][]
    const setData = setCalls[0]?.[0] as { version?: unknown } | undefined
    expect(setData?.version).toBeDefined()
  })

  it("sends commands, audit, and outbox items in one raw batch call", async () => {
    const d1 = createD1()
    const provider = createDrizzlePersistenceProvider({
      db: asD1Database(d1.raw),
      registry: new DrizzleEntityRegistry(),
      auditTable,
      outboxTable,
      mapOutboxRecord: (record) => ({
        type: record.type,
        payload: JSON.stringify(record.payload),
      }),
    })
    const command = runnable("insert test")
    const plan = createPlan([
      { kind: "command", command },
      { kind: "audit", record: audit },
      { kind: "outbox", record: outbox },
    ])

    const atomicProvider = provider as typeof provider & {
      executeAtomicBatch(batchPlan: AtomicBatchPlan<DrizzleD1Command>): Promise<AtomicBatchResult>
    }
    const executeAtomicBatch = atomicProvider.executeAtomicBatch.bind(atomicProvider)
    await expect(executeAtomicBatch(plan)).resolves.toEqual([
       { kind: "command", result: { index: 0, meta: { changes: 1 } } },
       { kind: "audit", result: { index: 1, meta: { changes: 1 } } },
       { kind: "outbox", result: { index: 2, meta: { changes: 1 } } },
    ])

    expect(d1.batch).toHaveBeenCalledTimes(1)
    expect(d1.commands).toHaveLength(3)
    expect(d1.commands[0]).toBe(command)
    expect(d1.raw.insert).toHaveBeenNthCalledWith(1, auditTable)
    expect(d1.raw.insert).toHaveBeenNthCalledWith(2, outboxTable)
    expect(d1.insertedValues[0]).toMatchObject({ id: audit.id, createdAt: audit.occurredAt })
    expect(d1.insertedValues[0]).not.toHaveProperty("occurredAt")
      expect(d1.insertedValues[1]).toMatchObject({
        id: outbox.id,
        idempotencyScope: outbox.scopeId,
      })
      expect(typeof (d1.insertedValues[1] as { eventFingerprint?: unknown }).eventFingerprint).toBe("string")
      expect(d1.conflictHandlers[1]).not.toHaveBeenCalled()
  })

  it("persists idempotency commit receipts atomically inside the batch", async () => {
    const d1 = createD1()
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
      createdAt: integer("created_at"),
      completedAt: integer("completed_at"),
    })
    const idempotencyAssertionTable = Object.assign(sqliteTable("idempotency_commit_assertion", {
      scope: text("scope"),
      key: text("key"),
      fingerprint: text("fingerprint"),
      token: text("token"),
    }), { idempotencyAssertionCapability: D1_IDEMPOTENCY_ASSERTION_CAPABILITY })
    const provider = createDrizzlePersistenceProvider({
      db: asD1Database(d1.raw),
      registry: new DrizzleEntityRegistry(),
      idempotencyTable,
      idempotencyAssertionTable,
    })
    expect(provider.capabilities.atomicBatchIdempotency).toBe(true)

    const executeAtomicBatch = (provider as typeof provider & {
      executeAtomicBatch(plan: AtomicBatchPlan<DrizzleD1Command>): Promise<AtomicBatchResult>
    }).executeAtomicBatch.bind(provider)
    const plan: AtomicBatchPlan<DrizzleD1Command> = {
      items: [{
        kind: "idempotency",
        commit: { scope: "tenant:one", key: "key-1", fingerprint: "f", token: "t", resource: { entity: "row", id: "row-1" }, invalidations: ["tag-a"] },
      }],
    }
    const results = await executeAtomicBatch(plan)

    expect(results[0]).toMatchObject({ kind: "idempotency" })
    // An idempotency item expands to an ownership assertion insert + receipt update.
    expect(d1.raw.insert).toHaveBeenCalledWith(idempotencyAssertionTable)
    expect(d1.raw.update).toHaveBeenCalledWith(idempotencyTable)
    expect(d1.updateWhereClauses[0]).toMatchObject({ table: idempotencyTable })
    expect(d1.insertedValues[0]).toMatchObject({ scope: "tenant:one", key: "key-1", token: "t" })
  })

  it("aborts an atomic batch when an outbox key has different fingerprints", async () => {
    const d1 = createD1()
    const provider = createDrizzlePersistenceProvider({
      db: asD1Database(d1.raw), registry: new DrizzleEntityRegistry(), outboxTable,
      mapOutboxRecord: (record) => ({ type: record.type, payload: JSON.stringify(record.payload) }),
    })
    const executeAtomicBatch = (provider as typeof provider & {
      executeAtomicBatch(plan: AtomicBatchPlan<DrizzleD1Command>): Promise<AtomicBatchResult>
    }).executeAtomicBatch.bind(provider)

    await expect(executeAtomicBatch(createPlan([
      { kind: "outbox", record: outbox },
      { kind: "outbox", record: { ...outbox, payload: { name: "different" } } },
    ]))).rejects.toThrow("Outbox idempotency key was reused for a different event")
    expect(d1.batch).not.toHaveBeenCalled()
  })

  it("deduplicates identical outbox identities within one atomic batch", async () => {
    const d1 = createD1()
    const provider = createDrizzlePersistenceProvider({
      db: asD1Database(d1.raw), registry: new DrizzleEntityRegistry(), outboxTable,
      mapOutboxRecord: (record) => ({ type: record.type, payload: JSON.stringify(record.payload) }),
    })
    const executeAtomicBatch = (provider as typeof provider & {
      executeAtomicBatch(plan: AtomicBatchPlan<DrizzleD1Command>): Promise<AtomicBatchResult>
    }).executeAtomicBatch.bind(provider)

    const results = await executeAtomicBatch(createPlan([
      { kind: "outbox", record: outbox },
      { kind: "outbox", record: { ...outbox } },
    ]))

    expect(d1.batch).toHaveBeenCalledOnce()
    expect(d1.commands).toHaveLength(2)
    expect(results).toHaveLength(2)
    expect(d1.raw.insert).toHaveBeenCalledOnce()
  })

  it("turns an existing identical outbox identity into an atomic no-op", async () => {
    const d1 = createD1()
    const fingerprint = await fingerprintOutboxRecord(outbox)
    d1.select.mockReturnValue({
      toSQL: () => ({ sql: "select 1", params: [] }),
      from: vi.fn(() => ({
        where: vi.fn(() => ({ toSQL: () => ({ sql: "select 1", params: [] }), limit: vi.fn(async () => [{ eventFingerprint: fingerprint }]) })),
      })),
    } as never)
    const provider = createDrizzlePersistenceProvider({
      db: asD1Database(d1.raw), registry: new DrizzleEntityRegistry(), outboxTable,
      mapOutboxRecord: (record) => ({ type: record.type, payload: JSON.stringify(record.payload) }),
    })
    const executeAtomicBatch = (provider as typeof provider & {
      executeAtomicBatch(plan: AtomicBatchPlan<DrizzleD1Command>): Promise<AtomicBatchResult>
    }).executeAtomicBatch.bind(provider)

    await executeAtomicBatch(createPlan([{ kind: "outbox", record: outbox }]))

    expect(d1.batch).toHaveBeenCalledOnce()
    expect(d1.raw.insert).not.toHaveBeenCalled()
    expect(d1.commands).toHaveLength(1)
  })

  it("does not replay business commands when an existing outbox row lacks a committed receipt", async () => {
    const d1 = createD1()
    const fingerprint = await fingerprintOutboxRecord(outbox)
    d1.select.mockReturnValue({
      toSQL: () => ({ sql: "select 1", params: [] }),
      from: vi.fn(() => ({
        where: vi.fn(() => ({ toSQL: () => ({ sql: "select 1", params: [] }), limit: vi.fn(async () => [{ eventFingerprint: fingerprint }]) })),
      })),
    } as never)
    let businessCommandRuns = 0
    const businessCommand = {
      toSQL: () => ({ sql: "business mutation", params: [] }),
      run: () => { businessCommandRuns += 1 },
    } as unknown as DrizzleD1Command
    const provider = createDrizzlePersistenceProvider({
      db: asD1Database(d1.raw), registry: new DrizzleEntityRegistry(), outboxTable,
      mapOutboxRecord: (record) => ({ type: record.type, payload: JSON.stringify(record.payload) }),
    })
    const executeAtomicBatch = (provider as typeof provider & {
      executeAtomicBatch(plan: AtomicBatchPlan<DrizzleD1Command>): Promise<AtomicBatchResult>
    }).executeAtomicBatch.bind(provider)

    await expect(executeAtomicBatch(createPlan([
      { kind: "command", command: businessCommand },
      { kind: "outbox", record: outbox },
    ]))).rejects.toThrow("committed idempotency receipt")
    expect(businessCommandRuns).toBe(0)
    expect(d1.batch).not.toHaveBeenCalled()
  })

  it("rejects an existing atomic outbox identity with a different fingerprint before batching", async () => {
    const d1 = createD1()
    d1.select.mockReturnValue({
      toSQL: () => ({ sql: "select 1", params: [] }),
      from: vi.fn(() => ({
        where: vi.fn(() => ({ toSQL: () => ({ sql: "select 1", params: [] }), limit: vi.fn(async () => [{ eventFingerprint: "different" }]) })),
      })),
    } as never)
    const provider = createDrizzlePersistenceProvider({
      db: asD1Database(d1.raw), registry: new DrizzleEntityRegistry(), outboxTable,
      mapOutboxRecord: (record) => ({ type: record.type, payload: JSON.stringify(record.payload) }),
    })
    const executeAtomicBatch = (provider as typeof provider & {
      executeAtomicBatch(plan: AtomicBatchPlan<DrizzleD1Command>): Promise<AtomicBatchResult>
    }).executeAtomicBatch.bind(provider)

    await expect(executeAtomicBatch(createPlan([{ kind: "outbox", record: outbox }]))).rejects
      .toThrow("Outbox idempotency key was reused for a different event")
    expect(d1.batch).not.toHaveBeenCalled()
  })

  it("rejects a forged ownership-fence property", async () => {
    const d1 = createD1()
    const provider = createDrizzlePersistenceProvider({
      db: asD1Database(d1.raw),
      registry: new DrizzleEntityRegistry(),
      idempotencyTable: { name: "idempotency_records" } as unknown as AnySQLiteTable,
       idempotencyAssertionTable: { name: "idempotency_commit_assertion", idempotencyAssertionCapability: "ownership-fence-trigger" } as unknown as AnySQLiteTable,
    })
    expect(provider.capabilities.atomicBatchIdempotency).toBeUndefined()

    await expect((provider as typeof provider & {
      executeAtomicBatch(plan: AtomicBatchPlan<DrizzleD1Command>): Promise<AtomicBatchResult>
    }).executeAtomicBatch(createPlan([{ kind: "idempotency", commit: { scope: "s", key: "k", fingerprint: "f", token: "t" } }]))).rejects
      .toThrow("ownership-fence-trigger")
    expect(d1.batch).not.toHaveBeenCalled()
  })

  it("aborts when the idempotency receipt update affects zero rows", async () => {
    const d1 = createD1()
    d1.batch.mockImplementationOnce(async (statements: readonly unknown[]) => {
      d1.commands.push(...statements)
      return statements.map((_, index) => ({ index, meta: { changes: index === 0 ? 1 : 0 } }))
    })
    const provider = createDrizzlePersistenceProvider({
      db: asD1Database(d1.raw),
      registry: new DrizzleEntityRegistry(),
      idempotencyTable: { name: "idempotency_records" } as unknown as AnySQLiteTable,
       idempotencyAssertionTable: Object.assign({ name: "idempotency_commit_assertion" }, { idempotencyAssertionCapability: D1_IDEMPOTENCY_ASSERTION_CAPABILITY }) as unknown as AnySQLiteTable,
    })

    await expect((provider as typeof provider & {
      executeAtomicBatch(plan: AtomicBatchPlan<DrizzleD1Command>): Promise<AtomicBatchResult>
    }).executeAtomicBatch(createPlan([{ kind: "idempotency", commit: { scope: "s", key: "k", fingerprint: "f", token: "t" } }]))).rejects
      .toThrow("affected exactly one row")
  })

  it.each([
    ["id", "mapper-id"],
    ["tenantId", "tenant-attacker"],
    ["idempotencyScope", "scope-attacker"],
    ["idempotencyKey", "key-attacker"],
    ["eventFingerprint", "fingerprint-attacker"],
  ])("rejects an atomic outbox mapper override of framework-owned %s before batching", async (field, value) => {
    const d1 = createD1()
    const provider = createDrizzlePersistenceProvider({
      db: asD1Database(d1.raw),
      registry: new DrizzleEntityRegistry(),
      outboxTable,
      mapOutboxRecord: () => ({ [field]: value }),
    })
    const executeAtomicBatch = (provider as typeof provider & {
      executeAtomicBatch(plan: AtomicBatchPlan<DrizzleD1Command>): Promise<AtomicBatchResult>
    }).executeAtomicBatch.bind(provider)

    await expect(executeAtomicBatch(createPlan([{ kind: "outbox", record: { ...outbox, tenantId: "tenant-a" } }]))).rejects
      .toThrow(`framework-owned ${field}`)
    expect(d1.raw.insert).not.toHaveBeenCalled()
    expect(d1.batch).not.toHaveBeenCalled()
  })

  it.each([
    ["id", { idempotencyScope: {}, idempotencyKey: {}, eventFingerprint: {} }],
    ["idempotencyScope", { id: {} , idempotencyKey: {}, eventFingerprint: {} }],
    ["idempotencyKey", { id: {}, idempotencyScope: {}, eventFingerprint: {} }],
    ["eventFingerprint", { id: {}, idempotencyScope: {}, idempotencyKey: {} }],
  ])("validates the required atomic outbox %s column before batching", async (_field, tableShape) => {
    const d1 = createD1()
    const provider = createDrizzlePersistenceProvider({
      db: asD1Database(d1.raw),
      registry: new DrizzleEntityRegistry(),
      outboxTable: { name: "outbox", ...tableShape } as unknown as AnySQLiteTable,
      mapOutboxRecord: () => ({}),
    })
    const executeAtomicBatch = (provider as typeof provider & {
      executeAtomicBatch(plan: AtomicBatchPlan<DrizzleD1Command>): Promise<AtomicBatchResult>
    }).executeAtomicBatch.bind(provider)

    await expect(executeAtomicBatch(createPlan([{ kind: "outbox", record: outbox }]))).rejects.toThrow("D1 outbox requires")
    expect(d1.batch).not.toHaveBeenCalled()
  })

  it("rejects an atomic outbox table without the unique scope/key contract", async () => {
    const d1 = createD1()
    const provider = createDrizzlePersistenceProvider({
      db: asD1Database(d1.raw),
      registry: new DrizzleEntityRegistry(),
      outboxTable: sqliteTable("outbox_without_unique", {
        id: text("id").primaryKey(),
        idempotencyScope: text("idempotency_scope"),
        idempotencyKey: text("idempotency_key"),
        eventFingerprint: text("event_fingerprint"),
      }),
      mapOutboxRecord: () => ({}),
    })
    const executeAtomicBatch = (provider as typeof provider & {
      executeAtomicBatch(plan: AtomicBatchPlan<DrizzleD1Command>): Promise<AtomicBatchResult>
    }).executeAtomicBatch.bind(provider)

    await expect(executeAtomicBatch(createPlan([{ kind: "outbox", record: outbox }]))).rejects
      .toThrow("unique (idempotencyScope,idempotencyKey) constraint")
    expect(d1.batch).not.toHaveBeenCalled()
  })

  it("enforces configured D1 batch limits at the boundary", async () => {
    const d1 = createD1()
    const provider = createDrizzlePersistenceProvider({
      db: asD1Database(d1.raw),
      registry: new DrizzleEntityRegistry(),
      limits: { maxBindParams: 2, maxStatementBytes: 8, maxBatchItems: 2 },
    })
    const executeAtomicBatch = (provider as typeof provider & {
      executeAtomicBatch(plan: AtomicBatchPlan<DrizzleD1Command>): Promise<AtomicBatchResult>
    }).executeAtomicBatch.bind(provider)

    await expect(executeAtomicBatch(createPlan([{ kind: "command", command: runnable("12345678", [1, 2]) }]))).resolves.toEqual([
       { kind: "command", result: { index: 0, meta: { changes: 1 } } },
    ])
    await expect(executeAtomicBatch(createPlan([{ kind: "command", command: runnable("ok", [1, 2, 3]) }]))).rejects.toMatchObject({
      name: "D1BatchLimitExceededError",
      details: { limit: "maxBindParams", actual: 3, maximum: 2, statementIndex: 0 },
    })
    await expect(executeAtomicBatch(createPlan([{ kind: "command", command: runnable("123456789") }]))).rejects.toMatchObject({
      details: { limit: "maxStatementBytes", actual: 9, maximum: 8, statementIndex: 0 },
    })
    await expect(executeAtomicBatch(createPlan([
      { kind: "command", command: runnable("a") },
      { kind: "command", command: runnable("b") },
      { kind: "command", command: runnable("c") },
    ]))).rejects.toMatchObject({
      details: { limit: "maxBatchItems", actual: 3, maximum: 2 },
    })
    expect(d1.batch).toHaveBeenCalledTimes(1)
    expect(d1.batch.mock.calls[0]?.[0]).toHaveLength(1)
  })

  it.each([
    ["NaN", Number.NaN],
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects %s D1 limit values at provider creation", (_label, value) => {
    for (const limit of ["maxBindParams", "maxStatementBytes", "maxBatchItems"] as const) {
      expect(() => createDrizzlePersistenceProvider({
        db: asD1Database(createD1().raw),
        registry: new DrizzleEntityRegistry(),
        limits: { [limit]: value },
      })).toThrow(new ConfigurationError(`D1 ${limit} must be a finite positive integer`))
    }
  })

  it.each([1, Number.MAX_SAFE_INTEGER])("accepts %s as a valid D1 limit boundary", (value) => {
    const provider = createDrizzlePersistenceProvider({
      db: asD1Database(createD1().raw),
      registry: new DrizzleEntityRegistry(),
      limits: { maxBindParams: value, maxStatementBytes: value, maxBatchItems: value },
    })

    expect(provider.capabilities).toMatchObject({
      maxBindParams: value,
      maxStatementBytes: value,
      maxBatchItems: value,
    })
  })

  it("checks every statement in a combined command, audit, and outbox batch", async () => {
    const d1 = createD1()
    const provider = createDrizzlePersistenceProvider({
      db: asD1Database(d1.raw),
      registry: new DrizzleEntityRegistry(),
      auditTable,
      outboxTable,
      mapOutboxRecord: (record) => ({ payload: JSON.stringify(record.payload) }),
      limits: { maxBindParams: 1, maxStatementBytes: 200, maxBatchItems: 3 },
    })
    const executeAtomicBatch = (provider as typeof provider & {
      executeAtomicBatch(plan: AtomicBatchPlan<DrizzleD1Command>): Promise<AtomicBatchResult>
    }).executeAtomicBatch.bind(provider)

    await expect(executeAtomicBatch(createPlan([
      { kind: "command", command: runnable("ok", [1]) },
      { kind: "audit", record: audit },
      { kind: "outbox", record: outbox },
    ]))).rejects.toBeInstanceOf(D1BatchLimitExceededError)
    expect(d1.batch).not.toHaveBeenCalled()
  })

  it("rejects protected fields in tenant-scoped atomic updates", async () => {
    const d1 = createD1()
    const tenantEntity = {
      name: "tenant-test",
      tenantField: "tenantId",
      primaryKey: "id",
      immutableFields: ["name"] as Array<"id" | "tenantId" | "name">,
      fields: { id: { type: "string" }, tenantId: { type: "string" }, name: { type: "string" } },
    } as const
    const registry = new DrizzleEntityRegistry().register(tenantEntity, tenantRowsTable, {
      id: tenantRowsTable.id, tenantId: tenantRowsTable.tenantId, name: tenantRowsTable.name,
    })
    const provider = createDrizzlePersistenceProvider({ db: asD1Database(d1.raw), registry })
    const scoped = createTenantScopedPersistenceProvider(provider, "tenant-a") as unknown as typeof provider & {
      commandEncoder: { encode(command: TenantScopedWriteCommand): DrizzleD1Command }
    }

    for (const field of ["id", "tenantId", "name"]) {
      expect(() => scoped.commandEncoder.encode({
        kind: "update", entity: "tenant-test", filter: Predicate.eq("id", "row-1"), values: { [field]: "blocked" },
      })).toThrow()
    }
    expect(d1.batch).not.toHaveBeenCalled()
  })

  it("rejects opaque commands before calling D1", async () => {
    const d1 = createD1()
    const provider = createDrizzlePersistenceProvider({ db: asD1Database(d1.raw), registry: new DrizzleEntityRegistry() })
    const executeAtomicBatch = (provider as typeof provider & {
      executeAtomicBatch(plan: AtomicBatchPlan<DrizzleD1Command>): Promise<AtomicBatchResult>
    }).executeAtomicBatch.bind(provider)

    await expect(executeAtomicBatch(createPlan([{ kind: "command", command: { sql: "opaque" } as unknown as DrizzleD1Command }]))).rejects.toThrow("toSQL method")
    expect(d1.batch).not.toHaveBeenCalled()
  })

  it("propagates a raw batch failure without resolving the plan", async () => {
    const failure = new Error("D1 batch failed")
    const d1 = createD1()
    d1.batch.mockRejectedValueOnce(failure)
    const provider = createDrizzlePersistenceProvider({
      db: asD1Database(d1.raw),
      registry: new DrizzleEntityRegistry(),
    })
    const plan = createPlan([{ kind: "command", command: runnable("write") }])

    const atomicProvider = provider as typeof provider & {
      executeAtomicBatch(batchPlan: AtomicBatchPlan<DrizzleD1Command>): Promise<AtomicBatchResult>
    }
    const executeAtomicBatch = atomicProvider.executeAtomicBatch.bind(atomicProvider)
    await expect(executeAtomicBatch(plan)).rejects.toBe(failure)
  })

  it("uses the expected version predicate, increments the version, and rejects stale writes", async () => {
    const where = vi.fn(async () => ({ affectedRows: 0 }))
    let setData: { version?: SQL } | undefined
    const set = vi.fn((data: { version?: SQL }) => {
      setData = data
      return { where }
    })
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [{ primaryKey: "row-1" }]) })) })) })),
      update: vi.fn(() => ({ set })),
    } as unknown as DrizzleSessionLike
    const repository = createDrizzleRepository<TestRow>({ db, table: rowsTable, entity, columnMap })

    await expect(repository.updateOneWhere?.(Predicate.eq("id", "row-1"), { name: "stale" }, {
      optimisticConcurrency: { expectedVersion: 3 },
    })).rejects.toBeInstanceOf(OptimisticConcurrencyError)
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ name: "stale" }))
    const versionExpression = setData?.version
    expect(versionExpression).toBeDefined()
    if (!versionExpression) throw new Error("Expected a version SQL expression")
    expect(new SQLiteSyncDialect().sqlToQuery(versionExpression).sql).toContain('"test_rows"."version" + 1')
    expect(where).toHaveBeenCalledOnce()
    const whereCalls = where.mock.calls as unknown[][]
    const whereExpression = whereCalls[0]?.[0] as SQL
    const whereSql = new SQLiteSyncDialect().sqlToQuery(whereExpression).sql
    expect(whereSql).toContain('"test_rows"."id" = ?')
    expect(whereSql).toContain('"test_rows"."version" = ?')
    expect(whereSql).toContain('"test_rows"."version" < ?')
  })

  it("rejects caller-provided version field to prevent manual version override", async () => {
    const where = vi.fn(async () => ({ affectedRows: 1 }))
    const set = vi.fn(() => ({ where }))
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [{ primaryKey: "row-1" }]) })) })) })),
      update: vi.fn(() => ({ set })),
    } as unknown as DrizzleSessionLike
    const repository = createDrizzleRepository<TestRow>({ db, table: rowsTable, entity, columnMap })

    await expect(repository.updateOneWhere?.(Predicate.eq("id", "row-1"), { name: "updated", version: 99 }, {
      optimisticConcurrency: { expectedVersion: 3 },
    }))
      .rejects.toThrow("Cannot set version field")
  })

  it("does not expose updateManyWhere for versioned entities", () => {
    const repository = createDrizzleRepository<TestRow>({
      db: {} as DrizzleSessionLike,
      table: rowsTable,
      entity,
      columnMap,
    })
    expect("updateManyWhere" in repository).toBe(false)
  })

  it("allows one writer and rejects the next stale writer", async () => {
    const where = vi.fn()
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 0 })
    const set = vi.fn(() => ({ where }))
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [{ primaryKey: "row-1" }]) })) })) })),
      update: vi.fn(() => ({ set })),
    } as unknown as DrizzleSessionLike
    const repository = createDrizzleRepository<TestRow>({ db, table: rowsTable, entity, columnMap })

    await expect(repository.updateOneWhere?.(Predicate.eq("id", "row-1"), { name: "first" }, {
      optimisticConcurrency: { expectedVersion: 3 },
    })).resolves.toEqual({ updatedCount: 1 })
    await expect(repository.updateOneWhere?.(Predicate.eq("id", "row-1"), { name: "stale" }, {
      optimisticConcurrency: { expectedVersion: 3 },
    })).rejects.toBeInstanceOf(OptimisticConcurrencyError)

    expect(where).toHaveBeenCalledTimes(2)
  })

  it("requires D1 updateReturning support for update(id)", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [{ id: "row-1", name: "updated", version: 4 }]) })),
        })),
      })),
    } as unknown as DrizzleSessionLike
    const repository = createDrizzleRepository<TestRow>({ db, table: rowsTable, entity, columnMap })
    await expect(repository.update("row-1", { name: "updated" }, {
      optimisticConcurrency: { expectedVersion: 3 },
    })).rejects.toThrow("requires updateOneWhereReturning")
  })

  it("rejects unknown sort fields instead of silently falling back", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [{ count: 0 }]),
            orderBy: vi.fn(),
          })),
        })),
      })),
    } as unknown as DrizzleSessionLike
    const repository = createDrizzleRepository<TestRow>({ db, table: rowsTable, entity, columnMap })

    await expect(repository.findMany({ sort: [{ field: "missing", direction: "asc" }] })).rejects.toThrow('Unknown sort field: "missing"')
  })

  it("preserves supplied IDs and maps audit occurredAt to createdAt in sinks", async () => {
    const values = vi.fn(() => ({
      onConflictDoNothing: vi.fn(async () => ({ rowsAffected: 1 })),
    }))
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => []) })),
        })),
      })),
      insert: vi.fn(() => ({ values })),
    } as unknown as DrizzleSessionLike
    await new DrizzleAuditSink(db, auditTable).write(audit)
    await new DrizzleOutboxSink(db, outboxTable, (record) => ({ occurredAt: record.occurredAt })).append(outbox)

    expect(values).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: audit.id, createdAt: audit.occurredAt }))
    expect((values.mock.calls as unknown[][])[0]?.[0]).not.toHaveProperty("occurredAt")
    expect(values).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: outbox.id, occurredAt: outbox.occurredAt }))
  })
})
