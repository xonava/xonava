import { describe, expect, it, vi } from "vitest"
import { encodeExecutionScopeId, Predicate, type ExecutionScope } from "../../domain"
import {
  ConfigurationError,
  ImmutableFieldViolationError,
  NotFoundError,
  TenantScopeViolationError,
  UnsupportedCapabilityError,
} from "../../domain/errors"
import type { AuditRecord } from "../../events/durability/audit"
import type { OutboxRecord } from "../../events/durability/outbox"
import {
  assertTenantCacheTag,
  assertTenantIdempotencyScope,
  createTenantScopedIdempotencyPort,
  createTenantScopedInteractiveTransactionProvider,
  createTenantScopedPersistenceProvider,
  encodeTenantCacheTag,
  encodeTenantIdempotencyScope,
} from "../scoped"
import type {
  AtomicBatchPlan,
  EntityDescriptor,
  InteractiveTransactionProvider,
  PersistenceProvider,
} from "../provider"
import { testRepositoryForDescriptor, type TestRepository } from "./persistenceTestSupport"

type Row = { id?: string; tenantId?: string; version?: number; createdBy?: string; name?: string }

const allFields: EntityDescriptor<Row>["fields"] = {
  id: { type: "string" },
  tenantId: { type: "string" },
  version: { type: "number" },
  createdBy: { type: "string", nullable: true },
  name: { type: "string" },
}

const plain: EntityDescriptor<Row> = {
  name: "plain",
  tenantField: "tenantId",
  fields: allFields,
}
const versioned: EntityDescriptor<Row> = {
  name: "ver",
  primaryKey: "id",
  tenantField: "tenantId",
  versionField: "version",
  immutableFields: ["createdBy"],
  fields: {
    id: { type: "string" },
    tenantId: { type: "string" },
    version: { type: "number" },
    createdBy: { type: "string", nullable: true },
    name: { type: "string" },
  },
}
const globalEntity: EntityDescriptor<Row> = { name: "globalThing", primaryKey: "id", fields: allFields }

const capabilities = {
  interactiveTransactions: false,
  atomicBatch: false,
  returningInsert: false,
  readSessions: false,
  jsonQueries: false,
  exactDecimal: false,
  persistentConnection: false,
}

function repo(overrides: Partial<TestRepository<Row>> = {}): TestRepository<Row> {
  return {
    findById: vi.fn(async () => null),
    findMany: vi.fn(async () => ({ rows: [] as Row[], rowCount: 0, page: 1, pageSize: 1 })),
    insert: vi.fn(async (data: Partial<Row>) => data as Row),
    update: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  }
}

function provider(r: TestRepository<Row>, extras: Record<string, unknown> = {}): PersistenceProvider {
  return { dialect: "memory", capabilities, repository: (() => r) as PersistenceProvider["repository"], ...extras }
}

function scopedRepo(r: TestRepository<Row>, entity: EntityDescriptor<Row>, tenantId = "tenant-a"): TestRepository<Row> {
  return testRepositoryForDescriptor<Row>(createTenantScopedPersistenceProvider(provider(r), tenantId), entity)
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("expected rejection")
}

function caughtSync(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error("expected throw")
}

const occ = { optimisticConcurrency: { expectedVersion: 1 } }
const scopeAndId = (tenantId: string): { scope: ExecutionScope; scopeId: ReturnType<typeof encodeExecutionScopeId> } => {
  const scope: ExecutionScope = { kind: "tenant", tenantId }
  return { scope, scopeId: encodeExecutionScopeId(scope) }
}

