import { describe, expect, it, vi } from "vitest"
import { Predicate } from "../../domain"
import { ImmutableFieldViolationError, TenantScopeViolationError } from "../../domain/errors"
import {
  createTenantScopedIdempotencyPort,
  createTenantScopedInteractiveTransactionProvider,
  createTenantScopedPersistenceProvider,
} from "../scoped"
import {
  supportsAtomicBatch,
  supportsTenantScopedAtomicBatch,
  supportsInteractiveTransactions,
  type AtomicBatchProvider,
  type AtomicBatchPlan,
  type TenantScopedAtomicBatchProvider,
  type TenantScopedAtomicBatchPlan,
  type EntityDescriptor,
  type InteractiveTransactionProvider,
  type ListResult,
  type PersistenceProvider,
} from "../provider"
import { testRepositoryForDescriptor as repositoryForDynamicDescriptor, type TestProviderFactory as PersistenceProviderFactory, type TestRepository as Repository } from "./persistenceTestSupport"

type Row = {
  id: string
  tenantId?: string
  createdBy?: string
  name: string
}

const entity: EntityDescriptor<Row> = {
  name: "row",
  primaryKey: "id",
  tenantField: "tenantId",
  immutableFields: ["createdBy"],
  fields: {
    id: { type: "string" },
    tenantId: { type: "string", nullable: true },
    createdBy: { type: "string", nullable: true },
    name: { type: "string" },
  },
}

function provider(repo: Repository<Row>): PersistenceProviderFactory {
  const result: PersistenceProviderFactory = {
    dialect: "memory",
    capabilities: {
      interactiveTransactions: false,
      atomicBatch: false,
      returningInsert: false,
      readSessions: false,
      jsonQueries: false,
      exactDecimal: false,
      persistentConnection: false,
    },
    forTenant: (tenantId) => createTenantScopedPersistenceProvider(result, tenantId),
    repository: () => repo,
  }
  return result
}

function repository(): { repo: Repository<Row>; updateOneWhere: NonNullable<Repository<Row>["updateOneWhere"]> & { mock: { calls: unknown[][] } } } {
  const updateOneWhere = vi.fn(async (): Promise<{ updatedCount: number }> => ({ updatedCount: 1 }))
  return {
    repo: {
    findById: vi.fn(async () => null),
    findOneWhere: vi.fn(async () => null),
    findMany: vi.fn(async (): Promise<ListResult<Row>> => ({ rows: [], rowCount: 0, page: 1, pageSize: 10 })),
    insert: vi.fn(async (data: Partial<Row>): Promise<Row> => ({ id: "row-1", name: "row", ...data })),
    update: vi.fn(async (id: string, data: Partial<Row>): Promise<Row> => ({ id, name: "row", ...data })),
    updateOneWhere,
    updateManyWhere: vi.fn(async () => 1),
    delete: vi.fn(async () => undefined),
    deleteWhere: vi.fn(async () => ({ deletedCount: 1 })),
    },
    updateOneWhere,
  }
}

function dynamicRepository(provider: PersistenceProvider, descriptor: EntityDescriptor<Row>): Repository<Row> {
  return repositoryForDynamicDescriptor(provider, descriptor)
}

