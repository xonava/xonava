import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { evaluatePredicate, type PredicateNode } from "@xonava/core/domain"
import type { EntityDescriptor, PersistenceProvider } from "@xonava/core/persistence"
import { createDeleteHandler } from "../delete"
import { createUpdateHandler } from "../update"
import { sameMutationVersion } from "../shared"
import type { CrudShared } from "../types"
import { allowAllAbacBundle, allowAllModuleFacts, canonicalRequestNormalization, trustedSession } from "../../__tests__/canonicalRequest"

type TestRow = {
  id: string
  tenantId: string
  version: number
  name: string
  enrichment?: string
}

it("does not coerce internal numeric-string versions", () => {
  expect(sameMutationVersion(2, 2)).toBe(true)
  expect(sameMutationVersion("2", 2)).toBe(false)
})

const id = "00000000-0000-4000-8000-000000000001"
const entity: EntityDescriptor<TestRow> = {
  name: "update-correctness-test",
  primaryKey: "id",
  tenantField: "tenantId",
  versionField: "version",
  fields: {
    id: { type: "string" },
    tenantId: { type: "string" },
    version: { type: "number" },
    name: { type: "string" },
    enrichment: { type: "string" },
  },
}

function makeSession() {
  return {
    scope: "tenant" as const,
    actor: { id: "actor-1", type: "tenant" as const, tenantId: "tenant-1", bypassAuthority: true },
    tenant: { id: "tenant-1", enabledModuleKeys: [], enabledModuleActions: {} },
    raw: {} as never,
  }
}

function makeShared(options: CrudShared<TestRow, TestRow, Partial<TestRow>, TestRow, TestRow>["options"]): CrudShared<TestRow, TestRow, Partial<TestRow>, TestRow, TestRow> {
  return {
    options,
    entity,
    deps: options.adapterDeps,
    idParamsSchema: z.object({ id: z.string() }),
    capabilityMode: { enabled: false, key: undefined },
    writeCapabilityConfig: { skipCapabilityCheck: true },
    routes: { list: false, detail: false, create: false, update: true, delete: true },
    writeRuntimeCapabilities: { deferredExecution: true, cache: true },
    resolveReadScopeForSession: async () => ({ filter: undefined }),
  } as unknown as CrudShared<TestRow, TestRow, Partial<TestRow>, TestRow, TestRow>
}

function makeOptions(
  repository: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  const session = makeSession()
  const persistence = {
    dialect: "test",
    capabilities: { interactiveTransactions: true } as PersistenceProvider["capabilities"],
    repository: () => repository,
    runInTransaction: async (work: (scoped: PersistenceProvider) => Promise<unknown>) => work(persistence),
  } as unknown as PersistenceProvider
  const options = {
    adapterDeps: {
      assertValidCsrf: () => undefined,
      resolveAbacBundle: async ({ moduleKey }: { moduleKey: string }) => allowAllAbacBundle(moduleKey),
      resolveModuleAuthorizationFacts: allowAllModuleFacts,
    },
    requestNormalization: canonicalRequestNormalization(trustedSession({ kind: "tenant", tenantId: "tenant-1" }), "test.update-correctness"),
    scope: { scope: "tenant" as const },
    moduleKey: "test.update-correctness",
    entity,
    entityScope: { kind: "tenant" as const },
    policy: { skipCapabilityCheck: true },
    cache: { enabled: false, tag: "test", keyPrefix: "test" },
    getCacheAdapter: async () => ({ deleteTag: async () => undefined }),
    createPersistence: () => persistence,
    validation: {
      idParams: z.object({ id: z.string() }),
      updateBody: z.object({ name: z.string() }),
    },
    optimisticConcurrency: { versionField: "version" as const },
    audit: { enabled: false },
    crud: {},
    ...overrides,
  } as unknown as CrudShared<TestRow, TestRow, Partial<TestRow>, TestRow, TestRow>["options"]
  return { options, shared: makeShared(options) }
}