describe("scoped persistence primary key defaulting", () => {
  it("falls back to the id column for reads and rejects id mutation when the descriptor has no primary key", async () => {
    const findOneWhere = vi.fn(async () => null)
    const scoped = scopedRepo(repo({ findOneWhere }), plain)

    await scoped.findById("x")
    expect(findOneWhere).toHaveBeenCalledWith(Predicate.and(Predicate.eq("id", "x"), Predicate.eq("tenantId", "tenant-a")))

    const error = await caught(scoped.update("x", { id: "y" }))
    expect(error).toBeInstanceOf(ImmutableFieldViolationError)
    expect((error as Error).message).toBe('Cannot mutate primary key field "id" on entity "plain".')
  })

  it("reads through findMany with a single-row offset page when the adapter lacks findOneWhere", async () => {
    const findMany = vi.fn(async () => ({ rows: [{ id: "x", tenantId: "tenant-a" }], rowCount: 1, page: 1, pageSize: 1 }))
    const scoped = scopedRepo(repo({ findMany }), plain)

    await expect(scoped.findById("x")).resolves.toEqual({ id: "x", tenantId: "tenant-a" })
    const filter = Predicate.and(Predicate.eq("id", "x"), Predicate.eq("tenantId", "tenant-a"))
    expect(findMany).toHaveBeenLastCalledWith({ filter, pagination: { kind: "offset", page: 1, pageSize: 1 } })

    const where = Predicate.eq("name", "n")
    await scoped.findOneWhere!(where)
    expect(findMany).toHaveBeenLastCalledWith({
      filter: Predicate.and(where, Predicate.eq("tenantId", "tenant-a")),
      pagination: { kind: "offset", page: 1, pageSize: 1 },
    })
  })
})

describe("scoped persistence write guard messages", () => {
  it("reports exact messages for tenant, immutable, primary key and version field mutations", async () => {
    const scoped = scopedRepo(repo(), versioned)

    const tenant = await caught(scoped.update("1", { tenantId: "tenant-b" }, occ))
    expect(tenant).toBeInstanceOf(TenantScopeViolationError)
    expect((tenant as Error).message).toBe(
      'Cannot mutate tenant field "tenantId" on entity "ver" through update operations. Tenant assignment is managed by the framework.',
    )

    const immutable = await caught(scoped.update("1", { createdBy: "x" }, occ))
    expect(immutable).toBeInstanceOf(ImmutableFieldViolationError)
    expect((immutable as Error).message).toBe('Cannot mutate immutable field "createdBy" on entity "ver".')

    const pk = await caught(scoped.update("1", { id: "2" }, occ))
    expect((pk as Error).message).toBe('Cannot mutate primary key field "id" on entity "ver".')

    const version = await caught(scoped.update("1", { version: 9 }, occ))
    expect(version).toBeInstanceOf(ImmutableFieldViolationError)
    expect((version as Error).message).toBe('Cannot mutate version field "version" on entity "ver".')
  })

  it("accepts updates on entities with no immutable fields declared", async () => {
    const updateOneWhereReturning = vi.fn(async () => ({ id: "1", tenantId: "tenant-a", name: "n" }))
    const scoped = scopedRepo(repo({ updateOneWhereReturning }), plain)

    await expect(scoped.update("1", { name: "n" })).resolves.toEqual({ id: "1", tenantId: "tenant-a", name: "n" })
  })

  it("rejects an insert that names another tenant with an exact message and accepts the same tenant", async () => {
    const insert = vi.fn(async (data: Partial<Row>) => data as Row)
    const scoped = scopedRepo(repo({ insert }), plain)

    const error = await caught(scoped.insert({ tenantId: "tenant-b", name: "x" }))
    expect(error).toBeInstanceOf(TenantScopeViolationError)
    expect((error as Error).message).toBe(
      'Cannot insert into "plain" with tenant field "tenantId" set to "tenant-b" for tenant "tenant-a". Tenant assignment is managed by the framework.',
    )
    expect(insert).not.toHaveBeenCalled()

    await expect(scoped.insert({ tenantId: "tenant-a", name: "x" })).resolves.toEqual({ tenantId: "tenant-a", name: "x" })
  })

  it("rejects an adapter row outside the tenant with an exact message", async () => {
    const scoped = scopedRepo(repo({ findOneWhere: vi.fn(async () => ({ id: "1", tenantId: "tenant-b" })) }), plain)

    const error = await caught(scoped.findById("1"))
    expect(error).toBeInstanceOf(TenantScopeViolationError)
    expect((error as Error).message).toBe('Persistence adapter returned a row outside tenant "tenant-a" for entity "plain".')
  })

  it("rejects global entities with an exact message", () => {
    const scopedProvider = createTenantScopedPersistenceProvider(provider(repo()), "tenant-a")
    const error = caughtSync(() => testRepositoryForDescriptor<Row>(scopedProvider, globalEntity))
    expect(error).toBeInstanceOf(TenantScopeViolationError)
    expect((error as Error).message).toBe(
      'Global entity "globalThing" cannot be accessed through tenant-scoped persistence. Use an explicit platform-scoped provider and authorize the required global capability.',
    )
  })

  it("reports the rescoping tenants in the error message and freezes a tenant scope descriptor", () => {
    const base = createTenantScopedPersistenceProvider(provider(repo()), "tenant-a")
    const error = caughtSync(() => createTenantScopedPersistenceProvider(base, "tenant-b"))
    expect((error as Error).message).toBe('Cannot rescope tenant persistence from "tenant-a" to "tenant-b".')

    expect(base.scope).toEqual({ kind: "tenant", tenantId: "tenant-a" })
    expect(Object.isFrozen(base.scope)).toBe(true)
  })
})

