import { describe, expect, it, vi } from "vitest"
import { encodeExecutionScopeId, type ExecutionScope } from "../../domain"
import { TenantScopeViolationError } from "../../domain/errors"
import type { OutboxRecord } from "../../events/durability/outbox"
import { createTenantScopedPersistenceProvider } from "../scoped"
import {
  supportsTenantScopedAtomicBatch,
  type AtomicBatchPlan,
  type AtomicBatchProvider,
  type EntityDescriptor,
  type InteractiveTransactionProvider,
  type ListResult,
  type PersistenceProvider,
} from "../provider"
import { testRepositoryForDescriptor, type TestRepository } from "./persistenceTestSupport"

type Row = { id: string; tenantId?: string; name: string }
const entity: EntityDescriptor<Row> = {
  name: "row",
  primaryKey: "id",
  tenantField: "tenantId",
  fields: { id: { type: "string" }, tenantId: { type: "string" }, name: { type: "string" } },
}
const capabilities = {
  interactiveTransactions: false,
  atomicBatch: false,
  returningInsert: false,
  readSessions: false,
  jsonQueries: false,
  exactDecimal: false,
  persistentConnection: false,
}

function makeRepo(findMany: TestRepository<Row>["findMany"]): TestRepository<Row> {
  return {
    findById: vi.fn(async () => null),
    findMany,
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  }
}

function scoped(tenantId: string): { readonly scope: ExecutionScope; readonly scopeId: ReturnType<typeof encodeExecutionScopeId> } {
  const scope: ExecutionScope = { kind: "tenant", tenantId }
  return { scope, scopeId: encodeExecutionScopeId(scope) }
}

function outbox(target: { readonly scope: ExecutionScope; readonly scopeId: ReturnType<typeof encodeExecutionScopeId> }, extra: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    id: "outbox-1",
    occurredAt: new Date("2026-10-01T00:00:00.000Z"),
    type: "row.created",
    version: 1,
    scope: target.scope,
    scopeId: target.scopeId,
    aggregateType: "row",
    aggregateId: "row-1",
    payload: {},
    idempotencyKey: "row-1",
    ...extra,
  }
}

function atomicBase(): { base: PersistenceProvider & AtomicBatchProvider; executeAtomicBatch: ReturnType<typeof vi.fn> } {
  const executeAtomicBatch = vi.fn(async (plan: AtomicBatchPlan<unknown>) => plan.items.map((item) => ({ kind: item.kind, result: undefined })))
  const base = {
    dialect: "memory",
    capabilities: { ...capabilities, atomicBatch: true },
    repository: () => makeRepo(vi.fn()),
    createTenantScopedCommandEncoder: (tenantId: string) => ({ tenantId, encode: (command: unknown) => command }),
    executeAtomicBatch,
  } as unknown as PersistenceProvider & AtomicBatchProvider
  return { base, executeAtomicBatch }
}

function tenantBatch(provider: PersistenceProvider): (record: OutboxRecord) => Promise<unknown> {
  if (!supportsTenantScopedAtomicBatch(provider)) throw new Error("expected tenant atomic batch provider")
  return (record) => provider.executeAtomicBatch({ items: [{ kind: "outbox", record }] })
}

