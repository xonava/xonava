import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { buildKey, serializeCacheKeyPart } from "@xonava/core/cache"
import { ConfigurationError, ForbiddenError, Predicate, ValidationError, markTrustedPredicate, type PredicateNode } from "@xonava/core/domain"
import { decodeCursor, encodeCursor, type CursorIntegrityPort, type CursorPayloadV1 } from "@xonava/core/query"
import { hmacSha256 } from "@xonava/core/serialization"
import { fingerprintJson } from "../../idempotency"
import { filtersToPredicate } from "../../filterInterop"
import { assertHttpPaginationParameters, createListHandler, listCacheScope } from "../list"
import {
  MODULE_KEY,
  baseOptions,
  contextFor,
  fakeRepo,
  memoryCache,
  persistenceOf,
  sharedOf,
  unscopedEntity,
  type Row,
} from "./crudUnitHarness"
import { allowAllAbacBundle, canonicalRequestNormalization, trustedSession } from "../../__tests__/canonicalRequest"

const spy = vi.hoisted(() => ({
  errors: [] as unknown[],
  anonymous: false,
  denials: undefined as undefined | { filter: string[]; search: string[]; sort: string[] },
  denialArgs: [] as Array<Record<string, unknown>>,
}))

vi.mock("../../handleFrameworkCoreError", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../handleFrameworkCoreError")>()
  return {
    ...actual,
    createFrameworkErrorHandler: (options?: Parameters<typeof actual.createFrameworkErrorHandler>[0]) => {
      const inner = actual.createFrameworkErrorHandler(options)
      return (error: unknown, metadata?: Parameters<typeof inner>[1]) => {
        spy.errors.push(error)
        return inner(error, metadata)
      }
    },
  }
})

vi.mock("../shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared")>()
  return {
    ...actual,
    normalizeCrudRequest: async (args: Parameters<typeof actual.normalizeCrudRequest>[0]) => {
      const context = await actual.normalizeCrudRequest(args)
      return spy.anonymous ? (await import("./crudUnitHarness")).asAnonymous(context) : context
    },
  }
})

vi.mock("@xonava/core/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xonava/core/domain")>()
  return {
    ...actual,
    resolveFieldQueryDenials: (args: Parameters<typeof actual.resolveFieldQueryDenials>[0]) => {
      spy.denialArgs.push(args as never)
      return spy.denials ?? actual.resolveFieldQueryDenials(args)
    },
  }
})

beforeEach(() => { spy.errors.length = 0; spy.anonymous = false; spy.denials = undefined; spy.denialArgs.length = 0 })
afterEach(() => { vi.useRealTimers() })

const key = new TextEncoder().encode("list-mutation-key")
const integrity: CursorIntegrityPort = {
  sign: async (payload) => hmacSha256(key, payload),
  verify: async (payload, signature) => {
    const expected = hmacSha256(key, payload)
    return expected.length === signature.length && expected.every((byte, index) => byte === signature[index])
  },
}

const rowsFixture = (): Row[] => [{ id: "r1", tenantId: "t", version: 1, name: "a" }, { id: "r2", tenantId: "t", version: 1, name: "b" }]
const page = (rows: Row[] = rowsFixture(), extra: Record<string, unknown> = {}) => ({ rows, rowCount: rows.length, page: 1, pageSize: 10, ...extra })
const lastError = () => spy.errors.at(-1)

type Stubs = {
  options?: Record<string, unknown>
  result?: Record<string, unknown>
  bundle?: Awaited<ReturnType<typeof allowAllAbacBundle>> | undefined
  readFilter?: PredicateNode | undefined
  cacheScopeKey?: string | undefined
  defaultSort?: Array<{ field: string; direction: "asc" | "desc" }> | undefined
  rateLimit?: ReturnType<typeof vi.fn>
  /** Bounded-count capability of the fake repository; `undefined` leaves the repository without `countUpTo`. */
  countUpTo?: ReturnType<typeof vi.fn>
}

function setup(stubs: Stubs = {}) {
  const repo = fakeRepo({ findMany: vi.fn(async () => stubs.result ?? page()), ...(stubs.countUpTo ? { countUpTo: stubs.countUpTo } : {}) })
  const persistence = persistenceOf(repo)
  const options = baseOptions({
    entity: unscopedEntity(),
    entityScope: undefined,
    scope: { scope: "platform" },
    requestNormalization: canonicalRequestNormalization(trustedSession({ kind: "platform", platformKey: "test" }), MODULE_KEY),
    createPersistence: () => persistence,
    filterableColumns: ["id", "name"],
    searchableColumns: ["name"],
    sortableColumns: ["id", "name"],
    ...stubs.options,
  })
  const enforceReadRateLimit = stubs.rateLimit ?? vi.fn(async () => undefined)
  const buildReadTags = vi.fn(() => ["tag-a"])
  const shared = sharedOf(options, {
    routes: { list: true, detail: false, create: false, update: false, delete: false },
    enforceReadAccess: vi.fn(async () => stubs.bundle),
    buildReadScope: vi.fn(() => ({ filter: stubs.readFilter, ...(stubs.cacheScopeKey !== undefined ? { cacheScopeKey: stubs.cacheScopeKey } : {}) })),
    enforceReadRateLimit,
    buildReadTags,
    resolveDefaultSort: () => stubs.defaultSort,
  })
  const handler = createListHandler(shared)
  const find = () => repo.findMany.mock.calls.map((call) => call[0] as Record<string, unknown>)
  return { handler, repo, options, shared, enforceReadRateLimit, buildReadTags, find }
}

const get = (handler: (request: Request) => Promise<Response>, query = "", init: RequestInit = {}) => handler(new Request(`https://example.test/widgets${query}`, init))
const q = (params: Record<string, string>) => `?${new URLSearchParams(params).toString()}`
const json = async (response: Response) => await response.json() as Record<string, unknown>
const cursorOptions = (extra: Record<string, unknown> = {}) => ({
  pagination: { strategy: "cursor", integrity, uniqueFields: ["id"], ...extra },
})
const SORT_ID = [{ field: "id", direction: "asc" as const }]

describe("list route availability and wiring", () => {
  it("answers 405 without any read when the route is disabled and needs no route binding for it", async () => {
    const base = canonicalRequestNormalization(trustedSession(), MODULE_KEY)
    const repo = fakeRepo()
    const options = baseOptions({ requestNormalization: { ...base, routeBindings: {} }, createPersistence: () => persistenceOf(repo) })
    const handler = createListHandler(sharedOf(options, { routes: { list: false, detail: false, create: false, update: false, delete: false } }))
    const response = await handler(new Request("https://example.test/widgets"))
    expect(response.status).toBe(405)
    expect(await response.json()).toEqual({ error: "Method Not Allowed" })
    expect(repo.findMany).not.toHaveBeenCalled()
  })

  it("requires the list route binding when the route is enabled", () => {
    const base = canonicalRequestNormalization(trustedSession(), MODULE_KEY)
    const options = baseOptions({ requestNormalization: { ...base, routeBindings: {} } })
    expect(() => createListHandler(sharedOf(options, { routes: { list: true } }))).toThrow(new ConfigurationError(`CRUD handler for "${MODULE_KEY}" has no route binding "list"`))
  })

  it("validates the cursor lifetime at construction", () => {
    const build = (cursorTtlMs: number) => () => setup({ options: cursorOptions({ cursorTtlMs }) })
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2, Number.NaN]) {
      expect(build(bad)).toThrow(new ConfigurationError(`cursorTtlMs for ${MODULE_KEY}.list must be a positive safe integer (milliseconds)`))
    }
    expect(build(1)).not.toThrow()
    expect(() => setup({ options: { pagination: { strategy: "offset", cursorTtlMs: 0 } } })).not.toThrow()
  })

  it("rate limits the list route with its own setting", async () => {
    const setting = { max: 5, timeWindow: "1 minute", consistency: "atomic" }
    const { handler, enforceReadRateLimit } = setup({ options: { rateLimit: { list: setting, detail: { max: 1, timeWindow: "1 minute", consistency: "atomic" } } } })
    const request = new Request("https://example.test/widgets")
    await handler(request)
    expect(enforceReadRateLimit).toHaveBeenCalledWith("list", setting, request, expect.objectContaining({ requestId: expect.any(String) }))
  })

  it("stamps the request and correlation ids on success and failure", async () => {
    const { handler } = setup()
    const ok = await get(handler, "", { headers: { "x-correlation-id": "corr-3" } })
    expect(ok.status).toBe(200)
    expect(ok.headers.get("x-correlation-id")).toBe("corr-3")
    expect(ok.headers.get("x-request-id")).toBeTruthy()
    const plain = await get(handler)
    expect(plain.headers.get("x-correlation-id")).toBe(plain.headers.get("x-request-id"))
    const bad = await get(handler, "?page=0", { headers: { "x-correlation-id": "corr-3" } })
    expect(bad.status).toBe(400)
    expect(bad.headers.get("x-correlation-id")).toBe("corr-3")
  })
})