describe("scoped persistence update paths", () => {
  it("reports unsupported update-by-id and not-found with exact messages and details", async () => {
    const unsupported = scopedRepo(repo(), plain)
    const error = await caught(unsupported.update("1", { name: "n" }))
    expect(error).toBeInstanceOf(UnsupportedCapabilityError)
    expect((error as Error).message).toBe(
      "Scoped update by ID is not supported by the plain repository adapter. " +
        "Exact post-mutation row semantics require updateOneWhereReturning; an update-then-read fallback could observe a concurrent writer.",
    )

    const missing = scopedRepo(repo({ updateOneWhereReturning: vi.fn(async () => null) }), plain)
    const notFound = await caught(missing.update("1", { name: "n" }))
    expect(notFound).toBeInstanceOf(NotFoundError)
    expect((notFound as Error).message).toBe("Scoped update failed: plain not found")
    expect((notFound as NotFoundError).details).toEqual({ entity: "plain", id: "1" })
  })

  it("scopes updateOneWhere, rejects unsafe input and unsupported adapters", async () => {
    const updateOneWhere = vi.fn(async () => ({ updatedCount: 1 }))
    const scoped = scopedRepo(repo({ updateOneWhere }), versioned)
    const filter = Predicate.eq("name", "a")

    await expect(scoped.updateOneWhere!(filter, { name: "b" }, occ)).resolves.toEqual({ updatedCount: 1 })
    expect(updateOneWhere).toHaveBeenCalledWith(Predicate.and(filter, Predicate.eq("tenantId", "tenant-a")), { name: "b" }, occ)

    const missingVersion = await caught(scoped.updateOneWhere!(filter, { name: "b" }))
    expect(missingVersion).toBeInstanceOf(ConfigurationError)
    expect((missingVersion as Error).message).toBe('Versioned entity "ver" requires optimisticConcurrency.expectedVersion')

    const unsupported = await caught(scopedRepo(repo(), plain).updateOneWhere!(filter, { name: "b" }))
    expect(unsupported).toBeInstanceOf(UnsupportedCapabilityError)
    expect((unsupported as Error).message).toBe("updateOneWhere is not supported by the plain repository adapter.")
  })

  it("scopes updateOneWhereReturning and verifies the returned row", async () => {
    const updateOneWhereReturning = vi.fn(async () => ({ id: "1", tenantId: "tenant-a", name: "b" }))
    const scoped = scopedRepo(repo({ updateOneWhereReturning }), versioned)
    const filter = Predicate.eq("name", "a")

    await expect(scoped.updateOneWhereReturning!(filter, { name: "b" }, occ)).resolves.toEqual({ id: "1", tenantId: "tenant-a", name: "b" })
    expect(updateOneWhereReturning).toHaveBeenCalledWith(Predicate.and(filter, Predicate.eq("tenantId", "tenant-a")), { name: "b" }, occ)

    updateOneWhereReturning.mockResolvedValueOnce(null as never)
    await expect(scoped.updateOneWhereReturning!(filter, { name: "b" }, occ)).resolves.toBeNull()

    updateOneWhereReturning.mockResolvedValueOnce({ id: "1", tenantId: "tenant-b" } as never)
    const foreign = await caught(scoped.updateOneWhereReturning!(filter, { name: "b" }, occ))
    expect((foreign as Error).message).toBe('Persistence adapter returned a row outside tenant "tenant-a" for entity "ver".')

    const tenantMutation = await caught(scoped.updateOneWhereReturning!(filter, { tenantId: "tenant-b" }, occ))
    expect(tenantMutation).toBeInstanceOf(TenantScopeViolationError)

    const unsafe = await caught(scoped.updateOneWhereReturning!(Predicate.alwaysTrue(), { name: "b" }, occ))
    expect(unsafe).toBeInstanceOf(ConfigurationError)
    expect((unsafe as Error).message).toBe("Destructive operations on ver cannot target every row.")

    const missingVersion = await caught(scoped.updateOneWhereReturning!(filter, { name: "b" }))
    expect((missingVersion as Error).message).toBe('Versioned entity "ver" requires optimisticConcurrency.expectedVersion')
    expect(updateOneWhereReturning).toHaveBeenCalledTimes(3)

    const unsupported = await caught(scopedRepo(repo(), plain).updateOneWhereReturning!(filter, { name: "b" }))
    expect(unsupported).toBeInstanceOf(UnsupportedCapabilityError)
    expect((unsupported as Error).message).toBe("updateOneWhereReturning is not supported by the plain repository adapter.")
  })

  it("scopes updateManyWhere and rejects invalid data, unsafe filters and unsupported adapters", async () => {
    const updateManyWhere = vi.fn(async () => 3)
    const scoped = scopedRepo(repo({ updateManyWhere }), plain)
    const filter = Predicate.eq("name", "a")

    await expect(scoped.updateManyWhere!(filter, { name: "b" })).resolves.toBe(3)
    expect(updateManyWhere).toHaveBeenCalledWith(Predicate.and(filter, Predicate.eq("tenantId", "tenant-a")), { name: "b" }, undefined)

    const tenantMutation = await caught(scoped.updateManyWhere!(filter, { tenantId: "tenant-b" }))
    expect(tenantMutation).toBeInstanceOf(TenantScopeViolationError)
    const unsafe = await caught(scoped.updateManyWhere!(Predicate.alwaysTrue(), { name: "b" }))
    expect((unsafe as Error).message).toBe("Destructive operations on plain cannot target every row.")
    expect(updateManyWhere).toHaveBeenCalledTimes(1)

    const unsupported = await caught(scopedRepo(repo(), plain).updateManyWhere!(filter, { name: "b" }))
    expect(unsupported).toBeInstanceOf(UnsupportedCapabilityError)
    expect((unsupported as Error).message).toBe(
      "updateManyWhere is not supported by the plain repository adapter. " +
        "Use a loop with individual updates or implement updateManyWhere on the adapter.",
    )
  })

  it("does not expose updateManyWhere for versioned entities", () => {
    expect(scopedRepo(repo({ updateManyWhere: vi.fn() }), versioned).updateManyWhere).toBeUndefined()
  })
})

