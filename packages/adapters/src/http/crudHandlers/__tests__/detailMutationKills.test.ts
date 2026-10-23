import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildKey, serializeCacheKeyPart } from "@xonava/core/cache"
import { ConfigurationError, NotFoundError, Predicate, type RequestContext } from "@xonava/core/domain"
import { createDetailHandler } from "../detail"
import { listCacheScope } from "../list"
import {
  MODULE_KEY,
  baseOptions,
  fakeRepo,
  keylessEntity,
  memoryCache,
  persistenceOf,
  sharedOf,
  unscopedEntity,
  type Row,
} from "./crudUnitHarness"
import { allowAllAbacBundle, canonicalRequestNormalization, trustedSession } from "../../__tests__/canonicalRequest"

const spy = vi.hoisted(() => ({
  errors: [] as unknown[],
  normalize: [] as Array<Record<string, unknown>>,
  anonymous: false,
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
      spy.normalize.push(args as never)
      const context = await actual.normalizeCrudRequest(args)
      return spy.anonymous ? (await import("./crudUnitHarness")).asAnonymous(context) : context
    },
  }
})

beforeEach(() => {
  spy.errors.length = 0
  spy.normalize.length = 0
  spy.anonymous = false
})

const row = (over: Partial<Row> = {}): Row => ({ id: "w1", tenantId: "tenant-1", version: 3, name: "n", ...over })
const get = (handler: (request: Request, params: Record<string, string>) => Promise<Response>, init: RequestInit = {}) =>
  handler(new Request("https://example.test/widgets/w1", init), { id: "w1" })

type Stubs = {
  routes?: Record<string, boolean>
  bundle?: Awaited<ReturnType<typeof allowAllAbacBundle>> | undefined
  readFilter?: ReturnType<typeof Predicate.eq> | undefined
  cacheScopeKey?: string | undefined
  options?: Record<string, unknown>
  repo?: Record<string, unknown>
  rateLimit?: ReturnType<typeof vi.fn>
}

function setup(stubs: Stubs = {}) {
  const repo = fakeRepo({ findOneWhere: vi.fn(async () => row()), findById: vi.fn(async () => row()), ...stubs.repo })
  const persistence = persistenceOf(repo)
  const options = baseOptions({ createPersistence: () => persistence, ...stubs.options })
  const enforceReadRateLimit = stubs.rateLimit ?? vi.fn(async () => undefined)
  const buildReadTags = vi.fn(() => ["tag-a", "tag-b"])
  const readScope = { filter: stubs.readFilter, ...(stubs.cacheScopeKey !== undefined ? { cacheScopeKey: stubs.cacheScopeKey } : {}) }
  const shared = sharedOf(options, {
    routes: { list: false, detail: true, create: false, update: false, delete: false, ...stubs.routes },
    enforceReadAccess: vi.fn(async () => stubs.bundle),
    buildReadScope: vi.fn(() => readScope),
    enforceReadRateLimit,
    buildReadTags,
  })
  const handler = createDetailHandler(shared)
  return { handler, repo, persistence, options, shared, enforceReadRateLimit, buildReadTags }
}

describe("detail route availability", () => {
  it("answers 405 without any lookup when the route is disabled, and needs no route binding for it", async () => {
    const base = canonicalRequestNormalization(trustedSession({ kind: "tenant", tenantId: "tenant-1" }), MODULE_KEY)
    const requestNormalization = { ...base, routeBindings: {} }
    const { handler, repo } = setup({ routes: { detail: false }, options: { requestNormalization } })
    const response = await get(handler)
    expect(response.status).toBe(405)
    expect(await response.json()).toEqual({ error: "Method Not Allowed" })
    expect(repo.findOneWhere).not.toHaveBeenCalled()
    expect(response.headers.get("x-request-id")).toBeNull()
  })

  it("requires the detail route binding when the route is enabled", () => {
    const base = canonicalRequestNormalization(trustedSession({ kind: "tenant", tenantId: "tenant-1" }), MODULE_KEY)
    expect(() => setup({ options: { requestNormalization: { ...base, routeBindings: {} } } })).toThrow(new ConfigurationError(`CRUD handler for "${MODULE_KEY}" has no route binding "detail"`))
    expect(() => setup()).not.toThrow()
  })
})

