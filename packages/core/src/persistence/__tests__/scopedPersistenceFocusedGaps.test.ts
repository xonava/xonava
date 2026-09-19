import { describe, expect, expectTypeOf, it, vi } from "vitest"
import { Predicate } from "../../domain"
import { ConfigurationError, ImmutableFieldViolationError, NotFoundError, TenantScopeViolationError, UnsupportedCapabilityError } from "../../domain/errors"
import { createTenantScopedPersistenceProvider } from "../scoped"
import { assertMatchingPersistenceScope, isTenantScopedPersistenceProvider, type EntityDescriptor, type PersistenceProvider, type UnversionedEntityDescriptor, type UnversionedRepository, type VersionedEntityDescriptor, type VersionedRepository } from "../provider"
import { testRepositoryForDescriptor as repositoryForDynamicDescriptor, type TestProviderFactory as PersistenceProviderFactory, type TestRepository as Repository } from "./persistenceTestSupport"

type Row = { id: string; tenantId: string; version?: number; createdBy?: string; name: string }
const occ = { optimisticConcurrency: { expectedVersion: 1 } }
const entity: EntityDescriptor<Row> = { name: "row", primaryKey: "id", tenantField: "tenantId", versionField: "version", immutableFields: ["createdBy"], fields: { id: { type: "string" }, tenantId: { type: "string" }, version: { type: "number" }, createdBy: { type: "string", nullable: true }, name: { type: "string" } } }
function makeRepo(overrides: Partial<Repository<Row>> = {}): Repository<Row> {
  return { findById: vi.fn(async (): Promise<Row | null> => null), findMany: vi.fn(async () => ({ rows: [] as Row[], rowCount: 0, page: 1, pageSize: 1 })), insert: vi.fn(async (data: Partial<Row>): Promise<Row> => ({ id: "1", name: "n", tenantId: "tenant-a", version: 1, ...data })), update: vi.fn(), delete: vi.fn(), ...overrides }
}
function makeProvider(repo: Repository<Row>, extras: Record<string, unknown> = {}): PersistenceProvider {
  const result = { dialect: "memory", capabilities: { interactiveTransactions: false, atomicBatch: false, returningInsert: false, readSessions: false, jsonQueries: false, exactDecimal: false, persistentConnection: false }, repository: (() => repo) as PersistenceProvider["repository"], ...extras }
  return result
}
function dynamicRepository(provider: PersistenceProvider, descriptor: EntityDescriptor<Row>): Repository<Row> {
  return repositoryForDynamicDescriptor(provider, descriptor)
}