describe("scoped persistence delete paths", () => {
  it("requires an expected version on versioned deletes but allows the terminal safe integer", async () => {
    const deleteWhere = vi.fn(async () => ({ deletedCount: 1 }))
    const scoped = scopedRepo(repo({ deleteWhere }), versioned)
    const terminal = { optimisticConcurrency: { expectedVersion: Number.MAX_SAFE_INTEGER } }

    const missing = await caught(scoped.delete("1"))
    expect((missing as Error).message).toBe('Versioned entity "ver" requires optimisticConcurrency.expectedVersion')
    const missingWhere = await caught(scoped.deleteWhere!(Predicate.eq("name", "a")))
    expect((missingWhere as Error).message).toBe('Versioned entity "ver" requires optimisticConcurrency.expectedVersion')
    expect(deleteWhere).not.toHaveBeenCalled()

    await expect(scoped.delete("1", terminal)).resolves.toBeUndefined()
    await expect(scoped.deleteWhere!(Predicate.eq("name", "a"), terminal)).resolves.toEqual({ deletedCount: 1 })
    expect(deleteWhere).toHaveBeenCalledTimes(2)
  })

  it("reports exact unsupported and not-found errors for deletes", async () => {
    const unsupported = scopedRepo(repo(), plain)
    const byId = await caught(unsupported.delete("1"))
    expect(byId).toBeInstanceOf(UnsupportedCapabilityError)
    expect((byId as Error).message).toBe("Scoped delete by ID is not supported by the plain repository adapter.")
    const where = await caught(unsupported.deleteWhere!(Predicate.eq("name", "a")))
    expect((where as Error).message).toBe("deleteWhere is not supported by the plain repository adapter.")

    const none = scopedRepo(repo({ deleteWhere: vi.fn(async () => ({ deletedCount: 0 })) }), plain)
    const notFound = await caught(none.delete("1"))
    expect(notFound).toBeInstanceOf(NotFoundError)
    expect((notFound as Error).message).toBe("Scoped delete failed: plain not found")
    expect((notFound as NotFoundError).details).toEqual({ entity: "plain", id: "1" })
    await expect(none.delete("1", { idempotent: true })).resolves.toBeUndefined()
  })
})