describe("detail request", () => {
  it("normalizes the request for the detail route with the validated id and request metadata", async () => {
    const { handler } = setup({ options: { validation: { idParams: { parse: (value: unknown) => ({ id: (value as { id: string }).id, extra: 1 }) } } } })
    const response = await handler(new Request("https://example.test/widgets/w1", { headers: { "user-agent": "agent/9", "x-correlation-id": "corr-5" } }), { id: "w1" })
    expect(response.status).toBe(200)
    const call = spy.normalize[0] as { routeKey: string; pathParameters: unknown; metadata: unknown; requestId: string; correlationId: string }
    expect(call.routeKey).toBe("detail")
    expect(call.pathParameters).toEqual({ id: "w1" })
    expect(call.correlationId).toBe("corr-5")
    expect(call.metadata).toEqual({ requestId: call.requestId, ipAddress: "unknown", userAgent: "agent/9" })
  })

  it("validates the id with the default id schema when none is configured", async () => {
    const { handler } = setup({ options: { validation: {} } })
    expect((await handler(new Request("https://example.test/widgets/x"), { id: "not-a-uuid" })).status).toBe(400)
    expect((await handler(new Request("https://example.test/widgets/x"), { id: "0b2bf8b0-6f7e-4a5d-9a43-1c1f6f1a4a10" })).status).toBe(200)
  })

  it("rate limits the detail route with its own setting", async () => {
    const setting = { max: 5, timeWindow: "1 minute", consistency: "atomic" }
    const { handler, enforceReadRateLimit } = setup({ options: { rateLimit: { detail: setting, list: { max: 1, timeWindow: "1 minute", consistency: "atomic" } } } })
    const request = new Request("https://example.test/widgets/w1")
    await handler(request, { id: "w1" })
    expect(enforceReadRateLimit).toHaveBeenCalledWith("detail", setting, request, expect.objectContaining({ requestId: expect.any(String) }))
  })

  it("stamps the request and correlation ids on the response", async () => {
    const { handler } = setup()
    const response = await get(handler, { headers: { "x-correlation-id": "corr-5" } })
    expect(response.headers.get("x-correlation-id")).toBe("corr-5")
    const requestId = (spy.normalize[0] as { requestId: string }).requestId
    expect(response.headers.get("x-request-id")).toBe(requestId)
    const plain = await get(setup().handler)
    expect(plain.headers.get("x-correlation-id")).toBe(plain.headers.get("x-request-id"))
  })

  it("answers the failure with the request ids as well", async () => {
    const { handler } = setup({ repo: { findOneWhere: vi.fn(async () => null) } })
    const response = await get(handler, { headers: { "x-correlation-id": "corr-5" } })
    expect(response.status).toBe(404)
    expect(response.headers.get("x-correlation-id")).toBe("corr-5")
    expect(spy.errors.at(-1)).toEqual(new NotFoundError("widget not found"))
  })
})