describe("tenant-scoped atomic batch outbox records", () => {
  it("accepts an outbox record scoped to the wrapper tenant", async () => {
    const { base, executeAtomicBatch } = atomicBase()
    const run = tenantBatch(createTenantScopedPersistenceProvider(base, "tenant-a"))
    const tenantA = scoped("tenant-a")

    await expect(run(outbox(tenantA, { provenance: { target: tenantA } as never }))).resolves.toHaveLength(1)
    const forwarded = (executeAtomicBatch.mock.calls[0]![0] as AtomicBatchPlan<unknown>).items[0]
    expect(forwarded).toMatchObject({ kind: "outbox", record: { tenantId: "tenant-a", scopeId: tenantA.scopeId } })
  })

  it("rejects an outbox record whose scope belongs to another tenant", async () => {
    const { base, executeAtomicBatch } = atomicBase()
    const run = tenantBatch(createTenantScopedPersistenceProvider(base, "tenant-a"))

    await expect(run(outbox(scoped("tenant-b")))).rejects.toBeInstanceOf(TenantScopeViolationError)
    expect(executeAtomicBatch).not.toHaveBeenCalled()
  })

  it("rejects platform and system scoped outbox records from a tenant operation", async () => {
    const { base, executeAtomicBatch } = atomicBase()
    const run = tenantBatch(createTenantScopedPersistenceProvider(base, "tenant-a"))
    const platform: ExecutionScope = { kind: "platform", platformKey: "ops" }
    const system: ExecutionScope = { kind: "system", systemKey: "relay" }

    await expect(run(outbox({ scope: platform, scopeId: encodeExecutionScopeId(platform) }))).rejects.toBeInstanceOf(TenantScopeViolationError)
    await expect(run(outbox({ scope: system, scopeId: encodeExecutionScopeId(system) }))).rejects.toBeInstanceOf(TenantScopeViolationError)
    expect(executeAtomicBatch).not.toHaveBeenCalled()
  })

  it("rejects an outbox record whose scopeId does not match its scope", async () => {
    const { base, executeAtomicBatch } = atomicBase()
    const run = tenantBatch(createTenantScopedPersistenceProvider(base, "tenant-a"))

    await expect(run(outbox({ scope: scoped("tenant-a").scope, scopeId: scoped("tenant-b").scopeId }))).rejects.toBeInstanceOf(TenantScopeViolationError)
    expect(executeAtomicBatch).not.toHaveBeenCalled()
  })

  it("rejects an outbox record whose provenance targets another scope", async () => {
    const { base, executeAtomicBatch } = atomicBase()
    const run = tenantBatch(createTenantScopedPersistenceProvider(base, "tenant-a"))
    const tenantA = scoped("tenant-a")
    const tenantB = scoped("tenant-b")

    await expect(run(outbox(tenantA, { provenance: { target: tenantB } as never }))).rejects.toBeInstanceOf(TenantScopeViolationError)
    // A target whose scopeId claims tenant A but whose scope names tenant B is forged.
    await expect(run(outbox(tenantA, { provenance: { target: { scope: tenantB.scope, scopeId: tenantA.scopeId } } as never }))).rejects.toBeInstanceOf(TenantScopeViolationError)
    expect(executeAtomicBatch).not.toHaveBeenCalled()
  })

  it("applies the same outbox checks to providers handed out by runInTransaction", async () => {
    const { base: transactionBase, executeAtomicBatch } = atomicBase()
    const base = {
      dialect: "memory",
      capabilities: { ...capabilities, interactiveTransactions: true },
      repository: () => makeRepo(vi.fn()),
      runInTransaction: async <T>(work: (provider: PersistenceProvider) => Promise<T>) => work(transactionBase),
    } as unknown as InteractiveTransactionProvider
    const tenantProvider = createTenantScopedPersistenceProvider(base, "tenant-a") as unknown as InteractiveTransactionProvider

    await expect(tenantProvider.runInTransaction((tx) => tenantBatch(tx)(outbox(scoped("tenant-b"))))).rejects.toBeInstanceOf(TenantScopeViolationError)
    expect(executeAtomicBatch).not.toHaveBeenCalled()
  })
})

describe("tenant-scoped projected reads", () => {
  it("adds the tenant field to a projection, verifies it, and strips it from returned rows", async () => {
    const findMany = vi.fn(async (): Promise<ListResult<Row>> => ({ rows: [{ id: "1", name: "a", tenantId: "tenant-a" }], rowCount: 1, page: 1, pageSize: 10 }))
    const provider = createTenantScopedPersistenceProvider({ dialect: "memory", capabilities, repository: () => makeRepo(findMany) } as unknown as PersistenceProvider, "tenant-a")

    const result = await testRepositoryForDescriptor(provider, entity).findMany({ projection: { fields: ["id", "name"] } })

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ projection: { fields: ["id", "name", "tenantId"] } }))
    expect(result.rows).toEqual([{ id: "1", name: "a" }])
    expect(result.rowCount).toBe(1)
  })

  it("keeps the tenant field when the caller projected it explicitly", async () => {
    const findMany = vi.fn(async (): Promise<ListResult<Row>> => ({ rows: [{ id: "1", name: "a", tenantId: "tenant-a" }], rowCount: 1, page: 1, pageSize: 10 }))
    const provider = createTenantScopedPersistenceProvider({ dialect: "memory", capabilities, repository: () => makeRepo(findMany) } as unknown as PersistenceProvider, "tenant-a")

    const result = await testRepositoryForDescriptor(provider, entity).findMany({ projection: { fields: ["name", "tenantId"] } })

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ projection: { fields: ["name", "tenantId"] } }))
    expect(result.rows).toEqual([{ id: "1", name: "a", tenantId: "tenant-a" }])
  })

  it("still rejects a projected row from another tenant", async () => {
    const findMany = vi.fn(async (): Promise<ListResult<Row>> => ({ rows: [{ id: "1", name: "a", tenantId: "tenant-b" }], rowCount: 1, page: 1, pageSize: 10 }))
    const provider = createTenantScopedPersistenceProvider({ dialect: "memory", capabilities, repository: () => makeRepo(findMany) } as unknown as PersistenceProvider, "tenant-a")

    await expect(testRepositoryForDescriptor(provider, entity).findMany({ projection: { fields: ["name"] } })).rejects.toBeInstanceOf(TenantScopeViolationError)
  })
})