describe("scoped persistence bulk insert", () => {
  it("normalizes rows to the tenant, guards fields and verifies returned rows", async () => {
    const bulkInsert = vi.fn(async (rows: Partial<Row>[]) => rows as Row[])
    const scoped = scopedRepo(repo({ bulkInsert }), versioned)

    await expect(scoped.bulkInsert!([{ name: "a" }, { name: "b", tenantId: "tenant-a" }])).resolves.toEqual([
      { name: "a", tenantId: "tenant-a" },
      { name: "b", tenantId: "tenant-a" },
    ])
    expect(bulkInsert).toHaveBeenCalledWith([
      { name: "a", tenantId: "tenant-a" },
      { name: "b", tenantId: "tenant-a" },
    ])

    expect(((await caught(scoped.bulkInsert!([{ tenantId: "tenant-b" }]))) as Error).message).toContain('set to "tenant-b"')
    expect(await caught(scoped.bulkInsert!([{ id: "x" }]))).toBeInstanceOf(ImmutableFieldViolationError)
    expect(await caught(scoped.bulkInsert!([{ version: 1 }]))).toBeInstanceOf(ImmutableFieldViolationError)
    expect(await caught(scoped.bulkInsert!([{ createdBy: "x" }]))).toBeInstanceOf(ImmutableFieldViolationError)
    expect(bulkInsert).toHaveBeenCalledTimes(1)

    bulkInsert.mockResolvedValueOnce([{ id: "1", tenantId: "tenant-b" }])
    const foreign = await caught(scoped.bulkInsert!([{ name: "c" }]))
    expect((foreign as Error).message).toBe('Persistence adapter returned a row outside tenant "tenant-a" for entity "ver".')
  })

  it("only exposes bulkInsert when the adapter does", () => {
    expect(scopedRepo(repo(), plain)).not.toHaveProperty("bulkInsert")
  })
})