describe("list query parameters", () => {
  it("defaults to the first page of ten", async () => {
    const { handler, find } = setup()
    expect((await get(handler)).status).toBe(200)
    expect(find()[0]).toEqual({ pagination: { kind: "offset", page: 1, pageSize: 10, includeTotal: true } })
  })

  it("passes page, page size and consistency to the repository", async () => {
    const { handler, find } = setup()
    await get(handler, q({ page: "3", pageSize: "7", consistency: "strong" }))
    expect(find()[0]).toEqual({ consistency: "strong", pagination: { kind: "offset", page: 3, pageSize: 7, includeTotal: true } })
    await get(handler, q({ pageSize: "2" }))
    expect(find()[1]).toEqual({ pagination: { kind: "offset", page: 1, pageSize: 2, includeTotal: true } })
    await get(handler, q({ page: "2" }))
    expect(find()[2]).toEqual({ pagination: { kind: "offset", page: 2, pageSize: 10, includeTotal: true } })
  })

  it("returns the page the repository produced", async () => {
    const rows = rowsFixture()
    const { handler } = setup({ result: page(rows, { page: 4, pageSize: 2, rowCount: 9 }) })
    const body = await json(await get(handler, q({ page: "4", pageSize: "2" })))
    expect(body).toEqual({ rows: rows.map((row) => expect.objectContaining({ id: row.id })), rowCount: 9, page: 4, pageSize: 2 })
  })

  it("refuses duplicate query parameters and out-of-range values", async () => {
    const { handler } = setup()
    expect((await get(handler, "?page=1&page=2")).status).toBe(400)
    expect((await get(handler, "?pageSize=101")).status).toBe(400)
    expect((await get(handler, "?pageSize=100")).status).toBe(200)
  })

  it("applies a custom list query schema, and the same schema to the hook-transformed query", async () => {
    const parse = vi.fn((value: unknown) => value)
    const { handler } = setup({ options: { validation: { listQuery: { parse } } } })
    await get(handler, "?x=1")
    expect(parse).toHaveBeenCalledWith({ x: "1" })
    expect(parse).toHaveBeenCalledTimes(2)
    expect(parse.mock.calls[1]?.[0]).toEqual({ page: 1, pageSize: 10 })
  })
})

describe("offset limits", () => {
  it("rejects a page whose offset exceeds the maximum, accepting the boundary", async () => {
    const { handler } = setup({ options: { queryLimits: { maxOffset: 20 } } })
    expect((await get(handler, q({ page: "3", pageSize: "10" }))).status).toBe(200)
    const over = await get(handler, q({ page: "4", pageSize: "10" }))
    expect(over.status).toBe(400)
    expect(lastError()).toEqual(new ValidationError("pagination offset exceeds the configured maximum of 20"))
    expect((await get(handler, q({ page: "2", pageSize: "20" }))).status).toBe(200)
    expect((await get(handler, q({ page: "2", pageSize: "21" }))).status).toBe(400)
  })

  it("applies the same limit after a transformQuery hook rewrote the page", async () => {
    const transformQuery = async () => ({ query: { page: 9, pageSize: 10 } })
    const { handler } = setup({ options: { queryLimits: { maxOffset: 20 }, crud: { list: { transformQuery } } } })
    const response = await get(handler)
    expect(response.status).toBe(400)
    expect(lastError()).toEqual(new ValidationError("pagination offset exceeds the configured maximum of 20"))
    const ok = setup({ options: { queryLimits: { maxOffset: 20 }, crud: { list: { transformQuery: async () => ({ query: { page: 3, pageSize: 10 } }) } } } })
    expect((await get(ok.handler)).status).toBe(200)
  })

  it("rejects a result count above the maximum with a bounded probe, before the page query", async () => {
    const order: string[] = []
    const countUpTo = vi.fn(async () => { order.push("probe"); return 3 })
    const over = setup({ options: { queryLimits: { maxCount: 2 } }, countUpTo })
    over.repo.findMany.mockImplementation(async () => { order.push("page"); return page() })
    expect((await get(over.handler)).status).toBe(400)
    expect(lastError()).toEqual(new ValidationError("query result count exceeds the configured maximum of 2"))
    // maxCount + 1 rows is the most the probe may read, and the page query never ran.
    expect(countUpTo).toHaveBeenCalledWith(undefined, 3)
    expect(order).toEqual(["probe"])
    expect(over.repo.findMany).not.toHaveBeenCalled()
  })

  it("accepts a result count at the boundary, probing first and then reading the page with a total", async () => {
    const order: string[] = []
    const countUpTo = vi.fn(async () => { order.push("probe"); return 2 })
    const exact = setup({ options: { queryLimits: { maxCount: 2 } }, countUpTo })
    exact.repo.findMany.mockImplementation(async () => { order.push("page"); return page(rowsFixture(), { rowCount: 2 }) })
    const response = await get(exact.handler)
    expect(response.status).toBe(200)
    expect(order).toEqual(["probe", "page"])
    expect((await json(response)).rowCount).toBe(2)
  })

  it("applies the probe to the caller's filter and read scope, not to a page position", async () => {
    const R = Predicate.eq("name", "readable")
    const countUpTo = vi.fn(async () => 1)
    const scoped = setup({ options: { queryLimits: { maxCount: 5 } }, readFilter: R, countUpTo })
    await get(scoped.handler, q({ page: "4" }))
    expect(countUpTo).toHaveBeenCalledWith(R, 6)
    expect(scoped.find()[0]?.filter).toEqual(R)
  })

  it("falls back to a one-row page with a total when the repository has no bounded probe", async () => {
    const over = setup({ options: { queryLimits: { maxCount: 2 } }, result: page(rowsFixture(), { rowCount: 3 }) })
    expect((await get(over.handler)).status).toBe(400)
    expect(lastError()).toEqual(new ValidationError("query result count exceeds the configured maximum of 2"))
    expect(over.find()).toEqual([{ pagination: { kind: "offset", page: 1, pageSize: 1, includeTotal: true } }])
    const exact = setup({ options: { queryLimits: { maxCount: 2 } }, result: page(rowsFixture(), { rowCount: 2 }) })
    expect((await get(exact.handler)).status).toBe(200)
  })

  it("probes cursor pages too, and cursor pages answer without a total", async () => {
    const countUpTo = vi.fn(async () => 9)
    const over = setup({ defaultSort: SORT_ID, options: { ...cursorOptions(), queryLimits: { maxCount: 2 } }, countUpTo })
    expect((await get(over.handler)).status).toBe(400)
    expect(over.repo.findMany).not.toHaveBeenCalled()
    const ok = setup({ defaultSort: SORT_ID, options: cursorOptions(), result: { rows: rowsFixture(), page: 1, pageSize: 10, pageInfo: { kind: "cursor", hasNextPage: false, hasPreviousPage: false } } })
    const body = await json(await get(ok.handler))
    expect(body).not.toHaveProperty("rowCount")
    expect((ok.find()[0]?.pagination as Record<string, unknown>)).not.toHaveProperty("includeTotal")
    const stray = setup({ defaultSort: SORT_ID, options: cursorOptions(), result: page(rowsFixture(), { rowCount: 7 }) })
    expect(await json(await get(stray.handler))).not.toHaveProperty("rowCount")
  })

  it("omits the probe when no maxCount is configured", async () => {
    const countUpTo = vi.fn(async () => 99)
    const free = setup({ countUpTo })
    expect((await get(free.handler)).status).toBe(200)
    expect(countUpTo).not.toHaveBeenCalled()
  })
})