describe("scoped persistence fallback and failure paths", () => {
  it("keeps repository writes narrowed to statically known descriptor policy", () => {
    const provider = makeProvider(makeRepo())
    const versioned: VersionedEntityDescriptor<Row> = entity as VersionedEntityDescriptor<Row>
    const unversioned: UnversionedEntityDescriptor<Row> = { ...entity, versionField: undefined } as UnversionedEntityDescriptor<Row>

    expectTypeOf(provider.repository(versioned)).toMatchTypeOf<VersionedRepository<Row>>()
    expectTypeOf(provider.repository(unversioned)).toMatchTypeOf<UnversionedRepository<Row>>()
    // A descriptor whose version policy is only known at runtime must use the
    // explicit framework-owned dispatch helper instead of exposing optional OCC.
    // @ts-expect-error broad descriptors must not expose a catch-all repository
    provider.repository(entity)
    expectTypeOf(repositoryForDynamicDescriptor(provider, entity)).toMatchTypeOf<Repository<Row>>()
  })

  it("rejects cross-tenant rescoping but preserves same-tenant identity", () => {
    const base = makeProvider(makeRepo())
    const scoped = createTenantScopedPersistenceProvider(base, "tenant-a")

    expect(() => createTenantScopedPersistenceProvider(base, "tenant-b")).not.toThrow()
    expect(scoped).not.toHaveProperty("forTenant")
    expectTypeOf<typeof scoped>().not.toMatchTypeOf<PersistenceProviderFactory>()
    expect(() => createTenantScopedPersistenceProvider(scoped, "tenant-b")).toThrow(TenantScopeViolationError)
    expect(createTenantScopedPersistenceProvider(scoped, "tenant-a")).toBe(scoped)
  })

  it("does not trust an unbranded tenantId property", async () => {
    const repo = makeRepo({ findMany: vi.fn(async () => ({ rows: [{ id: "1", tenantId: "tenant-b", name: "foreign" }], rowCount: 1, page: 1, pageSize: 1 })) })
    const spoofed = makeProvider(repo, { tenantId: "tenant-a" })
    const scoped = createTenantScopedPersistenceProvider(spoofed, "tenant-a")
    await expect(dynamicRepository(scoped, entity).findById("1")).rejects.toBeInstanceOf(TenantScopeViolationError)
  })

  it("keeps the core tenant marker private and provider identity immutable", () => {
    const base = makeProvider(makeRepo())
    const scoped = createTenantScopedPersistenceProvider(base, "tenant-a")
    const reflectedSymbols = Object.getOwnPropertySymbols(scoped)
    const forged = { ...base, tenantId: "tenant-a", ...(reflectedSymbols[0] ? { [reflectedSymbols[0]]: true } : {}) }

    expect(reflectedSymbols).toEqual([])
    expect(isTenantScopedPersistenceProvider(forged)).toBe(false)
    expect(() => assertMatchingPersistenceScope(scoped, forged)).toThrow(TenantScopeViolationError)
    expect(Object.isFrozen(scoped)).toBe(true)
    expect(() => { (scoped as { tenantId: string }).tenantId = "tenant-b" }).toThrow()
  })

  it("requires expectedVersion for every versioned scoped mutation", async () => {
    const repo = makeRepo({ deleteWhere: vi.fn(async () => ({ deletedCount: 1 })) })
    const scoped = dynamicRepository(createTenantScopedPersistenceProvider(makeProvider(repo), "tenant-a"), entity)

    await expect(scoped.update("1", { name: "x" })).rejects.toThrow("expectedVersion")
    await expect(scoped.delete("1")).rejects.toThrow("expectedVersion")
  })

  it("physically omits versioned bulk updates", () => {
    const updateManyWhere = vi.fn()
    const scopedProvider = createTenantScopedPersistenceProvider(
      makeProvider(makeRepo({ updateManyWhere })),
      "tenant-a",
    )
    const scoped = dynamicRepository(scopedProvider, entity)

    expect(scoped).not.toHaveProperty("updateManyWhere")
    expect(updateManyWhere).not.toHaveBeenCalled()
  })

  it.each([
    ["primary key", { id: "other" }, ImmutableFieldViolationError],
    ["version", { version: 2 }, ImmutableFieldViolationError],
    ["tenant", { tenantId: "tenant-b" }, TenantScopeViolationError],
    ["immutable", { createdBy: "other" }, ImmutableFieldViolationError],
  ] as const)("rejects protected %s fields on every scoped update path", async (_field, patch, error) => {
    const update = vi.fn()
    const updateOneWhere = vi.fn()
    const updateManyWhere = vi.fn()
    const repo = makeRepo({ update, updateOneWhere, updateManyWhere })
    const scoped = dynamicRepository(createTenantScopedPersistenceProvider(makeProvider(repo), "tenant-a"), entity)

    await expect(scoped.update("1", patch)).rejects.toBeInstanceOf(error)
    await expect(scoped.updateOneWhere!(Predicate.alwaysTrue(), patch)).rejects.toBeInstanceOf(error)
    expect(update).not.toHaveBeenCalled()
    expect(updateOneWhere).not.toHaveBeenCalled()
    expect(updateManyWhere).not.toHaveBeenCalled()
  })

  it("applies protected-field validation to non-tenant scoped wrappers", async () => {
    const update = vi.fn()
    const updateOneWhere = vi.fn()
    const updateManyWhere = vi.fn()
    const repo = makeRepo({ update, updateOneWhere, updateManyWhere })
    const { tenantField: _tenantField, ...globalEntity } = entity
    expect(() => dynamicRepository(createTenantScopedPersistenceProvider(makeProvider(repo), "tenant-a"), globalEntity))
      .toThrow(TenantScopeViolationError)
    expect(update).not.toHaveBeenCalled()
    expect(updateOneWhere).not.toHaveBeenCalled()
    expect(updateManyWhere).not.toHaveBeenCalled()
  })

  it("falls back to findMany for reads and requires exact-row update semantics", async () => {
    const repo = makeRepo({ findMany: vi.fn(async () => ({ rows: [{ id: "1", tenantId: "tenant-a", name: "n" }], rowCount: 1, page: 1, pageSize: 1 })) })
    const scoped = dynamicRepository(createTenantScopedPersistenceProvider(makeProvider(repo), "tenant-a"), entity)
    await expect(scoped.findById("1")).resolves.toEqual(expect.objectContaining({ id: "1" }))
    await expect(scoped.findOneWhere!(Predicate.alwaysTrue())).resolves.toEqual(expect.objectContaining({ id: "1" }))

    // Without updateOneWhereReturning, an exact post-mutation row cannot be
    // guaranteed; the update-then-read fallback could observe a concurrent
    // writer and is refused.
    const updateOneWhere = vi.fn(async () => ({ updatedCount: 0 }))
    const updateRepo = makeRepo({ updateOneWhere })
    const updateScoped = dynamicRepository(createTenantScopedPersistenceProvider(makeProvider(updateRepo), "tenant-a"), entity)
    await expect(updateScoped.update("1", { name: "x" }, occ)).rejects.toBeInstanceOf(UnsupportedCapabilityError)
    expect(updateOneWhere).not.toHaveBeenCalled()

    const updateOneWhereReturning = vi.fn<() => Promise<Row | null>>(async () => null)
    const returningRepo = makeRepo({ updateOneWhereReturning })
    const returningScoped = dynamicRepository(createTenantScopedPersistenceProvider(makeProvider(returningRepo), "tenant-a"), entity)
    await expect(returningScoped.update("1", { name: "x" }, occ)).rejects.toBeInstanceOf(NotFoundError)
    updateOneWhereReturning.mockResolvedValue({ id: "1", tenantId: "tenant-a", name: "x" })
    await expect(returningScoped.update("1", { name: "x" }, occ)).resolves.toEqual(expect.objectContaining({ name: "x" }))
  })

  it("uses the inferred id and returns the exact post-mutation row from a scoped update", async () => {
    const repo = makeRepo({ findMany: vi.fn(async () => ({ rows: [{ id: "1", tenantId: "tenant-a", name: "updated" }], rowCount: 1, page: 1, pageSize: 1 })), updateOneWhereReturning: vi.fn(async () => ({ id: "1", tenantId: "tenant-a", name: "updated" })) })
    delete repo.findOneWhere
    const { primaryKey: _primaryKey, ...inferredEntity } = entity
    const scoped = dynamicRepository(createTenantScopedPersistenceProvider(makeProvider(repo), "tenant-a"), inferredEntity)
    await expect(scoped.findById("1")).resolves.toEqual(expect.objectContaining({ id: "1" }))
    await expect(scoped.update("1", { name: "updated" }, occ)).resolves.toEqual(expect.objectContaining({ name: "updated" }))
  })

  it("supports successful scoped deletes and preserves explicit tenant values", async () => {
    const deleteWhere = vi.fn(async () => ({ deletedCount: 1 }))
    const insert = vi.fn(async (data: Partial<Row>): Promise<Row> => ({ id: "1", name: "n", tenantId: "tenant-a", ...data }))
    const repo = makeRepo({ deleteWhere, insert })
    const scoped = dynamicRepository(createTenantScopedPersistenceProvider(makeProvider(repo), "tenant-a"), entity)

    await expect(scoped.delete("1", occ)).resolves.toBeUndefined()
    await expect(scoped.insert({ name: "created", tenantId: "tenant-a" })).resolves.toMatchObject({ tenantId: "tenant-a" })
    expect(deleteWhere).toHaveBeenCalledOnce()
    expect(insert).toHaveBeenCalledWith({ name: "created", tenantId: "tenant-a" })
  })

  it("rejects unsupported scoped operations and missing primary-key capabilities", async () => {
    const repo = makeRepo()
    delete repo.updateOneWhere
    delete repo.updateManyWhere
    delete repo.deleteWhere
    const scoped = dynamicRepository(createTenantScopedPersistenceProvider(makeProvider(repo), "tenant-a"), entity)
    await expect(scoped.update("1", { name: "x" }, occ)).rejects.toBeInstanceOf(UnsupportedCapabilityError)
    await expect(scoped.updateOneWhere!(Predicate.alwaysTrue(), { name: "x" }, occ)).rejects.toBeInstanceOf(ConfigurationError)
    expect(scoped).not.toHaveProperty("updateManyWhere")
    await expect(scoped.delete("1", occ)).rejects.toBeInstanceOf(UnsupportedCapabilityError)
    await expect(scoped.deleteWhere!(Predicate.alwaysTrue(), occ)).rejects.toBeInstanceOf(ConfigurationError)
  })

  it("rejects always-true destructive filters unconditionally", async () => {
    const deleteWhere = vi.fn(async () => ({ deletedCount: 1 }))
    const repo = makeRepo({ deleteWhere })
    const scoped = dynamicRepository(createTenantScopedPersistenceProvider(makeProvider(repo), "tenant-a"), entity)

    await expect(scoped.deleteWhere!(Predicate.alwaysTrue(), occ)).rejects.toThrow("cannot target every row")
    expect(deleteWhere).not.toHaveBeenCalled()
  })

  it("uses canonical predicate tautology detection for destructive filters", async () => {
    const deleteWhere = vi.fn(async () => ({ deletedCount: 1 }))
    const repo = makeRepo({ deleteWhere })
    const scoped = dynamicRepository(createTenantScopedPersistenceProvider(makeProvider(repo), "tenant-a"), entity)
    const tautologies = [
      Predicate.or(Predicate.eq("name", "x"), Predicate.literal(true)),
      Predicate.not(Predicate.literal(false)),
      Predicate.and(Predicate.literal(true), Predicate.and()),
    ]

    for (const filter of tautologies) {
      await expect(scoped.deleteWhere!(filter, occ)).rejects.toThrow("cannot target every row")
    }
    expect(deleteWhere).not.toHaveBeenCalled()
  })

  it("rejects protected fields in scoped insert and bulkInsert rows", async () => {
    const insert = vi.fn(async (data: Partial<Row>): Promise<Row> => ({ id: "1", name: "n", tenantId: "tenant-a", ...data }))
    const bulkInsert = vi.fn(async (rows: Partial<Row>[]) => rows.map((row) => ({ id: "1", name: "n", tenantId: "tenant-a", ...row })))
    const repo = makeRepo({ insert, bulkInsert })
    const scoped = dynamicRepository(createTenantScopedPersistenceProvider(makeProvider(repo), "tenant-a"), entity)

    await expect(scoped.insert({ name: "x", tenantId: "tenant-b" })).rejects.toBeInstanceOf(TenantScopeViolationError)
    await expect(scoped.bulkInsert!([{ id: "1", name: "x", tenantId: "tenant-b" }])).rejects.toBeInstanceOf(TenantScopeViolationError)
    expect(insert).not.toHaveBeenCalled()
    expect(bulkInsert).not.toHaveBeenCalled()

    await expect(scoped.insert({ name: "x", tenantId: "tenant-a" })).resolves.toMatchObject({ tenantId: "tenant-a" })
    await expect(scoped.bulkInsert!([{ id: "1", name: "x", tenantId: "tenant-a" }])).rejects.toBeInstanceOf(ImmutableFieldViolationError)
    await expect(scoped.bulkInsert!([{ name: "x", tenantId: "tenant-a", version: 2 }])).rejects.toBeInstanceOf(ImmutableFieldViolationError)
    await expect(scoped.bulkInsert!([{ name: "x", tenantId: "tenant-a", createdBy: "other" }])).rejects.toBeInstanceOf(ImmutableFieldViolationError)
    expect(insert).toHaveBeenCalledWith({ name: "x", tenantId: "tenant-a" })
  })

  it("wraps transactions and bulk inserts while rejecting forged tenant records", async () => {
    const repo = makeRepo({ bulkInsert: vi.fn(async (rows: Partial<Row>[]) => rows.map((row) => ({ id: "1", name: "n", tenantId: "tenant-a", ...row }))) })
    const transaction = vi.fn(async (work: (provider: PersistenceProvider) => Promise<unknown>) => work(makeProvider(repo)))
    const scoped = createTenantScopedPersistenceProvider(makeProvider(repo, { runInTransaction: transaction }), "tenant-a")
    await dynamicRepository(scoped, entity).bulkInsert!([{ name: "x", tenantId: "tenant-a" }])
    await (scoped as unknown as PersistenceProvider & { runInTransaction: typeof transaction }).runInTransaction(async (tx) => dynamicRepository(tx, entity).findMany())
    expect(transaction).toHaveBeenCalledOnce()

    const atomic = vi.fn(async () => [])
    const noEncoder = createTenantScopedPersistenceProvider(makeProvider(repo, { capabilities: { ...makeProvider(repo).capabilities, atomicBatch: true }, executeAtomicBatch: atomic }), "tenant-a")
    await expect((noEncoder as unknown as { executeAtomicBatch: (plan: unknown) => Promise<unknown> }).executeAtomicBatch({ items: [] })).rejects.toThrow("command encoder")

    const globalRepo = makeRepo({ update: vi.fn(async (id: string, data: Partial<Row>): Promise<Row> => ({ id, name: "n", tenantId: "tenant-a", ...data })), updateOneWhere: vi.fn(async () => ({ updatedCount: 1 })), updateManyWhere: vi.fn(async () => 1) })
    const { tenantField: _tenantField, ...globalEntity } = entity
    expect(() => dynamicRepository(createTenantScopedPersistenceProvider(makeProvider(globalRepo), "tenant-a"), globalEntity))
      .toThrow(TenantScopeViolationError)

    const { primaryKey: _fallbackPrimaryKey, ...fallbackEntity } = globalEntity
    expect(() => dynamicRepository(createTenantScopedPersistenceProvider(makeProvider(globalRepo), "tenant-a"), fallbackEntity))
      .toThrow(TenantScopeViolationError)
  })

  it("preserves a same-tenant transaction-local provider", async () => {
    const repo = makeRepo()
    const transactionLocal = createTenantScopedPersistenceProvider(makeProvider(repo), "tenant-a")
    const transaction = vi.fn(async (work: (provider: PersistenceProvider) => Promise<unknown>) => work(transactionLocal))
    const scoped = createTenantScopedPersistenceProvider(makeProvider(repo, { runInTransaction: transaction }), "tenant-a")

    await (scoped as unknown as PersistenceProvider & { runInTransaction: typeof transaction }).runInTransaction(async (tx) => {
      expect(tx).toBe(transactionLocal)
      await dynamicRepository(tx, entity).findMany()
    })

    expect(transaction).toHaveBeenCalledOnce()
  })
})
