import { describe, expect, it } from "vitest"
import type { EntityDescriptor, PersistenceProvider, ReadOnlyPersistenceProvider } from "@xonava/core/persistence"
import { createDetailHandler } from "../detail"
import { createListHandler } from "../list"
import type { CrudShared } from "../types"
import { allowAllAbacBundle, canonicalRequestNormalization, trustedSession } from "../../__tests__/canonicalRequest"

type TestRow = { id: string; value: string }
type TestShared = CrudShared<TestRow, TestRow, Partial<TestRow>, TestRow, TestRow>

const entity: EntityDescriptor<TestRow> = {
  name: "read-hook-guard",
  primaryKey: "id",
  fields: {
    id: { type: "string" },
    value: { type: "string" },
  },
}

const abacBundle = allowAllAbacBundle("test.read")

function makeSession(actorId: string) {
  return {
    scope: "tenant" as const,
    actor: { id: actorId, type: "tenant" as const, tenantId: "tenant-1" },
    tenant: { id: "tenant-1", enabledModuleKeys: [], enabledModuleActions: {} },
    raw: {} as never,
  }
}

function makePersistence(supportTx = false) {
  const provider = {
    dialect: "test",
    capabilities: {
      interactiveTransactions: supportTx,
    } as PersistenceProvider["capabilities"],
    repository: () => ({
      findMany: async () => ({
        rows: [{ id: "row-1", value: "v" }],
        rowCount: 1,
        page: 1,
        pageSize: 10,
      }),
      findById: async () => ({ id: "row-1", value: "v" }),
    }),
  } as unknown as PersistenceProvider
  if (supportTx) {
    ;(provider as unknown as {
      runInTransaction: (work: (scoped: PersistenceProvider) => Promise<unknown>) => Promise<unknown>
    }).runInTransaction = async (work) => work(provider)
  }
  return provider
}

type HookSide = (context: {
  persistence: ReadOnlyPersistenceProvider
  operation?: import("@xonava/core/operation").ReadOperationContext
}) => unknown

function makeShared(overrides: {
  supportTx?: boolean
  listBefore?: HookSide
  listAfter?: HookSide
  detailProject?: HookSide
  detailAfter?: HookSide
}) {
  const persistence = makePersistence(overrides.supportTx)
  const currentSession = { value: makeSession("actor-a") }
  const options = {
    adapterDeps: {} as TestShared["deps"],
    requestNormalization: canonicalRequestNormalization(() => trustedSession({ kind: "tenant", tenantId: "tenant-1" }, currentSession.value.actor.id), "test.read"),
    scope: { scope: "tenant" as const },
    moduleKey: "test.read",
    entity,
    policy: { skipCapabilityCheck: true },
    cache: { enabled: false, tag: "test", keyPrefix: "test" },
    getCacheAdapter: async () => null as never,
    createPersistence: () => persistence,
    crud: {
      ...(overrides.listBefore || overrides.listAfter
        ? {
            list: {
              ...(overrides.listBefore
                  ? { transformQuery: async ({ query, context }: { query: import("../types").ReadQuery; context: never }) => {
                      await overrides.listBefore!(context)
                      return { query }
                    } }
                : {}),
              ...(overrides.listAfter
                  ? { projectResult: ({ context }: { context: never }) => overrides.listAfter!(context) }
                : {}),
            },
          }
        : {}),
      ...(overrides.detailProject || overrides.detailAfter
        ? {
            detail: {
              ...(overrides.detailProject
                  ? { projectResult: ({ context }: { context: never }) => overrides.detailProject!(context) }
                : {}),
              ...(overrides.detailAfter
                  ? { projectResult: ({ context }: { context: never }) => overrides.detailAfter!(context) }
                : {}),
            },
          }
        : {}),
    },
  }
  const shared = {
    options,
    entity,
    deps: options.adapterDeps,
    routes: { list: true, detail: true, create: false, update: false, delete: false },
    enforceReadAccess: async () => abacBundle,
    buildReadScope: () => ({ filter: undefined }),
    enforceReadRateLimit: async () => undefined,
    buildReadTags: () => [],
    resolveDefaultSort: () => undefined,
  } as unknown as TestShared
  options.createPersistence = () => persistence
  return shared
}