describe("filters and sorting", () => {
  const search = (text: string) => JSON.stringify({ search: text })

  it("conjoins the structural scope, the read scope and the caller's search", async () => {
    const S = Predicate.eq("name", "scoped")
    const R = Predicate.eq("name", "readable")
    const filters = search("abc")
    const expectedSearch = filtersToPredicate(filters, ["name"], ["id", "name"])
    const both = setup({ options: { entityScope: { kind: "platform", scopeFilter: S } }, readFilter: R })
    await get(both.handler)
    expect(both.find()[0]?.filter).toEqual(Predicate.and(markTrustedPredicate(S), R))
    const all = setup({ options: { entityScope: { kind: "platform", scopeFilter: S } }, readFilter: R })
    await get(all.handler, q({ filters }))
    expect(all.find()[0]?.filter).toEqual(Predicate.and(markTrustedPredicate(S), R, expectedSearch as PredicateNode))
    const structuralOnly = setup({ options: { entityScope: { kind: "platform", scopeFilter: S } } })
    await get(structuralOnly.handler)
    expect(structuralOnly.find()[0]?.filter).toEqual(markTrustedPredicate(S))
    const readOnly = setup({ readFilter: R })
    await get(readOnly.handler)
    expect(readOnly.find()[0]?.filter).toEqual(R)
    const searchOnly = setup()
    await get(searchOnly.handler, q({ filters }))
    expect(searchOnly.find()[0]?.filter).toEqual(expectedSearch)
    const none = setup()
    await get(none.handler)
    expect("filter" in (none.find()[0] ?? {})).toBe(false)
  })

  it("treats a filters string that yields no predicate as no filter", async () => {
    const { handler, find } = setup()
    await get(handler, q({ filters: "{}" }))
    expect("filter" in (find()[0] ?? {})).toBe(false)
  })

  it("rejects filters on non-filterable fields and malformed JSON", async () => {
    const { handler } = setup()
    expect((await get(handler, q({ filters: "not json" }))).status).toBe(400)
    expect(lastError()).toEqual(new ValidationError("Invalid filters JSON"))
  })

  it("sorts by the requested allowed fields, falling back to the default sort", async () => {
    const withDefault = setup({ defaultSort: [{ field: "name", direction: "desc" }] })
    await get(withDefault.handler)
    expect(withDefault.find()[0]?.sort).toEqual([{ field: "name", direction: "desc" }])
    await get(withDefault.handler, q({ sorting: JSON.stringify([{ id: "id", desc: true }]) }))
    expect(withDefault.find()[1]?.sort).toEqual([{ field: "id", direction: "desc" }])
    const without = setup()
    await get(without.handler)
    expect("sort" in (without.find()[0] ?? {})).toBe(false)
    expect((await get(without.handler, q({ sorting: JSON.stringify([{ id: "tenantId" }]) }))).status).toBe(400)
  })

  it("bounds the sorting JSON by the configured byte limit", async () => {
    const sorting = JSON.stringify([{ id: "id" }])
    const exact = setup({ options: { queryLimits: { maxSortJsonBytes: sorting.length } } })
    expect((await get(exact.handler, q({ sorting }))).status).toBe(200)
    const tight = setup({ options: { queryLimits: { maxSortJsonBytes: sorting.length - 1 } } })
    const response = await get(tight.handler, q({ sorting }))
    expect(response.status).toBe(400)
    expect(lastError()).toEqual(new ValidationError(`Sorting JSON exceeds the maximum of ${sorting.length - 1} UTF-8 bytes`))
  })

  it("bounds the filters JSON by the configured byte limit, accepting the boundary", async () => {
    const filters = search("abc")
    const exact = setup({ options: { queryLimits: { maxFilterJsonBytes: filters.length } } })
    expect((await get(exact.handler, q({ filters }))).status).toBe(200)
    const tight = setup({ options: { queryLimits: { maxFilterJsonBytes: filters.length - 1 } } })
    expect((await get(tight.handler, q({ filters }))).status).toBe(400)
    expect(lastError()).toEqual(new ValidationError(`Filters JSON exceeds the maximum of ${filters.length - 1} UTF-8 bytes`))
  })

  it("bounds hook-transformed filters and sorting the same way", async () => {
    const filters = search("x".repeat(40))
    const transformQuery = async () => ({ query: { filters } })
    const tight = setup({ options: { queryLimits: { maxFilterJsonBytes: 10 }, crud: { list: { transformQuery } } } })
    expect((await get(tight.handler)).status).toBe(400)
    expect(lastError()).toEqual(new ValidationError("Filters JSON exceeds the maximum of 10 UTF-8 bytes"))
    const sorting = JSON.stringify([{ id: "id" }])
    const sortTight = setup({ options: { queryLimits: { maxSortJsonBytes: 5 }, crud: { list: { transformQuery: async () => ({ query: { sorting } }) } } } })
    expect((await get(sortTight.handler)).status).toBe(400)
    expect(lastError()).toEqual(new ValidationError("Sorting JSON exceeds the maximum of 5 UTF-8 bytes"))
    const roomy = setup({ options: { crud: { list: { transformQuery } } } })
    expect((await get(roomy.handler)).status).toBe(200)
  })

  it("rejects a query plan above the configured budget", async () => {
    const sorting = JSON.stringify([{ id: "id" }, { id: "name" }])
    const { handler } = setup({ options: { queryLimits: { maxSortFields: 1 } } })
    expect((await get(handler, q({ sorting }))).status).toBe(400)
    expect(lastError()).toEqual(new ValidationError("query exceeds maximum sort fields"))
    const ok = setup({ options: { queryLimits: { maxSortFields: 2 } } })
    expect((await get(ok.handler, q({ sorting }))).status).toBe(200)
  })

  it("rejects a plan with an invalid consistency from a custom query schema", async () => {
    const { handler } = setup({ options: { validation: { listQuery: { parse: (value: unknown) => ({ ...(value as object), consistency: "bogus" }) } } } })
    expect((await get(handler)).status).toBe(400)
    expect(lastError()).toEqual(new ValidationError("query consistency is invalid"))
  })

  it("keeps every query member through the hook's normalization", async () => {
    const seen: unknown[] = []
    const { handler } = setup({
      options: {
        validation: { listQuery: { parse: (value: unknown) => value } },
        crud: { list: { transformQuery: async ({ query }: { query: unknown }) => { seen.push(query); return { query: { page: 2 } } } } },
      },
    })
    await get(handler, q({ pageSize: "4", sorting: JSON.stringify([{ id: "id" }]), filters: "{}", fields: "id", consistency: "session" }))
    expect(seen[0]).toEqual({ page: 1, pageSize: "4", sorting: JSON.stringify([{ id: "id" }]), filters: "{}", fields: "id", consistency: "session" })
  })
})