describe("tenant-scoped persistence protections", () => {
  it("exposes tenant scoping as a first-class provider operation", async () => {
    const { repo } = repository()
    const tenantProvider = provider(repo).forTenant("tenant-a")

    await dynamicRepository(tenantProvider, entity).findById("row-1")

    expect((repo.findOneWhere as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual(
      Predicate.and(Predicate.eq("id", "row-1"), Predicate.eq("tenantId", "tenant-a")),
    )
  })

  it("rejects tenant-field mutation before reaching the adapter", async () => {
    const { repo, updateOneWhere } = repository()
    const scoped = createTenantScopedPersistenceProvider(provider(repo), "tenant-a")
    const scopedRepo = dynamicRepository(scoped, entity)

    await expect(scopedRepo.updateOneWhere!(Predicate.eq("id", "row-1"), { tenantId: "tenant-b" }))
      .rejects.toBeInstanceOf(TenantScopeViolationError)
    expect(updateOneWhere.mock.calls).toHaveLength(0)
  })

  it("protects immutable fields on tenant-scoped updates", async () => {
    const { repo, updateOneWhere } = repository()
    const scoped = createTenantScopedPersistenceProvider(provider(repo), "tenant-a")
    const scopedRepo = dynamicRepository(scoped, entity)

    await expect(scopedRepo.updateOneWhere!(Predicate.eq("id", "row-1"), { createdBy: "other-user" }))
      .rejects.toBeInstanceOf(ImmutableFieldViolationError)
    expect(updateOneWhere.mock.calls).toHaveLength(0)
  })

  it("protects immutable fields on global entities too", async () => {
    const { repo, updateOneWhere } = repository()
    const { tenantField: _tenantField, ...globalEntity } = entity
    const scoped = createTenantScopedPersistenceProvider(provider(repo), "tenant-a")
    expect(() => dynamicRepository(scoped, globalEntity)).toThrow(TenantScopeViolationError)
    expect(updateOneWhere.mock.calls).toHaveLength(0)
  })

  it("supports D1 atomic batches through a tenant-safe command encoder", async () => {
    const { repo } = repository()
    const plan: TenantScopedAtomicBatchPlan<string> = {
      items: [{ kind: "command", command: "opaque-command" }],
    }
    const executeAtomicBatch = vi.fn(async () => [])
    const base = {
      ...provider(repo),
      dialect: "d1",
      capabilities: { ...provider(repo).capabilities, atomicBatch: true },
      createTenantScopedCommandEncoder: () => ({
        tenantId: "tenant-a",
        encode: (command: string) => `${command}:tenant-a`,
      }),
      executeAtomicBatch,
    } as PersistenceProvider & AtomicBatchProvider
    const scoped = createTenantScopedPersistenceProvider(base, "tenant-a")

    expect(supportsTenantScopedAtomicBatch(scoped)).toBe(true)
    expect(supportsAtomicBatch(scoped)).toBe(true)
    expect(supportsTenantScopedAtomicBatch(scoped)).toBe(true)
    if (!supportsTenantScopedAtomicBatch(scoped)) throw new Error("expected tenant atomic batch provider")
    await expect(scoped.executeAtomicBatch(plan)).resolves.toEqual([])
    expect(executeAtomicBatch).toHaveBeenCalledWith(expect.objectContaining({
      items: [{ kind: "command", command: "opaque-command:tenant-a" }],
    }))
  })

  it("rejects atomic batches with malformed capability scopes", () => {
    const { repo } = repository()
    const executeAtomicBatch = vi.fn(async () => [])
    const malformed = {
      ...provider(repo),
      capabilities: { ...provider(repo).capabilities, atomicBatch: true, atomicBatchScope: "global" },
      executeAtomicBatch,
    } as unknown as PersistenceProvider

    expect(supportsAtomicBatch(malformed)).toBe(false)
    expect(supportsTenantScopedAtomicBatch(malformed)).toBe(false)
  })

  it("does not treat incomplete tenant-scoped providers as atomic-batch capable", () => {
    const { repo } = repository()
    const executeAtomicBatch = vi.fn(async () => [])
    const malformed = {
      ...provider(repo),
      capabilities: { ...provider(repo).capabilities, atomicBatch: true, atomicBatchScope: "tenant-scoped" },
      executeAtomicBatch,
    } as PersistenceProvider

    expect(supportsAtomicBatch(malformed)).toBe(false)
    expect(supportsTenantScopedAtomicBatch(malformed)).toBe(false)
  })

  it("accepts an explicitly unscoped atomic-batch provider", () => {
    const { repo } = repository()
    const providerWithUnscopedBatch = {
      ...provider(repo),
      capabilities: { ...provider(repo).capabilities, atomicBatch: true, atomicBatchScope: "unscoped" },
      executeAtomicBatch: vi.fn(async () => []),
    } as PersistenceProvider

    expect(supportsAtomicBatch(providerWithUnscopedBatch)).toBe(true)
    expect(supportsTenantScopedAtomicBatch(providerWithUnscopedBatch)).toBe(false)
  })

  it("rejects opaque atomic plans before reaching the D1 adapter", async () => {
    const { repo } = repository()
    const executeAtomicBatch = vi.fn(async () => [])
    const base = {
      ...provider(repo),
      dialect: "d1",
      capabilities: { ...provider(repo).capabilities, atomicBatch: true },
      executeAtomicBatch,
    } as PersistenceProvider & AtomicBatchProvider
    const scoped = createTenantScopedPersistenceProvider(base, "tenant-a")
    const opaquePlan: AtomicBatchPlan<unknown> = { items: [] }

    await expect((scoped as unknown as AtomicBatchProvider).executeAtomicBatch(opaquePlan)).rejects.toThrow(
      "adapter-owned command encoder",
    )
    expect(executeAtomicBatch).not.toHaveBeenCalled()
  })

  it("normalizes local infrastructure records and rejects forged cross-tenant records", async () => {
    const { repo } = repository()
    let forwardedPlan: AtomicBatchPlan<unknown> | undefined
    const executeAtomicBatch = vi.fn(async (batch: AtomicBatchPlan<unknown>) => {
      forwardedPlan = batch
      return batch.items.map((item) => ({ kind: item.kind, result: undefined }))
    })
    const base = {
      ...provider(repo),
      dialect: "d1",
      capabilities: { ...provider(repo).capabilities, atomicBatch: true },
      createTenantScopedCommandEncoder: () => ({
        tenantId: "tenant-a",
        encode: (command: unknown) => command,
      }),
      executeAtomicBatch,
    } as PersistenceProvider & AtomicBatchProvider
    const scoped = createTenantScopedPersistenceProvider(base, "tenant-a")
    if (!supportsTenantScopedAtomicBatch(scoped)) throw new Error("expected tenant atomic batch provider")
    const audit = {
      id: "audit-1",
      occurredAt: new Date(),
      action: "create",
      resourceType: "row",
      resourceId: "row-1",
      actor: { id: "user-1", kind: "human" as const, authentication: { kind: "authenticated" as const, method: "test", authenticatedAt: "2026-09-10T00:00:00.000Z" } },
      tenantId: null,
      oldValue: null,
      newValue: null,
    }
    const outbox = {
      id: "outbox-1",
      occurredAt: new Date(),
      type: "row.created",
      version: 1,
      scope: { kind: "tenant", tenantId: "tenant-a" } as const,
      scopeId: "fscope:v1:eyJraW5kIjoidGVuYW50IiwidGVuYW50SWQiOiJ0ZW5hbnQtYSJ9" as never,
      aggregateType: "row",
      aggregateId: "row-1",
      payload: {},
      idempotencyKey: "row-1",
    }
    const plan: TenantScopedAtomicBatchPlan<string> = {
      items: [
        { kind: "audit", record: audit },
        { kind: "outbox", record: outbox },
      ],
    }

    await expect(scoped.executeAtomicBatch(plan)).resolves.toEqual([
      { kind: "audit", result: undefined },
      { kind: "outbox", result: undefined },
    ])
    const forwardedAudit = forwardedPlan?.items[0]
    const forwardedOutbox = forwardedPlan?.items[1]
    expect(forwardedAudit?.kind).toBe("audit")
    expect(forwardedOutbox?.kind).toBe("outbox")
    if (forwardedAudit?.kind === "audit") expect(forwardedAudit.record.tenantId).toBe("tenant-a")
    if (forwardedOutbox?.kind === "outbox") expect(forwardedOutbox.record.tenantId).toBe("tenant-a")

    await expect(scoped.executeAtomicBatch({
      ...plan,
      items: [{ kind: "outbox", record: { ...outbox, tenantId: "tenant-b" } }],
    })).rejects.toBeInstanceOf(TenantScopeViolationError)
    expect(executeAtomicBatch).toHaveBeenCalledTimes(1)
  })

  it("rejects foreign tenant idempotency commits before atomic delegation", async () => {
    const { repo } = repository()
    const executeAtomicBatch = vi.fn(async () => [])
    const base = {
      ...provider(repo),
      capabilities: { ...provider(repo).capabilities, atomicBatch: true },
      createTenantScopedCommandEncoder: () => ({ tenantId: "tenant-a", encode: (command: unknown) => command }),
      executeAtomicBatch,
    } as PersistenceProvider & AtomicBatchProvider
    const scoped = createTenantScopedPersistenceProvider(base, "tenant-a")
    if (!supportsTenantScopedAtomicBatch(scoped)) throw new Error("expected tenant atomic batch provider")

    await expect(scoped.executeAtomicBatch({
      items: [{
        kind: "idempotency",
        commit: { scope: "tenant:8:tenant-b:orders:create", key: "key", fingerprint: "fp", token: "token" },
      }],
    })).rejects.toBeInstanceOf(TenantScopeViolationError)
    expect(executeAtomicBatch).not.toHaveBeenCalled()
  })

  it("does not authorize delimiter-sharing tenant IDs", async () => {
    const { repo } = repository()
    const base = provider(repo)
    const tenantA = createTenantScopedPersistenceProvider(base, "a")
    const tenantAB = createTenantScopedPersistenceProvider(base, "a:b")

    const scopeForA = "tenant:1:a:orders:create"
    const scopeForAB = "tenant:3:a:b:orders:create"
    const portA = createTenantScopedIdempotencyPort<string, import("../../events/durability/idempotency").IdempotencyPort<string>>(
      { acquire: vi.fn(async () => ({ outcome: "acquired" as const, token: "token" })), renew: vi.fn(), complete: vi.fn() },
      tenantA.tenantId,
    )
    const portAB = createTenantScopedIdempotencyPort<string, import("../../events/durability/idempotency").IdempotencyPort<string>>(
      { acquire: vi.fn(async () => ({ outcome: "acquired" as const, token: "token" })), renew: vi.fn(), complete: vi.fn() },
      tenantAB.tenantId,
    )

    await expect(portA.acquire({ scope: scopeForA, key: "key", fingerprint: "fp" })).resolves.toMatchObject({ outcome: "acquired" })
    await expect(portA.acquire({ scope: scopeForAB, key: "key", fingerprint: "fp" })).rejects.toBeInstanceOf(TenantScopeViolationError)
    await expect(portA.acquire({ scope: "tenant:a:orders:create", key: "key", fingerprint: "fp" })).rejects.toBeInstanceOf(TenantScopeViolationError)
    await expect(portAB.acquire({ scope: scopeForAB, key: "key", fingerprint: "fp" })).resolves.toMatchObject({ outcome: "acquired" })
    await expect(portAB.acquire({ scope: scopeForA, key: "key", fingerprint: "fp" })).rejects.toBeInstanceOf(TenantScopeViolationError)
  })

  it("keeps repository writes tenant-scoped inside an atomic transaction", async () => {
    const { repo, updateOneWhere } = repository()
    const transactionBase = {
      ...provider(repo),
      capabilities: { ...provider(repo).capabilities, interactiveTransactions: true, atomicBatch: true },
      executeAtomicBatch: async () => [],
      runInTransaction: async (work: (scoped: PersistenceProvider) => Promise<unknown>) => work(transactionBase),
    } as InteractiveTransactionProvider & AtomicBatchProvider
    const scoped = createTenantScopedInteractiveTransactionProvider(transactionBase, "tenant-a")

    await scoped.runInTransaction(async (transactionScoped) => {
      await dynamicRepository(transactionScoped, entity).updateOneWhere!(Predicate.eq("id", "row-1"), { name: "updated" })
    })

    expect(updateOneWhere).toHaveBeenCalledWith(
      Predicate.and(Predicate.eq("id", "row-1"), Predicate.eq("tenantId", "tenant-a")),
      { name: "updated" },
      undefined,
    )
  })

  it("preserves interactive transactions and capabilities on transaction-scoped providers", async () => {
    const { repo } = repository()
    const transactionBase = {
      ...provider(repo),
      capabilities: { ...provider(repo).capabilities, interactiveTransactions: true, atomicBatch: true },
      createTenantScopedCommandEncoder: () => ({
        tenantId: "tenant-a",
        encode: (command: unknown) => command,
      }),
      executeAtomicBatch: async () => [],
      runInTransaction: async (work) => work(transactionBase),
    } as InteractiveTransactionProvider & AtomicBatchProvider
    const scoped = createTenantScopedInteractiveTransactionProvider(transactionBase, "tenant-a")

    expect(supportsInteractiveTransactions(scoped)).toBe(true)
    expect(supportsAtomicBatch(scoped)).toBe(true)
    await expect(scoped.runInTransaction(async (transactionScoped) => {
      expect(supportsInteractiveTransactions(transactionScoped)).toBe(true)
       expect(supportsTenantScopedAtomicBatch(transactionScoped)).toBe(true)
      return "completed"
    })).resolves.toBe("completed")
  })

  it("applies tenant scope consistently to reads, inserts, and deletes", async () => {
    const { repo } = repository()
    const scopedRepo = dynamicRepository(createTenantScopedPersistenceProvider(provider(repo), "tenant-a"), entity)

    await scopedRepo.findById("row-1")
    await scopedRepo.findOneWhere!(Predicate.eq("name", "row"))
    await scopedRepo.findMany({ filter: Predicate.eq("name", "row") })
    await scopedRepo.insert({ name: "new" })
    await scopedRepo.deleteWhere!(Predicate.eq("name", "old"))

    const mocks = repo as unknown as {
      findOneWhere: ReturnType<typeof vi.fn>
      findMany: ReturnType<typeof vi.fn>
      insert: ReturnType<typeof vi.fn>
      deleteWhere: ReturnType<typeof vi.fn>
    }
    expect(mocks.findOneWhere).toHaveBeenNthCalledWith(1, Predicate.and(Predicate.eq("id", "row-1"), Predicate.eq("tenantId", "tenant-a")))
    expect(mocks.findOneWhere).toHaveBeenNthCalledWith(2, Predicate.and(Predicate.eq("name", "row"), Predicate.eq("tenantId", "tenant-a")))
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      filter: Predicate.and(Predicate.eq("name", "row"), Predicate.eq("tenantId", "tenant-a")),
    }))
    expect(mocks.insert).toHaveBeenCalledWith({ name: "new", tenantId: "tenant-a" })
    expect(mocks.deleteWhere).toHaveBeenCalledWith(Predicate.and(Predicate.eq("name", "old"), Predicate.eq("tenantId", "tenant-a")), undefined)
  })

  it.each([
    ["updateOneWhere", "updateOneWhere"],
    ["updateManyWhere", "updateManyWhere"],
    ["deleteWhere", "deleteWhere"],
  ] as const)("rejects %s when the adapter omits the capability", async (_name, method) => {
    const { repo } = repository()
    delete repo[method]
    const scopedRepo = dynamicRepository(createTenantScopedPersistenceProvider(provider(repo), "tenant-a"), entity)
    const operation = method === "updateOneWhere"
      ? scopedRepo.updateOneWhere!(Predicate.eq("name", "row"), { name: "updated" })
      : method === "updateManyWhere"
        ? scopedRepo.updateManyWhere!(Predicate.eq("name", "row"), { name: "updated" })
        : scopedRepo.deleteWhere!(Predicate.eq("name", "row"))
    await expect(operation).rejects.toBeInstanceOf(Error)
    await expect(operation).rejects.toThrow("not supported")
  })

  it("supports idempotent scoped deletes when no row was deleted", async () => {
    const { repo } = repository()
    repo.deleteWhere = vi.fn(async () => ({ deletedCount: 0 }))
    const scopedRepo = dynamicRepository(createTenantScopedPersistenceProvider(provider(repo), "tenant-a"), entity)

    await expect(scopedRepo.delete("row-1", { idempotent: true })).resolves.toBeUndefined()
    await expect(scopedRepo.delete("row-1")).rejects.toBeInstanceOf(Error)
  })
})