describe("scoped idempotency and cache tag attenuation", () => {
  it("reports the offending scope and tag in the error message", () => {
    const error = caughtSync(() => assertTenantIdempotencyScope("tenant:1:b", "a"))
    expect(error).toBeInstanceOf(TenantScopeViolationError)
    expect((error as Error).message).toBe('Cannot use idempotency scope "tenant:1:b" for tenant "a".')

    const tag = caughtSync(() => assertTenantCacheTag("global:x", "a"))
    expect((tag as Error).message).toBe('Cannot advance cache generation "global:x" for tenant "a".')
    expect(() => assertTenantCacheTag(encodeTenantCacheTag("a", "x"), "a")).not.toThrow()
  })

  it("rejects a non-string tag even when it coerces to a valid tenant tag", () => {
    const tag = { toString: () => encodeTenantCacheTag("a", "x") }
    const error = caughtSync(() => assertTenantCacheTag(tag as never, "a"))
    expect(error).toBeInstanceOf(TenantScopeViolationError)
  })

  it("rejects a boxed string tag that would otherwise decode as the tenant's", () => {
    const boxed = new String(encodeTenantCacheTag("a", "x"))
    expect(caughtSync(() => assertTenantCacheTag(boxed as never, "a"))).toBeInstanceOf(TenantScopeViolationError)
  })

  it("attenuates every base operation by scope and forwards valid calls", async () => {
    const base = {
      acquire: vi.fn(async () => "acquired"),
      renew: vi.fn(async () => "renewed"),
      complete: vi.fn(async () => "completed"),
      abandon: vi.fn(async () => "abandoned"),
      markCommittedInTransaction: vi.fn(async () => "marked"),
      createCommitBatchItem: vi.fn(() => "item"),
    }
    const port = createTenantScopedIdempotencyPort<string, never>(base as never, "a") as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    const ok = { scope: encodeTenantIdempotencyScope("a") }
    const bad = { scope: encodeTenantIdempotencyScope("b") }

    await expect(port.acquire!(ok)).resolves.toBe("acquired")
    await expect(port.renew!(ok)).resolves.toBe("renewed")
    await expect(port.complete!(ok)).resolves.toBe("completed")
    await expect(port.abandon!(ok)).resolves.toBe("abandoned")
    await expect(port.markCommittedInTransaction!(ok, {})).resolves.toBe("marked")
    expect(port.createCommitBatchItem!(ok)).toBe("item")

    for (const name of ["acquire", "renew", "complete", "abandon", "markCommittedInTransaction"]) {
      await expect(caught(port[name]!(bad, {}))).resolves.toBeInstanceOf(TenantScopeViolationError)
    }
    expect(caughtSync(() => port.createCommitBatchItem!(bad))).toBeInstanceOf(TenantScopeViolationError)
    for (const fn of Object.values(base)) expect(fn).toHaveBeenCalledTimes(1)
  })

  it("does not invent optional operations the base port lacks", () => {
    const base = { acquire: vi.fn(), renew: vi.fn(), complete: vi.fn() }
    const port = createTenantScopedIdempotencyPort<string, never>(base as never, "a")
    expect(port).not.toHaveProperty("abandon")
    expect(port).not.toHaveProperty("markCommittedInTransaction")
    expect(port).not.toHaveProperty("createCommitBatchItem")
  })
})