describe("projection", () => {
  it("projects rows to the requested fields and asks the repository for them", async () => {
    const { handler, find } = setup()
    const body = await json(await get(handler, q({ fields: " id , name " })))
    expect(find()[0]?.projection).toEqual({ fields: ["id", "name"] })
    expect(body.rows).toEqual([{ id: "r1", name: "a" }, { id: "r2", name: "b" }])
    const narrow = await json(await get(handler, q({ fields: "name" })))
    expect(narrow.rows).toEqual([{ name: "a" }, { name: "b" }])
    expect("projection" in (setup().find()[0] ?? {})).toBe(false)
  })

  it("skips fields that a row does not have", async () => {
    const { handler } = setup({ result: page([{ id: "r1", name: "a" } as never]) })
    expect((await json(await get(handler, q({ fields: "id,deletedAt" })))).rows).toEqual([{ id: "r1" }])
  })

  it("rejects empty, duplicate and unknown fields", async () => {
    const { handler } = setup()
    for (const fields of ["id,,name", "id,", ",id", "id,id", " "]) {
      const response = await get(handler, q({ fields }))
      expect(response.status, fields).toBe(400)
      expect(lastError()).toEqual(new ValidationError("fields must be a comma-separated list of unique field names"))
    }
    expect((await get(handler, q({ fields: "" }))).status).toBe(200)
    const unknown = await get(handler, q({ fields: "id,ghost" }))
    expect(unknown.status).toBe(400)
    expect(lastError()).toEqual(new ValidationError("projection contains a forbidden, hidden, or non-queryable field"))
  })

  it("rejects fields that the caller's policy hides from filtering, search or sorting", async () => {
    const bundle = await allowAllAbacBundle(MODULE_KEY)
    for (const denial of [{ filter: ["name"], search: [], sort: [] }, { filter: [], search: ["name"], sort: [] }, { filter: [], search: [], sort: ["name"] }]) {
      spy.denials = denial
      const { handler } = setup({ bundle })
      const response = await get(handler, q({ fields: "id,name" }))
      expect(response.status).toBe(400)
      expect(lastError()).toEqual(new ValidationError("projection contains a forbidden, hidden, or non-queryable field"))
      expect((await get(handler, q({ fields: "id" }))).status).toBe(200)
    }
  })

  it("does not push the projection down for authorized reads or when a hook enriches rows", async () => {
    const bundle = await allowAllAbacBundle(MODULE_KEY)
    spy.denials = { filter: [], search: [], sort: [] }
    const authorized = setup({ bundle })
    const body = await json(await get(authorized.handler, q({ fields: "id" })))
    expect("projection" in (authorized.find()[0] ?? {})).toBe(false)
    expect(body.rows).toEqual([{ id: "r1" }, { id: "r2" }])
    const hooked = setup({ options: { crud: { list: { projectResult: async ({ result }: { result: unknown }) => result } } } })
    await get(hooked.handler, q({ fields: "id" }))
    expect("projection" in (hooked.find()[0] ?? {})).toBe(false)
    const nonFunction = setup({ options: { crud: { list: { projectResult: "nope" } } } })
    await get(nonFunction.handler, q({ fields: "id" }))
    expect(nonFunction.find()[0]?.projection).toEqual({ fields: ["id"] })
  })

  it("also pulls the sort fields into a cursor read's projection", async () => {
    const { handler, find } = setup({ options: cursorOptions(), defaultSort: SORT_ID })
    await get(handler, q({ fields: "name" }))
    expect(find()[0]?.projection).toEqual({ fields: ["name", "id"] })
    await get(handler, q({ fields: "id" }))
    expect(find()[1]?.projection).toEqual({ fields: ["id"] })
  })

  it("re-validates the projection after a hook rewrote the fields", async () => {
    const transformQuery = async () => ({ query: { fields: "id,id" } })
    const { handler } = setup({ options: { crud: { list: { transformQuery } } } })
    expect((await get(handler)).status).toBe(400)
    expect(lastError()).toEqual(new ValidationError("fields must be a comma-separated list of unique field names"))
  })
})

describe("pagination parameter rules", () => {
  it("rejects combined and misplaced cursor parameters", () => {
    expect(() => assertHttpPaginationParameters({ cursor: "a", before: "b" }, "cursor")).toThrow(new ValidationError("cursor and before cannot be combined"))
    expect(() => assertHttpPaginationParameters({ cursor: "a", before: "b" }, "offset")).toThrow(new ValidationError("cursor and before cannot be combined"))
    expect(() => assertHttpPaginationParameters({ cursor: "a" }, "offset")).toThrow(new ValidationError("cursor parameters are not enabled for this route"))
    expect(() => assertHttpPaginationParameters({ before: "a" }, "offset")).toThrow(new ValidationError("cursor parameters are not enabled for this route"))
    expect(() => assertHttpPaginationParameters({ limit: 5 }, "offset")).toThrow(new ValidationError("cursor parameters are not enabled for this route"))
    expect(() => assertHttpPaginationParameters({ cursor: "a", page: 1 }, "cursor")).toThrow(new ValidationError("cursor and offset pagination parameters cannot be combined"))
    expect(() => assertHttpPaginationParameters({ before: "a", pageSize: 1 }, "cursor")).toThrow(new ValidationError("cursor and offset pagination parameters cannot be combined"))
    expect(() => assertHttpPaginationParameters({ limit: 5, page: 1 }, "cursor")).toThrow(new ValidationError("cursor and offset pagination parameters cannot be combined"))
  })

  it("accepts the valid combinations", () => {
    expect(() => assertHttpPaginationParameters({}, "offset")).not.toThrow()
    expect(() => assertHttpPaginationParameters({ page: 1, pageSize: 5 }, "offset")).not.toThrow()
    expect(() => assertHttpPaginationParameters({}, "cursor")).not.toThrow()
    expect(() => assertHttpPaginationParameters({ page: 1 }, "cursor")).not.toThrow()
    expect(() => assertHttpPaginationParameters({ pageSize: 1 }, "cursor")).not.toThrow()
    expect(() => assertHttpPaginationParameters({ cursor: "a", limit: 5 }, "cursor")).not.toThrow()
    expect(() => assertHttpPaginationParameters({ limit: 5 }, "cursor")).not.toThrow()
    expect(() => assertHttpPaginationParameters({ before: "a" }, "cursor")).not.toThrow()
  })

  it("applies the rules per request, defaulting to offset pagination", async () => {
    const { handler } = setup()
    expect((await get(handler, q({ limit: "5" }))).status).toBe(400)
    expect(lastError()).toEqual(new ValidationError("cursor parameters are not enabled for this route"))
    const cursor = setup({ options: cursorOptions(), defaultSort: SORT_ID })
    expect((await get(cursor.handler, q({ limit: "5", page: "1" }))).status).toBe(400)
    expect(lastError()).toEqual(new ValidationError("cursor and offset pagination parameters cannot be combined"))
  })
})