describe("CRUD update correctness", () => {
  it("rereads with structural read scope and preserves after-hook enrichment", async () => {
    let row: TestRow = { id, tenantId: "tenant-1", version: 1, name: "before" }
    const filters: unknown[] = []
    const repository = {
      findOneWhere: vi.fn(async () => row),
      findMany: vi.fn(async ({ filter }: { filter: unknown }) => {
        filters.push(filter)
        return { rows: [row], rowCount: 1, page: 1, pageSize: 1 }
      }),
      updateOneWhereReturning: vi.fn(async (_filter: unknown, patch: Partial<TestRow>) => {
        row = { ...row, ...patch }
        row.version = 2
        return { ...row }
      }),
    }
    const { shared } = makeOptions(repository, {
      crud: {
        update: {
           projectCommittedResult: async ({ result }: { result: TestRow }) => ({
            ...result,
            enrichment: "kept",
          }),
        },
      },
    })

    const handler = createUpdateHandler(shared)
    const response = await handler(
      new Request(`https://example.test/items/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "after" }),
        headers: { "content-type": "application/json", "if-match": "1" },
      }),
      { params: Promise.resolve({ id }) },
    )
    const body = await response.json() as Record<string, unknown>
    expect(response.status).toBe(200)
    expect(body).toMatchObject({ name: "after", version: 2, enrichment: "kept" })
    expect(filters).toHaveLength(1)
  })

  it("does not build the mutation response from a newer concurrent row", async () => {
    let row: TestRow = { id, tenantId: "tenant-1", version: 1, name: "before" }
    let mutationCommitted = false
    const repository = {
      findOneWhere: vi.fn(async () => row),
      findMany: vi.fn(async () => ({
        rows: [mutationCommitted ? { ...row, version: 3, name: "newer" } : row],
        rowCount: 1,
        page: 1,
        pageSize: 1,
      })),
      updateOneWhereReturning: vi.fn(async (_filter: unknown, patch: Partial<TestRow>) => {
        row = { ...row, ...patch, version: 2 }
        mutationCommitted = true
        return { ...row }
      }),
    }
    const { shared } = makeOptions(repository)
    const handler = createUpdateHandler(shared)

    const response = await handler(
      new Request(`https://example.test/items/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "committed" }),
        headers: { "content-type": "application/json", "if-match": "1" },
      }),
      { params: Promise.resolve({ id }) },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, reason: "UPDATED_OUTSIDE_READ_SCOPE" })
  })

  it("uses the if-match header as the expected version for updates", async () => {
    const before: TestRow = { id, tenantId: "tenant-1", version: 1, name: "before" }
    let row: TestRow = { ...before }
    const updateOneWhereReturning = vi.fn(async (_filter: PredicateNode, patch: Partial<TestRow>) => {
      row = { ...row, ...patch }
      row.version = 2
      return { ...row }
    })
    const repository = {
      findOneWhere: vi.fn(async () => row),
      findMany: vi.fn(async () => ({ rows: [row], rowCount: 1, page: 1, pageSize: 1 })),
      updateOneWhereReturning,
    }
    const { shared } = makeOptions(repository)
    const handler = createUpdateHandler(shared)

    // Strong validator succeeds
    const response = await handler(
      new Request(`https://example.test/items/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "after" }),
        headers: { "content-type": "application/json", "if-match": '"1"' },
      }),
      { params: Promise.resolve({ id }) },
    )

    expect(response.status).toBe(200)
    const filter = updateOneWhereReturning.mock.calls[0]![0]
    expect(evaluatePredicate(before, filter)).toBe(true)
    expect(evaluatePredicate({ ...before, version: 2 }, filter)).toBe(false)
  })

  it("rejects weak W/ validators for If-Match (requires strong comparison)", async () => {
    let row: TestRow = { id, tenantId: "tenant-1", version: 1, name: "before" }
    const updateOneWhereReturning = vi.fn(async (_filter: PredicateNode, patch: Partial<TestRow>) => {
      row = { ...row, ...patch }
      row.version = 2
      return { ...row }
    })
    const repository = {
      findOneWhere: vi.fn(async () => row),
      findMany: vi.fn(async () => ({ rows: [row], rowCount: 1, page: 1, pageSize: 1 })),
      updateOneWhereReturning,
    }
    const { shared } = makeOptions(repository)
    const handler = createUpdateHandler(shared)

    const response = await handler(
      new Request(`https://example.test/items/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "after" }),
        headers: { "content-type": "application/json", "if-match": 'W/"1"' },
      }),
      { params: Promise.resolve({ id }) },
    )

    expect(response.status).toBe(409)
    expect(updateOneWhereReturning).not.toHaveBeenCalled()
  })

  it("does not treat a body version field as the concurrency transport", async () => {
    let row: TestRow = { id, tenantId: "tenant-1", version: 1, name: "before" }
    const updateOneWhereReturning = vi.fn(async (_filter: PredicateNode, patch: Partial<TestRow>) => {
      row = { ...row, ...patch }
      row.version = 2
      return { ...row }
    })
    const repository = {
      findOneWhere: vi.fn(async () => row),
      findMany: vi.fn(async () => ({ rows: [row], rowCount: 1, page: 1, pageSize: 1 })),
      updateOneWhereReturning,
    }
    const { shared } = makeOptions(repository)
    const handler = createUpdateHandler(shared)

    const response = await handler(
      new Request(`https://example.test/items/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "after", version: 1 }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ id }) },
    )

    expect(response.status).toBe(428)
    expect(await response.json()).toEqual({ error: "A precondition header is required", code: "PRECONDITION_REQUIRED", details: { header: "If-Match" } })
    expect(updateOneWhereReturning).not.toHaveBeenCalled()
  })

  it("delete without an if-match header answers 428 PRECONDITION_REQUIRED", async () => {
    const row: TestRow = { id, tenantId: "tenant-1", version: 1, name: "before" }
    const deleteWhere = vi.fn(async () => ({ deletedCount: 1 }))
    const repository = {
      findOneWhere: vi.fn(async () => row),
      findMany: vi.fn(async () => ({ rows: [row], rowCount: 1, page: 1, pageSize: 1 })),
      deleteWhere,
    }
    const { shared } = makeOptions(repository)
    const handler = createDeleteHandler(shared)

    const response = await handler(new Request(`https://example.test/items/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) })

    expect(response.status).toBe(428)
    expect(await response.json()).toEqual({ error: "A precondition header is required", code: "PRECONDITION_REQUIRED", details: { header: "If-Match" } })
    expect(deleteWhere).not.toHaveBeenCalled()
  })

  it("delete with an if-match header fences on the expected version", async () => {
    const row: TestRow = { id, tenantId: "tenant-1", version: 1, name: "before" }
    const deleteWhere = vi.fn(async (filter: PredicateNode) => ({
      deletedCount: evaluatePredicate(row, filter) ? 1 : 0,
    }))
    const repository = {
      findOneWhere: vi.fn(async () => row),
      findMany: vi.fn(async () => ({ rows: [row], rowCount: 1, page: 1, pageSize: 1 })),
      deleteWhere,
    }
    const { shared } = makeOptions(repository)
    const handler = createDeleteHandler(shared)

    const response = await handler(
      new Request(`https://example.test/items/${id}`, {
        method: "DELETE",
        headers: { "if-match": '"1"' },
      }),
      { params: Promise.resolve({ id }) },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ message: "Deleted" })
    const filter = deleteWhere.mock.calls[0]![0]
    expect(evaluatePredicate(row, filter)).toBe(true)
    expect(evaluatePredicate({ ...row, version: 2 }, filter)).toBe(false)
  })

  it("delete rejects weak W/ validators for If-Match", async () => {
    const row: TestRow = { id, tenantId: "tenant-1", version: 1, name: "before" }
    const deleteWhere = vi.fn(async (filter: PredicateNode) => ({
      deletedCount: evaluatePredicate(row, filter) ? 1 : 0,
    }))
    const repository = {
      findOneWhere: vi.fn(async () => row),
      findMany: vi.fn(async () => ({ rows: [row], rowCount: 1, page: 1, pageSize: 1 })),
      deleteWhere,
    }
    const { shared } = makeOptions(repository)
    const handler = createDeleteHandler(shared)

    const response = await handler(
      new Request(`https://example.test/items/${id}`, {
        method: "DELETE",
        headers: { "if-match": 'W/"1"' },
      }),
      { params: Promise.resolve({ id }) },
    )

    expect(response.status).toBe(409)
    expect(deleteWhere).not.toHaveBeenCalled()
  })

  it("allows construction for a non-transactional provider when owner bypass is available", () => {
    const repository = { findOneWhere: vi.fn(), findMany: vi.fn(), updateOneWhereReturning: vi.fn() }
    const nonTransactional = {
      dialect: "test",
      capabilities: { interactiveTransactions: false } as PersistenceProvider["capabilities"],
      repository: () => repository,
    } as unknown as PersistenceProvider
    const { options } = makeOptions(repository, { createPersistence: () => nonTransactional })
    const shared = makeShared(options)

    expect(() => createUpdateHandler(shared)).not.toThrow()
  })
})