describe("detail lookup", () => {
  const S = Predicate.eq("name", "scoped")
  const R = Predicate.eq("name", "readable")
  const platform = { entity: unscopedEntity(), scope: { scope: "platform" } }

  it("reads by key under the structural scope and the caller's read scope", async () => {
    const { handler, repo } = setup({ options: { ...platform, entityScope: { kind: "platform", scopeFilter: S } }, readFilter: R })
    expect((await get(handler)).status).toBe(200)
    expect(repo.findOneWhere?.mock.calls[0]).toEqual([Predicate.and(Predicate.eq("id", "w1"), Predicate.and(S, R))])
    expect(repo.findById).not.toHaveBeenCalled()
  })

  it("uses whichever scope exists, and a plain key lookup when neither does", async () => {
    const readOnly = setup({ options: platform, readFilter: R })
    await get(readOnly.handler)
    expect(readOnly.repo.findOneWhere?.mock.calls[0]).toEqual([Predicate.and(Predicate.eq("id", "w1"), R)])

    const structuralOnly = setup({ options: { ...platform, entityScope: { kind: "platform", scopeFilter: S } } })
    await get(structuralOnly.handler)
    expect(structuralOnly.repo.findOneWhere?.mock.calls[0]).toEqual([Predicate.and(Predicate.eq("id", "w1"), S)])

    const neither = setup({ options: platform })
    await get(neither.handler)
    expect(neither.repo.findById?.mock.calls[0]).toEqual(["w1"])
    expect(neither.repo.findOneWhere).not.toHaveBeenCalled()
  })

  it("keys the lookup by the declared primary key, defaulting to id", async () => {
    const keyed = setup({ options: { ...platform, entity: unscopedEntity({ primaryKey: "name" }) }, readFilter: R })
    await get(keyed.handler)
    expect(keyed.repo.findOneWhere?.mock.calls[0]).toEqual([Predicate.and(Predicate.eq("name", "w1"), R)])
    const keyless = setup({ options: { ...platform, entity: { ...keylessEntity(), tenantField: undefined } }, readFilter: R })
    await get(keyless.handler)
    expect(keyless.repo.findOneWhere?.mock.calls[0]).toEqual([Predicate.and(Predicate.eq("id", "w1"), R)])
  })

  it("falls back to a filtered page read when the repository has no keyed lookup", async () => {
    const findMany = vi.fn(async () => ({ rows: [row()], rowCount: 1, page: 1, pageSize: 1 }))
    const keyed = setup({ options: { ...platform, entity: unscopedEntity({ primaryKey: "name" }) }, readFilter: R, repo: { findOneWhere: undefined, findMany } })
    expect((await get(keyed.handler)).status).toBe(200)
    expect(findMany).toHaveBeenCalledWith({ filter: Predicate.and(Predicate.eq("name", "w1"), R) })
    const keyless = setup({ options: { ...platform, entity: { ...keylessEntity(), tenantField: undefined } }, readFilter: R, repo: { findOneWhere: undefined, findMany } })
    await get(keyless.handler)
    expect(findMany).toHaveBeenLastCalledWith({ filter: Predicate.and(Predicate.eq("id", "w1"), R) })
    const none = setup({ options: platform, readFilter: R, repo: { findOneWhere: undefined, findMany: vi.fn(async () => ({ rows: [], rowCount: 0, page: 1, pageSize: 1 })) } })
    expect((await get(none.handler)).status).toBe(404)
  })

  it("answers not found with the entity name", async () => {
    const { handler } = setup({ repo: { findOneWhere: vi.fn(async () => null) } })
    expect((await get(handler)).status).toBe(404)
    expect(spy.errors.at(-1)).toEqual(new NotFoundError("widget not found"))
    const byId = setup({ options: platform, repo: { findById: vi.fn(async () => null) } })
    expect((await get(byId.handler)).status).toBe(404)
  })

  it("projects the row and lets the representation hook enrich it", async () => {
    const projectResult = vi.fn(async ({ row: projected }: { row: Row }) => ({ ...projected, name: "enriched" }))
    const { handler } = setup({ repo: { findOneWhere: vi.fn(async () => ({ ...row(), ghost: "x" })) }, options: { crud: { detail: { projectResult } } } })
    const body = await (await get(handler)).json() as Record<string, unknown>
    expect(body).toMatchObject({ id: "w1", name: "enriched" })
    expect("ghost" in body).toBe(false)
    expect(projectResult).toHaveBeenCalledOnce()
  })
})