describe("cache scope key", () => {
  it("encodes the partition, the owner and the scope key injectively", () => {
    expect(listCacheScope({ partition: "p", scope: { kind: "tenant", tenantId: "t1" }, scopeId: "sid", cacheScopeKey: "k" })).toBe(serializeCacheKeyPart(["list-scope:v2", "p", "tenant", "t1", "k"]))
    expect(listCacheScope({ partition: "p", scope: { kind: "tenant" }, scopeId: "sid" })).toBe(serializeCacheKeyPart(["list-scope:v2", "p", "tenant", null, null]))
    expect(listCacheScope({ partition: "p", scope: { kind: "platform" }, scopeId: "sid", cacheScopeKey: "k" })).toBe(serializeCacheKeyPart(["list-scope:v2", "p", "scope", "sid", "k"]))
    expect(listCacheScope({ partition: "p", scope: { kind: "platform" }, scopeId: "sid", cacheScopeKey: undefined })).not.toBe(listCacheScope({ partition: "p", scope: { kind: "platform" }, scopeId: "sid", cacheScopeKey: "global" }))
    expect(listCacheScope({ partition: "a:b", scope: { kind: "tenant", tenantId: "c" }, scopeId: "x" })).not.toBe(listCacheScope({ partition: "a", scope: { kind: "tenant", tenantId: "b:c" }, scopeId: "x" }))
  })
})

