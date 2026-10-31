import { afterEach, describe, expect, it, vi } from "vitest"
import type { EntityDescriptor, PersistenceProvider } from "@xonava/core/persistence"
import { ConfigurationError } from "@xonava/core/domain"
import { hmacSha256 } from "@xonava/core/serialization"
import type { CursorIntegrityPort } from "@xonava/core/query"
import { createListHandler, listCacheScope } from "../list"
import type { CrudShared, ListPaginationConfig } from "../types"
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

  it("answers a stale, foreign or corrupted cursor with a clean 400 asking to restart from the first page", async () => {
    const cursor = await endCursor(entity("orders"))
    const [prefix, body, signature] = cursor.split(".")
    for (const stale of [
      cursor.replace(/.$/, (last) => (last === "A" ? "B" : "A")),
      `${prefix}.${signature}.${body}`,
      "v1.e30.AAAA",
      "not-a-cursor",
    ]) {
      const response = await list(entity("invoices"), `?cursor=${encodeURIComponent(stale)}`)
      expect(response.status).toBe(400)
      expect(await response.text()).toMatch(/restart from the first page/)
    }
    const mismatched = await list(entity("invoices"), `?cursor=${cursor}`)
    expect(await mismatched.text()).toMatch(/restart from the first page/)
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

describe("list cursor expiry (opt-in cursorTtlMs)", () => {
  // Must not precede the fixture's admission evidence (issuedAt 2026-09-10).
  const start = new Date("2026-10-20T00:00:00Z")
  const cursorPagination = (cursorTtlMs?: number): ListPaginationConfig => ({
    strategy: "cursor",
    integrity,
    uniqueFields: ["id"],
    ...(cursorTtlMs === undefined ? {} : { cursorTtlMs }),
  })
  const withPagination = (descriptor: EntityDescriptor<Row>, pagination: ListPaginationConfig): Shared => {
    const base = shared(descriptor)
    return { ...base, options: { ...base.options, pagination } }
  }
  const listWith = (pagination: ListPaginationConfig, query = "") =>
    createListHandler(withPagination(entity("orders"), pagination))(new Request(`https://example.test/items${query}`))
  const cursorWith = async (pagination: ListPaginationConfig): Promise<string> => {
    const response = await listWith(pagination)
    const body = await response.text()
    expect(response.status, body).toBe(200)
    const cursor = findEndCursor(JSON.parse(body))
    if (!cursor) throw new Error(`no cursor in ${body}`)
    return cursor
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it("accepts a next-page cursor before its expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(start)
    const pagination = cursorPagination(60_000)
    const cursor = await cursorWith(pagination)
    vi.setSystemTime(start.getTime() + 59_999)
    const response = await listWith(pagination, `?cursor=${encodeURIComponent(cursor)}`)
    expect(response.status, await response.clone().text()).toBe(200)
  })

  it("refuses the same cursor once it has expired, with the stale-cursor 400", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(start)
    const pagination = cursorPagination(60_000)
    const cursor = await cursorWith(pagination)
    vi.setSystemTime(start.getTime() + 60_000)
    const response = await listWith(pagination, `?cursor=${encodeURIComponent(cursor)}`)
    expect(response.status).toBe(400)
    expect(await response.text()).toMatch(/restart from the first page/)
  })

  it("issues cursors without expiry when cursorTtlMs is not set", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(start)
    const pagination = cursorPagination()
    const cursor = await cursorWith(pagination)
    vi.setSystemTime(start.getTime() + 10 * 365 * 24 * 60 * 60 * 1000)
    const response = await listWith(pagination, `?cursor=${encodeURIComponent(cursor)}`)
    expect(response.status, await response.clone().text()).toBe(200)
  })

  it("refuses a cursor without expiry once cursorTtlMs is enabled", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(start)
    const cursor = await cursorWith(cursorPagination())
    const response = await listWith(cursorPagination(60_000), `?cursor=${encodeURIComponent(cursor)}`)
    expect(response.status).toBe(400)
    expect(await response.text()).toMatch(/restart from the first page/)
  })

  it("rejects a cursorTtlMs that is not a positive safe integer at construction", () => {
    for (const cursorTtlMs of [0, -1, 1.5]) {
      expect(() => createListHandler(withPagination(entity("orders"), cursorPagination(cursorTtlMs)))).toThrow(ConfigurationError)
    }
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
