import { describe, expect, it } from "vitest"
import type { CacheAdapter } from "core/cache"
import type { EntityDescriptor, PersistenceProvider } from "core/persistence"
import {
  bindAbacSecurityDigest,
  type AbacPolicyBundle,
} from "core/domain"
import {
  InMemoryCacheAdapter,
  SharedGenerationCacheAdapter,
  type TagGenerationStore,
} from "../../../cache"
import { createDetailHandler } from "../detail"
import { createListHandler } from "../list"
import type { CrudShared } from "../types"
import { allowAllAbacBundle, canonicalRequestNormalization, trustedSession } from "../../__tests__/canonicalRequest"

// Correctness-critical reads require a shared, linearizable generation source;
// a bare in-memory payload would be rejected by the CacheService gate. Compose
// the real shared-generation wrapper around an in-memory payload so the cache
// scope semantics under test match production topology.
function createGateCompliantAdapter(): CacheAdapter {
  const generations: TagGenerationStore = {
    getTagGeneration: async () => "0",
    advanceTagGeneration: async () => "1",
  }
  return new SharedGenerationCacheAdapter({
    payload: new InMemoryCacheAdapter(),
    generations,
  })
}

type TestRow = { id: string; value: string }
type TestShared = CrudShared<TestRow, TestRow, Partial<TestRow>, TestRow, TestRow>

const entity: EntityDescriptor<TestRow> = {
  name: "cache-scope-test",
  primaryKey: "id",
  fields: {
    id: { type: "string" },
    value: { type: "string" },
  },
}

const abacBundle = allowAllAbacBundle("test.cache")

const abacBundleDeny = bindAbacSecurityDigest({
  mode: "tenant",
  moduleKey: "test.cache",
  policies: [],
  context: { fixtureVariant: "deny" },
  defaultEffect: "deny",
  fieldCatalog: {},
})

function makeSession(actorId: string, bypassAuthority = false) {
  return {
    scope: "tenant" as const,
    actor: {
      id: actorId,
      type: "tenant" as const,
      tenantId: "tenant-1",
      ...(bypassAuthority ? { bypassAuthority: true as const } : {}),
    },
    tenant: { id: "tenant-1", enabledModuleKeys: [], enabledModuleActions: {} },
    raw: {} as never,
  }
}

function makeShared(
  cache: CacheAdapter,
  currentSession: { value: ReturnType<typeof makeSession> },
  readScopeKey: string | undefined,
  calls: { list: number; detail: number },
  bundle: Promise<AbacPolicyBundle> = abacBundle,
  optionsOverrides: Partial<TestShared["options"]> = {}
) {
  const persistence = {
    dialect: "test",
    capabilities: {} as PersistenceProvider["capabilities"],
    repository: () => ({
      findMany: async () => {
        calls.list += 1
        return {
          rows: [{ id: "row-1", value: currentSession.value.actor.id }],
          rowCount: 1,
          page: 1,
          pageSize: 10,
        }
      },
      findById: async () => {
        calls.detail += 1
        return { id: "row-1", value: currentSession.value.actor.id }
      },
    }),
  } as unknown as PersistenceProvider

  const options = {
    adapterDeps: {
    } as Partial<TestShared["deps"]> as TestShared["deps"],
    requestNormalization: canonicalRequestNormalization(() => trustedSession({ kind: "tenant", tenantId: "tenant-1" }, currentSession.value.actor.id), "test.cache"),
    scope: { scope: "tenant" as const },
    moduleKey: "test.cache",
    entity,
    policy: { skipCapabilityCheck: true },
    cache: { enabled: true, tag: "test", keyPrefix: "test" },
    getCacheAdapter: async () => cache,
    createPersistence: () => persistence,
    ...optionsOverrides,
  } as TestShared["options"]
  const shared = {
    options,
    entity,
    deps: options.adapterDeps,
    routes: { list: true, detail: true, create: false, update: false, delete: false },
    enforceReadAccess: async () => bundle,
    buildReadScope: () => ({ filter: undefined, ...(readScopeKey !== undefined ? { cacheScopeKey: readScopeKey } : {}) }),
    enforceReadRateLimit: async () => undefined,
    buildReadTags: () => [],
    resolveDefaultSort: () => undefined,
  } as unknown as TestShared

  options.createPersistence = () => persistence
  return shared
}