describe("cursor pagination", () => {
  const PLATFORM_SCOPE = { kind: "platform", platformKey: "test" } as const
  const cursorSetup = (stubs: Stubs = {}, cursor: Record<string, unknown> = {}) =>
    setup({ defaultSort: SORT_ID, ...stubs, options: { ...cursorOptions(cursor), ...stubs.options } })
  const pageInfoOf = async (response: Response) => (await json(response)).pageInfo as { kind: string; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string; endCursor: string }
  const decode = (cursor: string, options: { now?: number } = {}) => decodeCursor(cursor, integrity, undefined, options)

  it("issues bound cursors for the first and last row of the page", async () => {
    const { handler } = cursorSetup()
    const info = await pageInfoOf(await get(handler))
    expect(Object.keys(info).sort()).toEqual(["endCursor", "hasNextPage", "hasPreviousPage", "kind", "startCursor"])
    expect(info.kind).toBe("cursor")
    expect(info.hasNextPage).toBe(false)
    expect(info.hasPreviousPage).toBe(false)
    const start = await decode(info.startCursor)
    const end = await decode(info.endCursor)
    expect(start.direction).toBe("before")
    expect(end.direction).toBe("after")
    expect(start.values).toEqual(["r1"])
    expect(end.values).toEqual(["r2"])
    expect(start.format).toBe("framework.cursor")
    expect(start.version).toBe(1)
    const { scopeId } = await (await contextFor("platform", "list"))
    const bindings = {
      routeHash: await fingerprintJson({ moduleKey: MODULE_KEY, entity: { name: "widget", namespace: null }, route: "list" }),
      queryHash: await fingerprintJson({ filters: null, fields: null, consistency: null }),
      scopeHash: await fingerprintJson({ scopeId, cacheScopeKey: null, securityDigest: null }),
      sortHash: await fingerprintJson(SORT_ID),
    }
    for (const payload of [start, end]) {
      expect(payload).toMatchObject(bindings)
      expect("expiresAt" in payload).toBe(false)
    }
  })

  it("binds the cursor to the entity namespace, the query, the scope key and the security digest", async () => {
    const bundle = await allowAllAbacBundle(MODULE_KEY)
    spy.denials = { filter: [], search: [], sort: [] }
    const { handler } = cursorSetup({ bundle, cacheScopeKey: "scope-k", options: { entity: unscopedEntity({ namespace: "crm" }) } })
    const filters = JSON.stringify({ search: "a" })
    const info = await pageInfoOf(await get(handler, q({ filters, fields: "id", consistency: "strong" })))
    const end = await decode(info.endCursor)
    const { scopeId } = await (await contextFor("platform", "list"))
    expect(end.routeHash).toBe(await fingerprintJson({ moduleKey: MODULE_KEY, entity: { name: "widget", namespace: "crm" }, route: "list" }))
    expect(end.queryHash).toBe(await fingerprintJson({ filters, fields: "id", consistency: "strong" }))
    expect(end.scopeHash).toBe(await fingerprintJson({ scopeId, cacheScopeKey: "scope-k", securityDigest: bundle.securityDigest }))
  })

  it("carries the repository's paging flags and ignores non-cursor page info", async () => {
    const flagged = cursorSetup({ result: page(rowsFixture(), { pageInfo: { kind: "cursor", hasNextPage: true, hasPreviousPage: true } }) })
    const info = await pageInfoOf(await get(flagged.handler))
    expect(info.hasNextPage).toBe(true)
    expect(info.hasPreviousPage).toBe(true)
    const nextOnly = cursorSetup({ result: page(rowsFixture(), { pageInfo: { kind: "cursor", hasNextPage: true } }) })
    const second = await pageInfoOf(await get(nextOnly.handler))
    expect([second.hasNextPage, second.hasPreviousPage]).toEqual([true, false])
    const other = cursorSetup({ result: page(rowsFixture(), { pageInfo: { kind: "offset", hasNextPage: true, hasPreviousPage: true } }) })
    const third = await pageInfoOf(await get(other.handler))
    expect([third.hasNextPage, third.hasPreviousPage]).toEqual([false, false])
  })

  it("keeps the repository's page info for an empty page and adds none for offset pagination", async () => {
    const empty = cursorSetup({ result: page([], { pageInfo: { kind: "cursor", hasNextPage: false, hasPreviousPage: false } }) })
    expect((await json(await get(empty.handler))).pageInfo).toEqual({ kind: "cursor", hasNextPage: false, hasPreviousPage: false })
    const none = cursorSetup({ result: page([]) })
    expect("pageInfo" in (await json(await get(none.handler)))).toBe(false)
    const offset = setup({ result: page(rowsFixture(), { pageInfo: { kind: "cursor", hasNextPage: true, hasPreviousPage: false } }) })
    expect((await json(await get(offset.handler))).pageInfo).toEqual({ kind: "cursor", hasNextPage: true, hasPreviousPage: false })
  })

  it("serializes the sort values of the first and last row, dates as ISO strings", async () => {
    const date = new Date("2026-01-02T03:04:05.000Z")
    const rows = [{ id: "r1", name: date, count: 0 }, { id: "r2", name: null, count: false }] as never as Row[]
    const { handler } = cursorSetup({ result: page(rows), defaultSort: [{ field: "name", direction: "asc" }, { field: "id", direction: "asc" }] })
    const info = await pageInfoOf(await get(handler))
    expect((await decode(info.startCursor)).values).toEqual([date.toISOString(), "r1"])
    expect((await decode(info.endCursor)).values).toEqual([null, "r2"])
    const mixed = cursorSetup({ result: page([{ id: 7, name: true } as never]), defaultSort: [{ field: "name", direction: "asc" }, { field: "id", direction: "asc" }] })
    expect((await decode((await pageInfoOf(await get(mixed.handler))).endCursor)).values).toEqual([true, 7])
  })

  it("refuses sort values that cannot be stored in a cursor", async () => {
    for (const bad of [{ id: "r1", name: { nested: 1 } }, { id: "r1", name: undefined }, { id: "r1", name: 1n }]) {
      const { handler } = cursorSetup({ result: page([bad as never]), defaultSort: [{ field: "name", direction: "asc" }, { field: "id", direction: "asc" }] })
      const response = await get(handler)
      expect(response.status).toBe(400)
      expect(lastError()).toEqual(new ValidationError("cursor sort field 'name' is not durable-codec serializable"))
    }
  })

  it("requires a stable sort made of queryable fields", async () => {
    const noSort = cursorSetup({ defaultSort: undefined })
    expect((await get(noSort.handler)).status).toBe(400)
    expect(lastError()).toEqual(new ValidationError("cursor pagination requires a configured stable sort"))
    const ghost = cursorSetup({ defaultSort: [{ field: "ghost", direction: "asc" }] })
    expect((await get(ghost.handler)).status).toBe(400)
    expect(lastError()).toEqual(new ValidationError("cursor sort contains a non-queryable field"))
    const unstable = cursorSetup({ defaultSort: [{ field: "name", direction: "asc" }] })
    expect((await get(unstable.handler)).status).toBe(400)
    expect(lastError()).toEqual(new ValidationError("cursor ordering must end with a unique deterministic tie breaker"))
    const nullable = cursorSetup({ defaultSort: [{ field: "name", direction: "asc" }, { field: "id", direction: "asc" }] }, { nullableFields: ["name"] })
    expect((await get(nullable.handler)).status).toBe(400)
    expect(lastError()).toEqual(new ValidationError("nullable cursor sort requires explicit null ordering"))
    const fine = cursorSetup({ defaultSort: [{ field: "name", direction: "asc" }, { field: "id", direction: "asc" }] })
    expect((await get(fine.handler)).status).toBe(200)
  })

  it("accepts a default sort field that is not in the caller's sortable list", async () => {
    const { handler } = cursorSetup({ defaultSort: [{ field: "version", direction: "asc" }, { field: "id", direction: "asc" }], options: { sortableColumns: ["name"] } }, {})
    expect((await get(handler)).status).toBe(200)
  })

  it("reads the next page after a cursor, and the previous one before it", async () => {
    const { handler, find } = cursorSetup()
    const info = await pageInfoOf(await get(handler))
    expect((await get(handler, q({ cursor: info.endCursor }))).status).toBe(200)
    expect(find()[1]?.pagination).toEqual({ kind: "cursor", direction: "after", values: ["r2"], limit: 10 })
    expect((await get(handler, q({ before: info.startCursor, limit: "3" }))).status).toBe(200)
    expect(find()[2]?.pagination).toEqual({ kind: "cursor", direction: "before", values: ["r1"], limit: 3 })
    expect(find()[0]?.pagination).toEqual({ kind: "cursor", direction: "after", limit: 10 })
    await get(handler, q({ pageSize: "4" }))
    expect(find()[3]?.pagination).toEqual({ kind: "cursor", direction: "after", limit: 4 })
    await get(handler, q({ limit: "5" }))
    expect(find()[4]?.pagination).toEqual({ kind: "cursor", direction: "after", limit: 5 })
  })

  it("rejects a cursor used in the wrong direction", async () => {
    const { handler } = cursorSetup()
    const info = await pageInfoOf(await get(handler))
    const beforeWithAfter = await get(handler, q({ before: info.endCursor }))
    expect(beforeWithAfter.status).toBe(400)
    expect(lastError()).toEqual(new ValidationError("cursor direction does not match the request parameter"))
    const afterWithBefore = await get(handler, q({ cursor: info.startCursor }))
    expect(afterWithBefore.status).toBe(400)
    expect(lastError()).toEqual(new ValidationError("cursor direction does not match the request parameter"))
  })

  it("answers a stale cursor with a restart hint carrying the request ids", async () => {
    const { handler } = cursorSetup()
    const info = await pageInfoOf(await get(handler))
    const other = cursorSetup({ options: { entity: unscopedEntity({ name: "other" }) } })
    const response = await get(other.handler, q({ cursor: info.endCursor }), { headers: { "x-correlation-id": "corr-8" } })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "Cursor is no longer valid; restart from the first page", code: "VALIDATION_ERROR" })
    expect(response.headers.get("x-correlation-id")).toBe("corr-8")
    expect(response.headers.get("x-request-id")).toBeTruthy()
    expect(response.headers.get("content-type")).toContain("application/json")
    const plain = await get(other.handler, q({ cursor: info.endCursor }))
    expect(plain.headers.get("x-correlation-id")).toBe(plain.headers.get("x-request-id"))
    expect(spy.errors).toHaveLength(0)
    expect((await get(other.handler, q({ cursor: "garbage" }))).status).toBe(400)
  })

  it("does not disguise an integrity-check failure that is not a validation error", async () => {
    const failing: CursorIntegrityPort = { sign: integrity.sign, verify: async () => { throw new Error("hsm down") } }
    const { handler } = cursorSetup({ options: { pagination: { strategy: "cursor", integrity: failing, uniqueFields: ["id"] } } })
    const info = await pageInfoOf(await get(handler))
    const response = await get(handler, q({ cursor: info.endCursor }))
    expect(response.status).toBe(500)
    expect((lastError() as Error).message).toBe("hsm down")
  })

  it("enforces the cursor size limit", async () => {
    const { handler } = cursorSetup()
    const info = await pageInfoOf(await get(handler))
    const small = cursorSetup({}, { maxCursorBytes: 20 })
    const response = await get(small.handler, q({ cursor: info.endCursor }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "Cursor is no longer valid; restart from the first page", code: "VALIDATION_ERROR" })
    const roomy = cursorSetup({}, { maxCursorBytes: 8192 })
    expect((await get(roomy.handler, q({ cursor: info.endCursor }))).status).toBe(200)
  })

  describe("with a cursor lifetime", () => {
    const ttl = 60_000

    it("stamps and enforces an expiry", async () => {
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"))
      const now = Date.now()
      const { handler, find } = cursorSetup({}, { cursorTtlMs: ttl })
      const info = await pageInfoOf(await get(handler))
      expect((await decode(info.endCursor, { now })).expiresAt).toBe(now + ttl)
      expect((await decode(info.startCursor, { now })).expiresAt).toBe(now + ttl)
      vi.setSystemTime(now + ttl - 1)
      expect((await get(handler, q({ cursor: info.endCursor }))).status).toBe(200)
      expect(find()[1]?.pagination).toEqual({ kind: "cursor", direction: "after", values: ["r2"], limit: 10 })
      vi.setSystemTime(now + ttl)
      const expired = await get(handler, q({ cursor: info.endCursor }))
      expect(expired.status).toBe(400)
      expect(await expired.json()).toEqual({ error: "Cursor is no longer valid; restart from the first page", code: "VALIDATION_ERROR" })
    })

    it("treats a cursor issued without an expiry as stale once a lifetime is configured", async () => {
      const without = cursorSetup()
      const info = await pageInfoOf(await get(without.handler))
      const withTtl = cursorSetup({}, { cursorTtlMs: ttl })
      const response = await get(withTtl.handler, q({ cursor: info.endCursor }))
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: "Cursor is no longer valid; restart from the first page", code: "VALIDATION_ERROR" })
    })
  })
})