const ID = "00000000-0000-4000-8000-000000000001"

describe("CRUD read lifecycle hooks cannot mutate persistence", () => {
  it("list.before repository insert is rejected", async () => {
    const shared = makeShared({
      listBefore: async ({ persistence }) => {
        const repo = persistence as unknown as {
          insert: (data: unknown) => Promise<unknown>
        }
        await repo.insert({ id: "x", value: "y" })
      },
    })
    const response = await createListHandler(shared)(new Request("https://example.test/items"))
    expect(response.status).toBe(500)
  })

  it("list.after repository update is rejected", async () => {
    const shared = makeShared({
      listAfter: async ({ persistence }) => {
        const repo = persistence as unknown as {
          update: (id: string, data: unknown) => Promise<unknown>
        }
        await repo.update("row-1", { value: "changed" })
      },
    })
    const response = await createListHandler(shared)(new Request("https://example.test/items"))
    expect(response.status).toBe(500)
  })

  it("detail.project repository delete is rejected", async () => {
    const shared = makeShared({
      detailProject: async ({ persistence }) => {
        const repo = persistence as unknown as {
          delete: (id: string) => Promise<unknown>
        }
        await repo.delete(ID)
      },
    })
    const response = await createDetailHandler(shared)(new Request(`https://example.test/items/${ID}`), { id: ID })
    expect(response.status).toBe(500)
  })

  it("detail.after repository insert is rejected", async () => {
    const shared = makeShared({
      detailAfter: async ({ persistence }) => {
        const repo = persistence as unknown as {
          insert: (data: unknown) => Promise<unknown>
        }
        await repo.insert({ id: "x", value: "y" })
      },
    })
    const response = await createDetailHandler(shared)(new Request(`https://example.test/items/${ID}`), { id: ID })
    expect(response.status).toBe(500)
  })

  it("list.before transactional write is rejected", async () => {
    const shared = makeShared({
      supportTx: true,
      listBefore: async ({ persistence }) => {
        const tx = persistence as unknown as {
          runInTransaction: (work: (scoped: PersistenceProvider) => Promise<unknown>) => Promise<unknown>
        }
        await tx.runInTransaction(async (scoped) => {
          const repo = scoped as unknown as { insert: (data: unknown) => Promise<unknown> }
          await repo.insert({ id: "x", value: "y" })
        })
      },
    })
    const response = await createListHandler(shared)(new Request("https://example.test/items"))
    expect(response.status).toBe(500)
  })

  it("list.before outbox registration is rejected", async () => {
    const shared = makeShared({
      listBefore: async ({ operation }) => {
        ;(operation as unknown as { addOutboxRecord: (record: unknown) => void })?.addOutboxRecord({
          type: "test.event",
          version: 1,
          aggregateType: "test",
          aggregateId: "x",
          payload: {},
          idempotencyKey: "test-event",
        })
      },
    })
    const response = await createListHandler(shared)(new Request("https://example.test/items"))
    expect(response.status).toBe(500)
  })

  it("list.before exposes a read operation context without mutation effects", async () => {
    let operationKeys: string[] = []
    const shared = makeShared({
      listBefore: async ({ operation }) => {
        expect(operation).toBeDefined()
        operationKeys = Object.keys(operation as object)
      },
    })
    const response = await createListHandler(shared)(new Request("https://example.test/items"))
    expect(response.status).toBe(200)
    expect(operationKeys).not.toContain("persistence")
    expect(operationKeys).not.toContain("withPersistence")
    expect(operationKeys).not.toContain("effects")
  })

  it("read lifecycle still works without mutating hooks", async () => {
    const shared = makeShared({})
    const listResponse = await createListHandler(shared)(new Request("https://example.test/items"))
    expect(listResponse.status).toBe(200)
    await expect(listResponse.json()).resolves.toMatchObject({
      rows: [{ id: "row-1", value: "v" }],
    })

    const detailResponse = await createDetailHandler(shared)(new Request(`https://example.test/items/${ID}`), { id: ID })
    expect(detailResponse.status).toBe(200)
    await expect(detailResponse.json()).resolves.toMatchObject({ id: "row-1", value: "v" })
  })
})