describe("detail caching", () => {
  const cacheOptions = (cache: ReturnType<typeof memoryCache>, extra: Record<string, unknown> = {}) => ({
    cache: { enabled: true, tag: "widgets", keyPrefix: "widgets" },
    getCacheAdapter: async () => cache.adapter,
    ...extra,
  })

  it("serves repeated reads from the cache under a scoped key and the read tags", async () => {
    const cache = memoryCache()
    const bundle = await allowAllAbacBundle(MODULE_KEY)
    const { handler, repo } = setup({ bundle, cacheScopeKey: "scope-k", options: cacheOptions(cache) })
    expect((await get(handler)).status).toBe(200)
    expect((await get(handler)).status).toBe(200)
    expect(repo.findOneWhere).toHaveBeenCalledTimes(1)
    const context = (await import("./crudUnitHarness")).contextFor
    const ctx: RequestContext = await context("tenant", "detail")
    const key = buildKey("widgets", listCacheScope({ partition: `abac:${bundle.securityDigest}:scope-k`, scope: ctx.scope, scopeId: ctx.scopeId, cacheScopeKey: "scope-k" }), serializeCacheKeyPart({ type: "detail", id: "w1" }))
    expect(cache.reads.length).toBeGreaterThan(0)
    expect(cache.reads.every((read) => read.endsWith(`:${key}`))).toBe(true)
    expect(cache.tagged.map(([tag]) => tag)).toEqual(expect.arrayContaining(["tag-a", "tag-b"]))
  })

  it("does not cache when caching is disabled or cannot be scoped", async () => {
    const cache = memoryCache()
    const bundle = await allowAllAbacBundle(MODULE_KEY)
    const disabled = setup({ bundle, cacheScopeKey: "scope-k", options: cacheOptions(cache, { cache: { enabled: false, tag: "widgets", keyPrefix: "widgets" } }) })
    await get(disabled.handler); await get(disabled.handler)
    expect(disabled.repo.findOneWhere).toHaveBeenCalledTimes(2)
    const unspecified = setup({ bundle, cacheScopeKey: "scope-k", options: cacheOptions(cache, { cache: { tag: "widgets", keyPrefix: "widgets" } }) })
    await get(unspecified.handler); await get(unspecified.handler)
    expect(unspecified.repo.findOneWhere).toHaveBeenCalledTimes(2)
    const unscoped = setup({ bundle, options: cacheOptions(cache) })
    await get(unscoped.handler); await get(unscoped.handler)
    expect(unscoped.repo.findOneWhere).toHaveBeenCalledTimes(2)
    expect(cache.store.size).toBe(0)
  })

  it("never caches a representation produced by a request-dependent hook", async () => {
    const cache = memoryCache()
    const bundle = await allowAllAbacBundle(MODULE_KEY)
    const projectResult = vi.fn(async ({ row: projected }: { row: Row }) => projected)
    const hooked = setup({ bundle, cacheScopeKey: "scope-k", options: cacheOptions(cache, { crud: { detail: { projectResult } } }) })
    await get(hooked.handler); await get(hooked.handler)
    expect(hooked.repo.findOneWhere).toHaveBeenCalledTimes(2)
    expect(projectResult).toHaveBeenCalledTimes(2)
  })

  it("requires a shared linearizable cache for authorized reads but not for public ones", async () => {
    const weak = memoryCache()
    ;(weak.adapter as { capabilities: unknown }).capabilities = { tagGenerationConsistency: "eventual", coherenceScope: "local" }
    const bundle = await allowAllAbacBundle(MODULE_KEY)
    const authorized = setup({ bundle, cacheScopeKey: "scope-k", options: cacheOptions(weak) })
    expect((await get(authorized.handler)).status).toBe(500)

    spy.anonymous = true
    const publicRead = setup({ options: cacheOptions(weak) })
    expect((await get(publicRead.handler)).status).toBe(200)
    expect((await get(publicRead.handler)).status).toBe(200)
  })
})

describe("detail read audit", () => {
  const withAudit = (extra: Record<string, unknown> = {}) => {
    const write = vi.fn(async () => undefined)
    const auditSinkFactory = vi.fn(() => ({ write }))
    return { write, auditSinkFactory, options: { audit: { enabled: true, resource: "Widget", readAudit: true }, auditSinkFactory, ...extra } }
  }

  it("records the read with the actor, tenant and request metadata", async () => {
    const { write, auditSinkFactory, options } = withAudit({
      adapterDeps: { ...baseOptions().adapterDeps, resolveClientIp: () => " 1.2.3.4 " },
    })
    const { handler } = setup({ options })
    const response = await get(handler, { headers: { "user-agent": "agent/9" } })
    expect(response.status).toBe(200)
    expect(auditSinkFactory).toHaveBeenCalledWith(expect.objectContaining({ scopeId: expect.any(String) }))
    expect(write).toHaveBeenCalledOnce()
    const record = (write.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    expect(record).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      occurredAt: expect.any(Date),
      actor: expect.objectContaining({ id: "actor-1" }),
      action: "Widget.read",
      resourceType: "Widget",
      resourceId: "w1",
      tenantId: "tenant-1",
      oldValue: null,
      newValue: null,
      metadata: { ipAddress: "1.2.3.4", userAgent: "agent/9", scopeId: expect.stringMatching(/^fscope:/) },
    })
  })

  it("records a null tenant outside tenant scope", async () => {
    const { write, options } = withAudit({ entity: unscopedEntity(), entityScope: undefined, scope: { scope: "platform" }, requestNormalization: canonicalRequestNormalization(trustedSession({ kind: "platform", platformKey: "test" }), MODULE_KEY) })
    const { handler } = setup({ options })
    const response = await get(handler)
    expect(response.status).toBe(200)
    expect((write.mock.calls[0] as unknown as [{ tenantId: unknown }])[0].tenantId).toBeNull()
  })

  it("does not record anonymous reads, disabled read audit or reads without a sink", async () => {
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

    const noSink = setup({ options: { audit: { enabled: true, resource: "Widget", readAudit: true } } })
    expect((await get(noSink.handler)).status).toBe(200)
  })
})