describe("list hooks", () => {
  it("lets transformQuery merge into the query, or leave it untouched", async () => {
    const merged = setup({ options: { crud: { list: { transformQuery: async () => ({ query: { pageSize: 3 } }) } } } })
    await get(merged.handler, q({ page: "2" }))
    expect(merged.find()[0]?.pagination).toEqual({ kind: "offset", page: 2, pageSize: 3, includeTotal: true })
    for (const result of [undefined, {}, { query: undefined }]) {
      const untouched = setup({ options: { crud: { list: { transformQuery: async () => result } } } })
      expect((await get(untouched.handler, q({ page: "2" }))).status).toBe(200)
      expect(untouched.find()[0]?.pagination).toEqual({ kind: "offset", page: 2, pageSize: 10, includeTotal: true })
    }
  })

  it("passes the hook the parsed query and a read-only context", async () => {
    const transformQuery = vi.fn(async () => undefined)
    const { handler } = setup({ options: { crud: { list: { transformQuery } } } })
    await get(handler, q({ page: "2" }))
    expect(transformQuery).toHaveBeenCalledWith({ query: { page: 2, pageSize: 10 }, context: expect.objectContaining({ tenantId: "", requestId: expect.any(String) }) })
  })

  it("projects rows without a representation hook", async () => {
    const rows = [{ id: "r1", name: "a", ghost: "x" }, { id: "r2", name: "b", ghost: "y" }] as never as Row[]
    const { handler } = setup({ result: page(rows) })
    expect((await json(await get(handler))).rows).toEqual([{ id: "r1", name: "a" }, { id: "r2", name: "b" }])
  })

  it("lets projectResult enrich the page while preserving row identity", async () => {
    const projectResult = vi.fn(async ({ result }: { result: { rows: Row[] } }) => ({ ...result, summary: "extra", rows: result.rows.map((row) => ({ ...row, name: `${row.name}!`, ghost: "x" })) }))
    const { handler } = setup({ options: { crud: { list: { projectResult } } } })
    const body = await json(await get(handler))
    expect(body.summary).toBe("extra")
    expect(body.rows).toEqual([{ id: "r1", name: "a!", tenantId: "t", version: 1 }, { id: "r2", name: "b!", tenantId: "t", version: 1 }].map((row) => expect.objectContaining({ id: row.id, name: row.name })))
    expect((body.rows as Array<Record<string, unknown>>).every((row) => !("ghost" in row))).toBe(true)
    expect(projectResult).toHaveBeenCalledWith({ result: expect.objectContaining({ rowCount: 2, page: 1, pageSize: 10, rows: expect.any(Array) }), context: expect.objectContaining({ requestId: expect.any(String) }) })
  })

  it("applies the requested projection after the hook", async () => {
    const { handler } = setup({ options: { crud: { list: { projectResult: async ({ result }: { result: unknown }) => result } } } })
    expect((await json(await get(handler, q({ fields: "id" })))).rows).toEqual([{ id: "r1" }, { id: "r2" }])
  })

  it("refuses a hook that changes the number of rows", async () => {
    for (const rows of [[], rowsFixture().concat(rowsFixture())]) {
      const { handler } = setup({ options: { crud: { list: { projectResult: async ({ result }: { result: object }) => ({ ...result, rows }) } } } })
      const response = await get(handler)
      expect(response.status).toBe(403)
      expect(lastError()).toEqual(new ForbiddenError(`The 'projectResult' hook for ${MODULE_KEY}.list returned ${rows.length} rows for 2 durable rows; list projection hooks must return the same row set`))
    }
  })

  it("refuses a hook that falsifies a primary key, but not one that hides it", async () => {
    const swap = setup({ options: { crud: { list: { projectResult: async ({ result }: { result: { rows: Row[] } }) => ({ ...result, rows: [result.rows[1], result.rows[0]] }) } } } })
    const response = await get(swap.handler)
    expect(response.status).toBe(403)
    expect(lastError()).toEqual(new ForbiddenError(`The 'projectResult' hook for ${MODULE_KEY}.list changed, reordered, duplicated, removed, or fabricated the row at index 0; list projection hooks must preserve row identity`))
    const second = setup({ options: { crud: { list: { projectResult: async ({ result }: { result: { rows: Row[] } }) => ({ ...result, rows: [result.rows[0], { ...result.rows[1], id: "forged" }] }) } } } })
    expect((await get(second.handler)).status).toBe(403)
    expect(lastError()).toEqual(new ForbiddenError(`The 'projectResult' hook for ${MODULE_KEY}.list changed, reordered, duplicated, removed, or fabricated the row at index 1; list projection hooks must preserve row identity`))
    const hidden = setup({ options: { crud: { list: { projectResult: async ({ result }: { result: { rows: Row[] } }) => ({ ...result, rows: result.rows.map(({ id: _id, ...rest }) => rest) }) } } } })
    expect((await get(hidden.handler)).status).toBe(200)
  })

  it("compares keys by their string form and uses the declared primary key", async () => {
    const numeric = setup({ result: page([{ id: 1, name: "a" } as never]), options: { crud: { list: { projectResult: async ({ result }: { result: { rows: Array<Record<string, unknown>> } }) => ({ ...result, rows: [{ ...result.rows[0], id: "1" }] }) } } } })
    expect((await get(numeric.handler)).status).toBe(200)
    const keyed = setup({ options: { entity: unscopedEntity({ primaryKey: "name" }), crud: { list: { projectResult: async ({ result }: { result: { rows: Row[] } }) => ({ ...result, rows: [{ ...result.rows[0], name: "forged" }, result.rows[1]] }) } } } })
    expect((await get(keyed.handler)).status).toBe(403)
    const keyless = setup({ options: { entity: { ...unscopedEntity(), primaryKey: undefined }, crud: { list: { projectResult: async ({ result }: { result: { rows: Row[] } }) => ({ ...result, rows: [{ ...result.rows[0], id: "forged" }, result.rows[1]] }) } } } })
    expect((await get(keyless.handler)).status).toBe(403)
  })
})

describe("list caching", () => {
  const cacheOptions = (cache: ReturnType<typeof memoryCache>, extra: Record<string, unknown> = {}) => ({
    cache: { enabled: true, tag: "widgets", keyPrefix: "widgets" },
    getCacheAdapter: async () => cache.adapter,
    ...extra,
  })

  it("serves repeated reads from the cache under a scoped key and the read tags", async () => {
    const cache = memoryCache()
    const bundle = await allowAllAbacBundle(MODULE_KEY)
    spy.denials = { filter: [], search: [], sort: [] }
    const { handler, repo, buildReadTags } = setup({ bundle, cacheScopeKey: "scope-k", options: cacheOptions(cache) })
    expect((await get(handler, q({ page: "2" }))).status).toBe(200)
    expect((await get(handler, q({ page: "2" }))).status).toBe(200)
    expect(repo.findMany).toHaveBeenCalledTimes(1)
    expect((await get(handler, q({ page: "3" }))).status).toBe(200)
    expect(repo.findMany).toHaveBeenCalledTimes(2)
    const ctx = await contextFor("platform", "list")
    const expected = buildKey("widgets", listCacheScope({ partition: `abac:${bundle.securityDigest}:scope-k`, scope: ctx.scope, scopeId: ctx.scopeId, cacheScopeKey: "scope-k" }), serializeCacheKeyPart({ type: "list", query: { page: 2, pageSize: 10 } }))
    expect(cache.reads.length).toBeGreaterThan(0)
    expect(cache.reads.some((read) => read.endsWith(`:${expected}`))).toBe(true)
    expect(buildReadTags).toHaveBeenCalled()
    expect(cache.tagged.map(([tag]) => tag)).toContain("tag-a")
  })

  it("does not cache when caching is off, unscoped or hook-dependent", async () => {
    const cache = memoryCache()
    const bundle = await allowAllAbacBundle(MODULE_KEY)
    spy.denials = { filter: [], search: [], sort: [] }
    const run = async (stubs: Stubs) => { const s = setup(stubs); await get(s.handler); await get(s.handler); return s.repo.findMany.mock.calls.length }
    expect(await run({ bundle, cacheScopeKey: "k", options: cacheOptions(cache, { cache: { enabled: false, tag: "w", keyPrefix: "w" } }) })).toBe(2)
    expect(await run({ bundle, cacheScopeKey: "k", options: cacheOptions(cache, { cache: { tag: "w", keyPrefix: "w" } }) })).toBe(2)
    expect(await run({ bundle, options: cacheOptions(cache) })).toBe(2)
    expect(await run({ bundle, cacheScopeKey: "k", options: cacheOptions(cache, { crud: { list: { projectResult: async ({ result }: { result: unknown }) => result } } }) })).toBe(2)
    expect(cache.store.size).toBe(0)
    expect(await run({ bundle, cacheScopeKey: "k", options: cacheOptions(cache) })).toBe(1)
  })

  it("requires a shared linearizable cache for authorized reads but not for public ones", async () => {
    const weak = memoryCache()
    ;(weak.adapter as { capabilities: unknown }).capabilities = { tagGenerationConsistency: "eventual", coherenceScope: "local" }
    const bundle = await allowAllAbacBundle(MODULE_KEY)
    spy.denials = { filter: [], search: [], sort: [] }
    const authorized = setup({ bundle, cacheScopeKey: "k", options: cacheOptions(weak) })
    expect((await get(authorized.handler)).status).toBe(500)
    spy.anonymous = true
    const publicRead = setup({ options: cacheOptions(weak) })
    expect((await get(publicRead.handler)).status).toBe(200)
    expect((await get(publicRead.handler)).status).toBe(200)
    expect(publicRead.repo.findMany).toHaveBeenCalledTimes(1)
  })
})