describe("scoped atomic batch normalisation", () => {
  function atomic(withEncoder = true): { scoped: PersistenceProvider; run: (item: AtomicBatchPlan<unknown>["items"][number]) => Promise<unknown>; execute: ReturnType<typeof vi.fn> } {
    const execute = vi.fn(async (plan: AtomicBatchPlan<unknown>) => plan.items)
    const base = {
      ...provider(repo()),
      capabilities: { ...capabilities, atomicBatch: true },
      ...(withEncoder ? { createTenantScopedCommandEncoder: (tenantId: string) => ({ tenantId, encode: (command: unknown) => ({ encoded: command }) }) } : {}),
      executeAtomicBatch: execute,
    } as unknown as PersistenceProvider
    const scoped = createTenantScopedPersistenceProvider(base, "tenant-a")
    const run = (item: AtomicBatchPlan<unknown>["items"][number]): Promise<unknown> =>
      (scoped as unknown as { executeAtomicBatch(plan: unknown): Promise<unknown> }).executeAtomicBatch({ items: [item] })
    return { scoped, run, execute }
  }

  const outbox = (target: { scope: ExecutionScope; scopeId: ReturnType<typeof encodeExecutionScopeId> }, extra: Partial<OutboxRecord> = {}): OutboxRecord => ({
    id: "o-1",
    occurredAt: new Date("2026-10-01T00:00:00.000Z"),
    type: "row.created",
    version: 1,
    scope: target.scope,
    scopeId: target.scopeId,
    aggregateType: "row",
    aggregateId: "r-1",
    payload: {},
    idempotencyKey: "r-1",
    ...extra,
  })
  const audit = (tenantId: string | null | undefined): AuditRecord => ({ id: "a-1", tenantId } as unknown as AuditRecord)

  it("requires an adapter command encoder and omits the encoder property when there is none", async () => {
    const { scoped, run } = atomic(false)
    expect(scoped).not.toHaveProperty("commandEncoder")
    const error = await caught(run({ kind: "command", command: {} } as never))
    expect(error).toBeInstanceOf(ConfigurationError)
    expect((error as Error).message).toBe("Tenant-scoped atomic batches require an adapter-owned command encoder.")
  })

  it("encodes commands and forwards cache-generation and idempotency items unchanged", async () => {
    const { run, execute } = atomic()
    const tag = encodeTenantCacheTag("tenant-a", "t")
    const commit = { scope: encodeTenantIdempotencyScope("tenant-a"), key: "k" }

    await run({ kind: "command", command: "c" } as never)
    await run({ kind: "cache-generation", tag } as never)
    await run({ kind: "idempotency", commit } as never)
    expect(execute.mock.calls.map((call) => (call[0] as AtomicBatchPlan<unknown>).items[0])).toEqual([
      { kind: "command", command: { encoded: "c" } },
      { kind: "cache-generation", tag },
      { kind: "idempotency", commit },
    ])

    const badTag = await caught(run({ kind: "cache-generation", tag: "tenant:1:b:t" } as never))
    expect((badTag as Error).message).toBe('Cannot advance cache generation "tenant:1:b:t" for tenant "tenant-a".')
    const badCommit = await caught(run({ kind: "idempotency", commit: { scope: encodeTenantIdempotencyScope("b") } } as never))
    expect((badCommit as Error).message).toContain('Cannot use idempotency scope "tenant:1:b" for tenant "tenant-a".')
    expect(execute).toHaveBeenCalledTimes(3)
  })

  it("normalises audit records, keeping a null or missing tenant assignable", async () => {
    const { run, execute } = atomic()
    await run({ kind: "audit", record: audit(undefined) })
    await run({ kind: "audit", record: audit(null) })
    await run({ kind: "audit", record: audit("tenant-a") })
    for (const call of execute.mock.calls) {
      expect((call[0] as AtomicBatchPlan<unknown>).items[0]).toMatchObject({ kind: "audit", record: { id: "a-1", tenantId: "tenant-a" } })
    }

    const foreign = await caught(run({ kind: "audit", record: audit("tenant-b") }))
    expect(foreign).toBeInstanceOf(TenantScopeViolationError)
    expect((foreign as Error).message).toBe('Cannot include audit record for tenant "tenant-b" in a batch for tenant "tenant-a".')
  })

  it("explains each way an outbox record can leave the tenant", async () => {
    const { run, execute } = atomic()
    const a = scopeAndId("tenant-a")
    const b = scopeAndId("tenant-b")
    const outside = 'Cannot include an outbox record outside tenant "tenant-a" in a batch for that tenant.'
    const provenanceMessage = 'Outbox record provenance does not target tenant "tenant-a".'

    const message = async (record: OutboxRecord): Promise<string> => ((await caught(run({ kind: "outbox", record }))) as Error).message

    expect(await message(outbox(a, { scope: undefined as never }))).toBe(outside)
    expect(await message(outbox(a, { scope: null as never }))).toBe(outside)
    expect(await message(outbox(a, { scope: "tenant-a" as never }))).toBe(outside)
    expect(await message(outbox(a, { scope: { kind: "platform", platformKey: "ops" } as never }))).toBe(outside)
    expect(await message(outbox(b))).toBe(outside)
    expect(await message(outbox({ scope: { kind: "platform", tenantId: "tenant-a" } as never, scopeId: a.scopeId }))).toBe(outside)
    expect(await message(outbox({ scope: a.scope, scopeId: b.scopeId }))).toBe("Outbox record scope identity does not match tenant \"tenant-a\".")

    expect(await message(outbox(a, { provenance: null as never }))).toBe(provenanceMessage)
    expect(await message(outbox(a, { provenance: {} as never }))).toBe(provenanceMessage)
    expect(await message(outbox(a, { provenance: { target: "x" } as never }))).toBe(provenanceMessage)
    expect(await message(outbox(a, { provenance: { target: { scope: { kind: "tenant" } } } as never }))).toBe(provenanceMessage)
    expect(await message(outbox(a, { provenance: { target: b } as never }))).toBe(provenanceMessage)
    expect(await message(outbox(a, { provenance: { target: { scope: a.scope, scopeId: b.scopeId } } as never }))).toBe(provenanceMessage)
    expect(await message(outbox(a, { provenance: { target: { scope: b.scope, scopeId: a.scopeId } } as never }))).toBe(provenanceMessage)
    expect(await message(outbox(a, { provenance: { target: { scope: a.scope } } as never }))).toBe(provenanceMessage)
    expect(await message(outbox(a, { tenantId: "tenant-b" }))).toBe('Cannot include outbox record for tenant "tenant-b" in a batch for tenant "tenant-a".')
    expect(execute).not.toHaveBeenCalled()

    await run({ kind: "outbox", record: outbox(a, { provenance: { target: a } as never }) })
    expect(execute).toHaveBeenCalledTimes(1)
  })
})