describe("CRUD ABAC read cache scope", () => {
  it("does not leak list results between actors when the ABAC scope key is missing", async () => {
    const cache = createGateCompliantAdapter()
    const currentSession = { value: makeSession("actor-a") }
    const calls = { list: 0, detail: 0 }
    const shared = makeShared(cache, currentSession, undefined, calls)
    const handler = createListHandler(shared)

    const first = await handler(new Request("https://example.test/items"))
    currentSession.value = makeSession("actor-b")
    const second = await handler(new Request("https://example.test/items"))

    await expect(first.json()).resolves.toMatchObject({ rows: [{ value: "actor-a" }] })
    await expect(second.json()).resolves.toMatchObject({ rows: [{ value: "actor-b" }] })
    expect(calls.list).toBe(2)
  })

  it("does not leak detail results between actors when the ABAC scope key is missing", async () => {
    const cache = createGateCompliantAdapter()
    const currentSession = { value: makeSession("actor-a") }
    const calls = { list: 0, detail: 0 }
    const shared = makeShared(cache, currentSession, undefined, calls)
    const handler = createDetailHandler(shared)
    const id = "00000000-0000-4000-8000-000000000001"

    const first = await handler(new Request(`https://example.test/items/${id}`), { id })
    currentSession.value = makeSession("actor-b")
    const second = await handler(new Request(`https://example.test/items/${id}`), { id })

    await expect(first.json()).resolves.toMatchObject({ value: "actor-a" })
    await expect(second.json()).resolves.toMatchObject({ value: "actor-b" })
    expect(calls.detail).toBe(2)
  })

  it("keeps the ABAC-scoped cache path when a reliable scope key exists", async () => {
    const cache = createGateCompliantAdapter()
    const currentSession = { value: makeSession("actor-a") }
    const calls = { list: 0, detail: 0 }
    const shared = makeShared(cache, currentSession, "policy-scope", calls)
    const handler = createListHandler(shared)

    await handler(new Request("https://example.test/items"))
    await handler(new Request("https://example.test/items"))

    expect(calls.list).toBe(1)
  })

  it("never shares list cache entries between bundles with the same scope key but different security digests", async () => {
    const cache = createGateCompliantAdapter()
    const currentSession = { value: makeSession("actor-a") }
    const calls = { list: 0, detail: 0 }
    const sharedAllow = makeShared(cache, currentSession, "global", calls, abacBundle)
    const sharedDeny = makeShared(cache, currentSession, "global", calls, abacBundleDeny)

    await createListHandler(sharedAllow)(new Request("https://example.test/items"))
    await createListHandler(sharedDeny)(new Request("https://example.test/items"))

    expect(calls.list).toBe(2)
  })

  it("never shares detail cache entries between bundles with the same scope key but different security digests", async () => {
    const cache = createGateCompliantAdapter()
    const currentSession = { value: makeSession("actor-a") }
    const calls = { list: 0, detail: 0 }
    const sharedAllow = makeShared(cache, currentSession, "global", calls, abacBundle)
    const sharedDeny = makeShared(cache, currentSession, "global", calls, abacBundleDeny)
    const id = "00000000-0000-4000-8000-000000000001"

    await createDetailHandler(sharedAllow)(new Request(`https://example.test/items/${id}`), { id })
    await createDetailHandler(sharedDeny)(new Request(`https://example.test/items/${id}`), { id })

    expect(calls.detail).toBe(2)
  })

  it("does not derive an owner-bypass cache partition from transport session data", async () => {
    const cache = createGateCompliantAdapter()
    const calls = { list: 0, detail: 0 }
    const bypassSession = { value: makeSession("bypass-actor", true) }
    const abacSession = { value: makeSession("abac-actor") }
    const bypassShared = makeShared(cache, bypassSession, "global", calls, abacBundle)
    const abacShared = makeShared(cache, abacSession, "global", calls)

    await createListHandler(bypassShared)(new Request("https://example.test/items"))
    await createListHandler(abacShared)(new Request("https://example.test/items"))

    expect(calls.list).toBe(1)
  })

   it("disables list caching when a list project hook is present", async () => {
    const cache = createGateCompliantAdapter()
    const currentSession = { value: makeSession("actor-a") }
    const calls = { list: 0, detail: 0 }
    const shared = makeShared(cache, currentSession, "global", calls, abacBundle, {
      crud: {
        list: {
            projectResult: async ({ result }) => result,
        },
      },
    })
    const handler = createListHandler(shared)

    await handler(new Request("https://example.test/items"))
    await handler(new Request("https://example.test/items"))

    expect(calls.list).toBe(2)
  })

   it("disables detail caching when a detail project hook is present", async () => {
    const cache = createGateCompliantAdapter()
    const currentSession = { value: makeSession("actor-a") }
    const calls = { list: 0, detail: 0 }
    const shared = makeShared(cache, currentSession, "global", calls, abacBundle, {
      crud: {
        detail: {
            projectResult: async ({ row }) => row,
        },
      },
    })
    const handler = createDetailHandler(shared)
    const id = "00000000-0000-4000-8000-000000000001"

    await handler(new Request(`https://example.test/items/${id}`), { id })
    await handler(new Request(`https://example.test/items/${id}`), { id })

    expect(calls.detail).toBe(2)
  })

   it("runs list.transformQuery on cache hits and keys the cache by its transformed query", async () => {
    const cache = createGateCompliantAdapter()
    const currentSession = { value: makeSession("actor-a") }
    const calls = { list: 0, detail: 0 }
    let beforeCalls = 0
    const shared = makeShared(cache, currentSession, "scope-a", calls, abacBundle, {
      crud: {
        list: {
           transformQuery: async ({ query }) => {
            beforeCalls += 1
            return { query: { ...query, pageSize: 20 } }
          },
        },
      },
    })
    const handler = createListHandler(shared)

    await handler(new Request("https://example.test/items"))
    await handler(new Request("https://example.test/items"))

    expect(beforeCalls).toBe(2)
    expect(calls.list).toBe(1)
  })

  it("does not reuse a list cache entry when before transforms the query differently", async () => {
    const cache = createGateCompliantAdapter()
    const currentSession = { value: makeSession("actor-a") }
    const calls = { list: 0, detail: 0 }
    let beforeCalls = 0
    const shared = makeShared(cache, currentSession, "scope-a", calls, abacBundle, {
      crud: {
        list: {
           transformQuery: async ({ query }) => ({ query: { ...query, pageSize: 10 + ++beforeCalls } }),
        },
      },
    })
    const handler = createListHandler(shared)

    await handler(new Request("https://example.test/items"))
    await handler(new Request("https://example.test/items"))

    expect(calls.list).toBe(2)
  })
})