describe("list read audit", () => {
  const withAudit = (extra: Record<string, unknown> = {}) => {
    const write = vi.fn(async () => undefined)
    const auditSinkFactory = vi.fn(() => ({ write }))
    return { write, auditSinkFactory, options: { audit: { enabled: true, resource: "Widget", readAudit: true }, auditSinkFactory, ...extra } }
  }

  it("records the list read with its page, size, count and a query fingerprint", async () => {
    const { write, auditSinkFactory, options } = withAudit({ adapterDeps: { ...baseOptions().adapterDeps, resolveClientIp: () => " 1.2.3.4 " } })
    const { handler } = setup({ options, result: page(rowsFixture(), { page: 2, pageSize: 5, rowCount: 7 }) })
    const response = await get(handler, q({ page: "2", pageSize: "5" }), { headers: { "user-agent": "agent/9" } })
    expect(response.status).toBe(200)
    expect(auditSinkFactory).toHaveBeenCalledWith(expect.objectContaining({ scopeId: expect.any(String) }))
    expect(write).toHaveBeenCalledOnce()
    const record = (write.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    const ctx = await contextFor("platform", "list")
    expect(record).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      occurredAt: expect.any(Date),
      actor: expect.objectContaining({ id: "actor-1" }),
      action: "Widget.readList",
      resourceType: "Widget",
      resourceId: "",
      tenantId: null,
      oldValue: null,
      newValue: null,
      metadata: {
        ipAddress: "1.2.3.4",
        userAgent: "agent/9",
        scopeId: ctx.scopeId,
        page: 2,
        pageSize: 5,
        resultCount: 7,
        queryFingerprint: await fingerprintJson({ page: 2, pageSize: 5 }),
      },
    })
  })

  it("records the tenant of a tenant-scoped read", async () => {
    const { write, options } = withAudit({
      entity: baseOptions().entity,
      entityScope: { kind: "tenant" },
      scope: { scope: "tenant" },
      requestNormalization: canonicalRequestNormalization(trustedSession({ kind: "tenant", tenantId: "tenant-1" }), MODULE_KEY),
    })
    const { handler } = setup({ options, result: page(rowsFixture().map((row) => ({ ...row, tenantId: "tenant-1" }))) })
    expect((await get(handler)).status).toBe(200)
    expect((write.mock.calls[0] as unknown as [{ tenantId: unknown }])[0].tenantId).toBe("tenant-1")
  })

  it("does not record anonymous reads, disabled read audit or reads without a sink, and survives a failing sink", async () => {
    spy.anonymous = true
    const anonymous = withAudit()
    await get(setup({ options: anonymous.options }).handler)
    expect(anonymous.write).not.toHaveBeenCalled()
    spy.anonymous = false

    const off = withAudit({ audit: { enabled: true, resource: "Widget", readAudit: false } })
    await get(setup({ options: off.options }).handler)
    expect(off.write).not.toHaveBeenCalled()
    const unset = withAudit({ audit: { enabled: true, resource: "Widget" } })
    await get(setup({ options: unset.options }).handler)
    expect(unset.write).not.toHaveBeenCalled()
    expect((await get(setup({ options: { audit: { enabled: true, resource: "Widget", readAudit: true } } }).handler)).status).toBe(200)

    const failing = withAudit()
    failing.write.mockRejectedValueOnce(new Error("sink down"))
    expect((await get(setup({ options: failing.options }).handler)).status).toBe(200)
    expect(failing.write).toHaveBeenCalledOnce()
    const throwingFactory = vi.fn(() => { throw new Error("factory down") })
    expect((await get(setup({ options: { audit: { enabled: true, resource: "Widget", readAudit: true }, auditSinkFactory: throwingFactory } }).handler)).status).toBe(200)
  })
})

describe("list field visibility", () => {
  it("never reveals fields the policy hides from the caller's query", async () => {
    const bundle = await allowAllAbacBundle(MODULE_KEY)
    spy.denials = { filter: ["name"], search: ["name"], sort: ["name"] }
    const { handler } = setup({ bundle })
    expect((await get(handler, q({ sorting: JSON.stringify([{ id: "name" }]) }))).status).toBe(400)
    expect(lastError()).toEqual(new ValidationError('Sorting by field "name" is not allowed'))
    expect((await get(handler, q({ sorting: JSON.stringify([{ id: "id" }]) }))).status).toBe(200)
  })

  it("derives query denials from the bundle's policies, catalog fields and the entity's fields", async () => {
    const bundle = await allowAllAbacBundle(MODULE_KEY)
    const { handler } = setup({ bundle: { ...bundle, fieldCatalog: { extraField: {}, name: {} } } as never })
    await get(handler)
    expect(spy.denialArgs).toHaveLength(1)
    const args = spy.denialArgs[0] as { policies: unknown; moduleKey: string; fields: string[] }
    expect(args.moduleKey).toBe(MODULE_KEY)
    expect(args.policies).toBe(bundle.policies)
    expect([...args.fields].sort()).toEqual(["deletedAt", "extraField", "id", "name", "tenantId", "version"].sort())
    const noCatalog = setup({ bundle: { ...bundle, fieldCatalog: undefined } as never })
    await get(noCatalog.handler)
    expect([...(spy.denialArgs[1] as { fields: string[] }).fields].sort()).toEqual(["deletedAt", "id", "name", "tenantId", "version"].sort())
    const anonymous = setup()
    await get(anonymous.handler)
    expect(spy.denialArgs).toHaveLength(2)
  })

  it("keeps the allowlists to the entity's own declared fields", async () => {
    const { handler } = setup({ options: { filterableColumns: ["id", "ghost", "toString"], sortableColumns: ["id", "ghost", "constructor"] } })
    expect((await get(handler, q({ sorting: JSON.stringify([{ id: "ghost" }]) }))).status).toBe(400)
    expect((await get(handler, q({ sorting: JSON.stringify([{ id: "constructor" }]) }))).status).toBe(400)
    expect((await get(handler, q({ sorting: JSON.stringify([{ id: "id" }]) }))).status).toBe(200)
    const none = setup({ options: { sortableColumns: undefined } })
    expect((await get(none.handler, q({ sorting: JSON.stringify([{ id: "id" }]) }))).status).toBe(400)
  })
})