describe("scoped provider capability surface", () => {
  it("does not invent atomic batch or transaction entry points the base lacks", () => {
    const scoped = createTenantScopedPersistenceProvider(provider(repo()), "tenant-a")
    expect(scoped).not.toHaveProperty("executeAtomicBatch")
    expect(scoped).not.toHaveProperty("runInTransaction")
    expect(scoped).not.toHaveProperty("commandEncoder")
  })

  it("marks atomic batch capabilities tenant scoped only when the base supports them", () => {
    const withBatch = createTenantScopedPersistenceProvider(
      { ...provider(repo()), capabilities: { ...capabilities, atomicBatch: true } },
      "tenant-a",
    )
    expect(withBatch.capabilities.atomicBatchScope).toBe("tenant-scoped")
    expect(createTenantScopedPersistenceProvider(provider(repo()), "tenant-a").capabilities).toBe(capabilities)
  })

  it("wraps interactive transactions and rejects a base that loses the capability", async () => {
    const work = vi.fn(async (inner: PersistenceProvider) => inner)
    const runInTransaction = vi.fn(async (callback: (tx: PersistenceProvider) => Promise<unknown>) => callback(provider(repo())))
    const base = { ...provider(repo()), capabilities: { ...capabilities, interactiveTransactions: true }, runInTransaction } as unknown as InteractiveTransactionProvider

    const scoped = createTenantScopedInteractiveTransactionProvider(base, "tenant-a")
    const inner = await scoped.runInTransaction(work as never, { accessMode: "read only" })
    expect((inner as unknown as { tenantId: string }).tenantId).toBe("tenant-a")
    expect(runInTransaction).toHaveBeenCalledWith(expect.any(Function), { accessMode: "read only" })

    const lost = caughtSync(() => createTenantScopedInteractiveTransactionProvider(provider(repo()) as never, "tenant-a"))
    expect(lost).toBeInstanceOf(ConfigurationError)
    expect((lost as Error).message).toBe("Interactive transaction capability was lost while attenuating tenant persistence.")
  })
})
