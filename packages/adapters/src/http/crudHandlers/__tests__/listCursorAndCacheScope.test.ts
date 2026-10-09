import { describe, expect, it } from "vitest"
import type { EntityDescriptor, PersistenceProvider } from "core/persistence"
import { hmacSha256 } from "core/serialization"
import type { CursorIntegrityPort } from "core/query"
import { createListHandler, listCacheScope } from "../list"
import type { CrudShared } from "../types"
import { canonicalRequestNormalization, trustedSession } from "../../__tests__/canonicalRequest"

type Row = { id: string; name: string; title: string }
type Shared = CrudShared<Row, Row, Partial<Row>, Row, Row>

const key = new TextEncoder().encode("list-cursor-test-key")
const integrity: CursorIntegrityPort = {
  sign: async (payload) => hmacSha256(key, payload),
  verify: async (payload, signature) => {
    const expected = hmacSha256(key, payload)
    return expected.length === signature.length && expected.every((byte, index) => byte === signature[index])
  },
}

const rows: Row[] = [{ id: "r1", name: "a", title: "t1" }, { id: "r2", name: "b", title: "t2" }]

function entity(name: string, namespace?: string): EntityDescriptor<Row> {
  return { name, ...(namespace === undefined ? {} : { namespace }), primaryKey: "id", fields: { id: { type: "string" }, name: { type: "string" }, title: { type: "string" } } }
}

function shared(descriptor: EntityDescriptor<Row>): Shared {
  const persistence = {
    dialect: "test",
    capabilities: {} as PersistenceProvider["capabilities"],
    repository: () => ({ findMany: async () => ({ rows, rowCount: rows.length, page: 1, pageSize: 10, pageInfo: { kind: "cursor", hasNextPage: true, hasPreviousPage: false } }) }),
  } as unknown as PersistenceProvider
  const options = {
    adapterDeps: {},
    requestNormalization: canonicalRequestNormalization(trustedSession({ kind: "tenant", tenantId: "tenant-1" }), "test.cursor"),
    scope: { scope: "tenant" as const },
    moduleKey: "test.cursor",
    entity: descriptor,
    policy: { skipCapabilityCheck: true },
    filterableColumns: ["id", "name", "title"],
    searchableColumns: ["name", "title"],
    sortableColumns: ["id"],
    pagination: { strategy: "cursor", integrity, uniqueFields: ["id"] },
    cache: { enabled: false, tag: "test", keyPrefix: "test" },
    getCacheAdapter: async () => null as never,
    createPersistence: () => persistence,
  } as unknown as Shared["options"]
  return {
    options,
    entity: descriptor,
    deps: options.adapterDeps,
    routes: { list: true, detail: false, create: false, update: false, delete: false },
    enforceReadAccess: async () => undefined,
    buildReadScope: () => ({ filter: undefined }),
    enforceReadRateLimit: async () => undefined,
    buildReadTags: () => [],
    resolveDefaultSort: () => [{ field: "id", direction: "asc" }],
  } as unknown as Shared
}

async function list(descriptor: EntityDescriptor<Row>, query = ""): Promise<Response> {
  return createListHandler(shared(descriptor))(new Request(`https://example.test/items${query}`))
}

function findEndCursor(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (typeof record.endCursor === "string") return record.endCursor
  for (const item of Object.values(record)) {
    const found = findEndCursor(item)
    if (found) return found
  }
  return undefined
}

async function endCursor(descriptor: EntityDescriptor<Row>, query = ""): Promise<string> {
  const response = await list(descriptor, query)
  const body = await response.text()
  expect(response.status, body).toBe(200)
  const cursor = findEndCursor(JSON.parse(body))
  if (!cursor) throw new Error(`no cursor in ${body}`)
  return cursor
}

const search = (text: string) => encodeURIComponent(JSON.stringify({ search: text }))

describe("list cursor bindings", () => {
  it("replays a cursor on the same entity, search and projection", async () => {
    const cursor = await endCursor(entity("orders"), "?fields=id,name")
    const response = await list(entity("orders"), `?fields=id,name&cursor=${cursor}`)
    expect(response.status, await response.clone().text()).toBe(200)
  })

  it("rejects a cursor replayed against another entity of the same module", async () => {
    const cursor = await endCursor(entity("orders"))
    expect((await list(entity("invoices"), `?cursor=${cursor}`)).status).toBe(400)
  })

  it("rejects a cursor replayed against the same entity name in another persistence namespace", async () => {
    const cursor = await endCursor(entity("orders", "a"))
    expect((await list(entity("orders", "b"), `?cursor=${cursor}`)).status).toBe(400)
  })

  it("rejects a cursor replayed with a different projection", async () => {
    const cursor = await endCursor(entity("orders"), "?fields=id,name")
    expect((await list(entity("orders"), `?fields=id,title&cursor=${cursor}`)).status).toBe(400)
    expect((await list(entity("orders"), `?cursor=${cursor}`)).status).toBe(400)
  })

  it("rejects a cursor replayed with a different search term", async () => {
    const first = await list(entity("orders"), `?filters=${search("a")}`)
    expect(first.status, await first.clone().text()).toBe(200)
    const cursor = findEndCursor(await first.json())
    expect((await list(entity("orders"), `?filters=${search("b")}&cursor=${cursor}`)).status).toBe(400)
  })
})

describe("list cache scope", () => {
  const atoms = ["a", ":", "a:a", "b", "", "global", "%3A", "x:y:z"]
  it("is injective on (partition, scope, cacheScopeKey), including ':' inside tenant ids and scope keys", () => {
    const seen = new Map<string, string>()
    for (const partition of ["abac:d:k", "abac:d", "public:s"]) {
      for (const kind of ["tenant", "platform"] as const) {
        for (const id of atoms.filter(Boolean)) {
          for (const cacheScopeKey of [undefined, ...atoms]) {
            const scope = kind === "tenant" ? { kind, tenantId: id } : { kind, platformKey: id }
            const encoded = listCacheScope({ partition, scope, scopeId: `fscope:v1:${id}`, cacheScopeKey })
            const identity = JSON.stringify([partition, kind, id, cacheScopeKey ?? null])
            const previous = seen.get(encoded)
            if (previous !== undefined) expect(previous).toBe(identity)
            seen.set(encoded, identity)
          }
        }
      }
    }
  })

  it("separates tenant \"a\" with scope key \"a:a\" from tenant \"a:a:a\" with scope key \"a\"", () => {
    // deriveSecurityCachePartition ends the partition with the cache scope key.
    const left = listCacheScope({ partition: "abac:d:a:a", scope: { kind: "tenant", tenantId: "a" }, scopeId: "s1", cacheScopeKey: "a:a" })
    const right = listCacheScope({ partition: "abac:d:a", scope: { kind: "tenant", tenantId: "a:a:a" }, scopeId: "s2", cacheScopeKey: "a" })
    expect(left).not.toBe(right)
  })
})
