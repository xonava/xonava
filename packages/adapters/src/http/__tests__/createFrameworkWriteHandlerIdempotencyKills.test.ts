import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ConfigurationError, ConflictError, encodeExecutionScopeId } from "@xonava/core/domain"
import { encodeTenantIdempotencyScope } from "@xonava/core/persistence"
import type { IdempotencyCommitItem } from "@xonava/core/events"
import type { PersistenceProvider } from "@xonava/core/persistence"
import { bindAbacSecurityDigest } from "@xonava/core/domain"
import { allowAllAbacBundle, allowAllModuleFacts, canonicalRequestNormalization, trustedSession } from "./canonicalRequest"
import { MODULE, bodyOf, idempotentConfig, makeWrite, passthroughSchema, recordingCache, scriptedPort, testPersistence } from "./writeHandlerHarness"

type Captured = Record<string, unknown>

const spy = vi.hoisted(() => ({
  errors: [] as unknown[],
  contexts: [] as Captured[],
  runOverride: undefined as undefined | ((args: Captured) => Promise<unknown>),
}))

vi.mock("../handleFrameworkCoreError", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../handleFrameworkCoreError")>()
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

vi.mock("@xonava/core/operation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xonava/core/operation")>()
  return {
    ...actual,
    createOperationContext: (args: Parameters<typeof actual.createOperationContext>[0]) => {
      spy.contexts.push(args as never)
      return actual.createOperationContext(args)
    },
    runOperation: (args: Parameters<typeof actual.runOperation>[0]) => {
      if (spy.runOverride) return spy.runOverride(args as never)
      return actual.runOperation(args)
    },
  }
})

beforeEach(() => {
  spy.errors.length = 0
  spy.contexts.length = 0
  spy.runOverride = undefined
})
afterEach(() => { vi.useRealTimers() })

const lastError = () => spy.errors.at(-1)
/** Polls with the real clock (only the interval timers are faked) until the mock has been called. */
async function untilCalled(mock: { mock: { calls: unknown[] } }): Promise<void> {
  for (let attempt = 0; attempt < 400 && mock.mock.calls.length === 0; attempt++) await new Promise<void>((resolve) => setTimeout(resolve, 5))
  expect(mock.mock.calls.length).toBeGreaterThan(0)
}
type TelemetryEvent = { name: string; severity: string; timestamp: Date; attributes: Record<string, unknown> }
const eventsNamed = (emit: { mock: { calls: unknown[][] } }, name: string): TelemetryEvent[] =>
  emit.mock.calls.map((call) => call[0] as TelemetryEvent).filter((event) => event.name === name)
const PLATFORM_SCOPE_ID = encodeExecutionScopeId({ kind: "platform", platformKey: "test" })
const TENANT_SCOPE = { kind: "tenant", tenantId: "t-1" } as const
const tenantNormalization = () => canonicalRequestNormalization(trustedSession(TENANT_SCOPE), MODULE)

type AcquireRequest = { scope: string; key: string; fingerprint: string; leaseDurationMs: number }
type Completion = AcquireRequest & { token: string; result: unknown; resource?: unknown; invalidations?: string[] }

const acquireRequest = (h: { port: ReturnType<typeof scriptedPort> }, call = 0) => h.port.snapshots[call] as AcquireRequest
const completion = (h: { port: ReturnType<typeof scriptedPort> }, call = 0) => (h.port.complete.mock.calls[call] as unknown as [Completion])[0]

describe("idempotency request identity", () => {
  it("reserves platform scope under the principal scope with a fixed lease", async () => {
    const h = makeWrite(idempotentConfig())
    expect((await h.send({ key: "key-9" })).status).toBe(200)
    const request = acquireRequest(h)
    expect(request.scope).toBe(`${PLATFORM_SCOPE_ID}:${MODULE}:create:principal:${PLATFORM_SCOPE_ID}:human:actor-1:human:actor-1`)
    expect(request.key).toBe("key-9")
    expect(request.leaseDurationMs).toBe(30_000)
    expect(request.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it("reserves tenant scope under the encoded tenant and wraps the port for that tenant", async () => {
    const h = makeWrite(idempotentConfig({ scope: { scope: "tenant", idempotency: { required: true } } }), { normalization: tenantNormalization() })
    expect((await h.send({ key: "key-9" })).status).toBe(200)
    const tenantScopeId = encodeExecutionScopeId(TENANT_SCOPE)
    expect(acquireRequest(h).scope).toBe(`${encodeTenantIdempotencyScope("t-1")}:${MODULE}:create:principal:${tenantScopeId}:human:actor-1:human:actor-1`)
    expect(h.deps.createIdempotencyPort).toBeDefined()
  })

  it("asks the adapter for a port bound to the resolved request context", async () => {
    const createIdempotencyPort = vi.fn(() => scriptedPort().port as never)
    const h = makeWrite(idempotentConfig(), { deps: { createIdempotencyPort: createIdempotencyPort as never } })
    await h.send({ key: "key-1" })
    expect(createIdempotencyPort).toHaveBeenCalledOnce()
    const arg = (createIdempotencyPort.mock.calls[0] as unknown as [{ context: { scopeId: string } }])[0]
    expect(Object.keys(arg)).toEqual(["context"])
    expect(arg.context.scopeId).toBe(PLATFORM_SCOPE_ID)

    const tenant = makeWrite(idempotentConfig({ scope: { scope: "tenant", idempotency: { required: true } } }), { deps: { createIdempotencyPort: createIdempotencyPort as never }, normalization: tenantNormalization() })
    await tenant.send({ key: "key-1" })
    expect(createIdempotencyPort).toHaveBeenCalledTimes(2)
  })

  async function fingerprintFor(options: Parameters<typeof makeWrite>[0], send: Parameters<ReturnType<typeof makeWrite>["send"]>[0], extra: Parameters<typeof makeWrite>[1] = {}) {
    const h = makeWrite(idempotentConfig(options), extra)
    const response = await h.send({ key: "k", ...send })
    expect(response.status, await response.clone().text()).toBe(200)
    return acquireRequest(h).fingerprint
  }
  const schema = (parse: (v: unknown) => unknown = (v) => v) => ({ parse, parseAsync: async (v: unknown) => parse(v) })

  it("binds the fingerprint to the raw body, params and query that the client sent", async () => {
    const withBody = { validation: { body: passthroughSchema } }
    const body = (value: string) => fingerprintFor(withBody, { body: value })
    expect(await body('{"a":1}')).toBe(await body('{ "a": 1 }'))
    expect(await body('{"a":1}')).not.toBe(await body('{"a":2}'))

    const withParams = { validation: { params: schema() } }
    const params = (id: string) => fingerprintFor(withParams, { params: { id } })
    expect(await params("a")).not.toBe(await params("b"))
    expect(await params("a")).not.toBe(await fingerprintFor({}, {}))

    const withQuery = { validation: { query: schema() } }
    const query = (suffix: string) => fingerprintFor(withQuery, { url: `https://example.test/things${suffix}` })
    expect(await query("?a=1")).not.toBe(await query("?a=2"))
    expect(await query("")).not.toBe(await fingerprintFor({}, {}))
  })

  it("does not include the query when the query schema is absent, nor params when no params schema applies", async () => {
    const plain = await fingerprintFor({}, { url: "https://example.test/things?a=1" })
    expect(plain).toBe(await fingerprintFor({}, { url: "https://example.test/things?a=2" }))
    expect(plain).toBe(await fingerprintFor({}, { params: { id: "x" } }))
    const empty = await fingerprintFor({ validation: { query: schema() } }, {})
    expect(empty).not.toBe(plain)
    const noRaw = await fingerprintFor({ validation: { params: schema() } }, {})
    expect(noRaw).toBe(plain)
  })

  it("binds the fingerprint to the concurrency preconditions", async () => {
    const withHeaders = (headers: Record<string, string>) => fingerprintFor({}, { headers })
    const none = await withHeaders({})
    const ifMatch = await withHeaders({ "if-match": '"1"' })
    const ifMatchOther = await withHeaders({ "if-match": '"2"' })
    const ifNone = await withHeaders({ "if-none-match": "*" })
    const ifNoneOther = await withHeaders({ "if-none-match": '"x"' })
    expect(new Set([none, ifMatch, ifMatchOther, ifNone, ifNoneOther]).size).toBe(5)
    expect(await withHeaders({ "if-match": '"1"', "if-none-match": "*" })).not.toBe(ifMatch)
  })

  it("binds the fingerprint to the module, action and ABAC security digest", async () => {
    const bundle = (policyId: string) => bindAbacSecurityDigest({
      mode: "platform",
      moduleKey: MODULE,
      policies: [{
        source: { policyId, scopeType: "platform_default" },
        moduleKey: MODULE,
        effect: "allow",
        priority: 1,
        payload: {
          actions: ["read", "create", "update", "delete", "manage"],
          capabilities: ["manage"],
          conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } },
        },
        compiledConditions: { kind: "literal", value: true },
      }],
      context: {},
      defaultEffect: "deny",
      fieldCatalog: {},
    } as never)
    const withBundle = (policyId: string) => fingerprintFor({}, {}, { deps: { resolveAbacBundle: async () => bundle(policyId) } })
    const first = await withBundle("policy-a")
    expect(await withBundle("policy-a")).toBe(first)
    expect(await withBundle("policy-b")).not.toBe(first)
    const asUpdate = await fingerprintFor({ action: "update", routeKey: "update" }, {}, { definition: { key: `${MODULE}.update` } })
    expect(asUpdate).not.toBe(await fingerprintFor({}, {}))
  })

  it("binds the fingerprint to the authenticated actor", async () => {
    const base = await fingerprintFor({}, {})
    const other = await fingerprintFor({}, {}, { normalization: canonicalRequestNormalization(trustedSession({ kind: "platform", platformKey: "test" }, "actor-2"), MODULE) })
    expect(other).not.toBe(base)
  })
})

describe("idempotency outcomes", () => {
  it("replays a stored response without running the operation", async () => {
    const stored = { version: "v1", body: '{"id":"old"}', status: 201, headers: [["content-type", "application/json"]] }
    const port = scriptedPort("transactional", () => ({ outcome: "replay", result: stored as never }))
    const h = makeWrite(idempotentConfig(), { port })
    const response = await h.send({})
    expect(response.status).toBe(201)
    expect(await bodyOf(response)).toEqual({ id: "old" })
    expect(response.headers.get("x-request-id")).toBeTruthy()
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(h.execute).not.toHaveBeenCalled()
    expect(port.complete).not.toHaveBeenCalled()
  })

  it("refuses a reused key and an in-flight key as conflicts", async () => {
    const reused = makeWrite(idempotentConfig(), { port: scriptedPort("transactional", () => ({ outcome: "conflict" })) })
    expect((await reused.send({})).status).toBe(409)
    expect(lastError()).toEqual(new ConflictError("Idempotency-Key was reused for a different mutation"))
    const inFlight = makeWrite(idempotentConfig(), { port: scriptedPort("transactional", () => ({ outcome: "in-progress" })) })
    expect((await inFlight.send({})).status).toBe(409)
    expect(lastError()).toEqual(new ConflictError("The mutation for this Idempotency-Key is already in progress"))
    expect(reused.execute).not.toHaveBeenCalled()
    expect(inFlight.execute).not.toHaveBeenCalled()
  })

  it("retries once with the legacy fingerprint after a conflict and adopts it when that replays or acquires", async () => {
    const port = scriptedPort("transactional", (call) => call === 0 ? { outcome: "conflict" } : { outcome: "acquired", token: "legacy-token" })
    const h = makeWrite(idempotentConfig(), { port })
    expect((await h.send({})).status).toBe(200)
    expect(port.acquire).toHaveBeenCalledTimes(2)
    const first = acquireRequest(h, 0)
    const second = acquireRequest(h, 1)
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(second.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(second.fingerprint).not.toBe(first.fingerprint)
    expect({ ...second, fingerprint: first.fingerprint }).toEqual(first)
    expect(completion(h).fingerprint).toBe(second.fingerprint)
    expect(completion(h).token).toBe("legacy-token")
    expect(h.execute).toHaveBeenCalledOnce()
  })

  it("keeps the conflict when the legacy fingerprint conflicts too", async () => {
    const port = scriptedPort("transactional", () => ({ outcome: "conflict" }))
    const h = makeWrite(idempotentConfig(), { port })
    expect((await h.send({})).status).toBe(409)
    expect(port.acquire).toHaveBeenCalledTimes(2)
    expect(h.execute).not.toHaveBeenCalled()
  })

  it("replays through the legacy fingerprint", async () => {
    const stored = { version: "v1", body: '{"id":"legacy"}', status: 200, headers: [] }
    const port = scriptedPort("transactional", (call) => call === 0 ? { outcome: "conflict" } : { outcome: "replay", result: stored as never })
    const h = makeWrite(idempotentConfig(), { port })
    const response = await h.send({})
    expect(await bodyOf(response)).toEqual({ id: "legacy" })
    expect(h.execute).not.toHaveBeenCalled()
  })

  it("does not consult the legacy fingerprint when the first acquire succeeds", async () => {
    const h = makeWrite(idempotentConfig())
    await h.send({})
    expect(h.port.acquire).toHaveBeenCalledOnce()
  })
})

describe("business-committed recovery", () => {
  const committed = (extra: Record<string, unknown> = {}) => scriptedPort("transactional", () => ({ outcome: "business-committed", token: "rec-token", resource: { entity: "thing", id: "t9" }, ...extra }) as never)

  it("rebuilds, completes and replays the committed response", async () => {
    const recoverCommittedResponse = vi.fn(async () => ({ id: "t9", name: "rebuilt" }))
    const port = committed()
    const h = makeWrite(idempotentConfig({ recoverCommittedResponse }), { port })
    const response = await h.send({})
    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toEqual({ id: "t9", name: "rebuilt" })
    expect(recoverCommittedResponse).toHaveBeenCalledWith({ resource: { entity: "thing", id: "t9" }, context: expect.objectContaining({ scopeId: PLATFORM_SCOPE_ID }) })
    expect(h.execute).not.toHaveBeenCalled()
    const done = completion({ port })
    expect(done).toEqual({
      ...acquireRequest({ port }),
      token: "rec-token",
      result: { version: "v1", body: '{"id":"t9","name":"rebuilt"}', status: 200, headers: expect.arrayContaining([["cache-control", "no-store"]]) },
      resource: { entity: "thing", id: "t9" },
    })
    expect("invalidations" in done).toBe(false)
  })

  it("replays the receipt's invalidation obligations before rebuilding, not recomputed tags", async () => {
    const cache = recordingCache()
    const port = committed({ invalidations: ["tag-a", "tag-b"] })
    const h = makeWrite(idempotentConfig({ getCacheAdapter: async () => cache.adapter, invalidateTags: () => ["fresh"] }), { port })
    expect((await h.send({})).status).toBe(200)
    expect(cache.advanced).toEqual(["tag-a", "tag-b"])
    expect(cache.raw.deleteTag).not.toHaveBeenCalled()
    expect(completion({ port }).invalidations).toEqual(["tag-a", "tag-b"])
  })

  it("rejects a non-linearizable cache for the replayed obligations", async () => {
    const cache = recordingCache({ capabilities: { tagGenerationConsistency: "eventual", coherenceScope: "shared" } })
    const port = committed({ invalidations: ["tag-a"] })
    const h = makeWrite(idempotentConfig({ getCacheAdapter: async () => cache.adapter, invalidateTags: () => ["fresh"] }), { port })
    expect((await h.send({})).status).toBe(500)
    expect(port.complete).not.toHaveBeenCalled()
  })

  it("does not replay obligations the persistence already applies atomically", async () => {
    const cache = recordingCache()
    const port = committed({ invalidations: ["tag-a"] })
    const h = makeWrite(idempotentConfig({ getCacheAdapter: async () => cache.adapter, invalidateTags: () => ["fresh"] }), { port, persistence: testPersistence({ atomicBatchCacheGeneration: true }) })
    expect((await h.send({})).status).toBe(200)
    expect(cache.advanced).toEqual([])
  })

  it("fails when obligations must be replayed but no cache adapter is available", async () => {
    const port = committed({ invalidations: ["tag-a"] })
    const h = makeWrite(idempotentConfig({ getCacheAdapter: async () => recordingCache().adapter }), { port })
    expect((await h.send({})).status).toBe(500)
    expect(lastError()).toEqual(new ConfigurationError(`Cache invalidation for "${MODULE}" requires an available cache adapter`))
    expect(port.complete).not.toHaveBeenCalled()
  })

  it("replays no obligations when the receipt has none", async () => {
    const cache = recordingCache()
    const h = makeWrite(idempotentConfig({ getCacheAdapter: async () => cache.adapter, invalidateTags: () => ["fresh"] }), { port: committed() })
    expect((await h.send({})).status).toBe(200)
    expect(cache.advanced).toEqual([])
  })

  it("persists a stable conflict when the committed resource no longer exists", async () => {
    const port = committed({ invalidations: ["gone"] })
    const cache = recordingCache()
    const h = makeWrite(idempotentConfig({ recoverCommittedResponse: async () => null, getCacheAdapter: async () => cache.adapter, invalidateTags: () => ["x"] }), { port })
    const response = await h.send({})
    expect(response.status).toBe(409)
    expect(await bodyOf(response)).toEqual({ error: "Conflict", code: "CONFLICT" })
    const done = completion({ port })
    expect(done.token).toBe("rec-token")
    expect(done.resource).toEqual({ entity: "thing", id: "t9" })
    expect(done.invalidations).toEqual(["gone"])
    expect((done.result as { status: number }).status).toBe(409)
    expect(response.headers.get("x-request-id")).toBeTruthy()
    expect(lastError()).toEqual(new ConflictError("The committed resource is no longer available"))
  })

  it("persists the stable conflict without an obligation when the receipt has none", async () => {
    const port = committed()
    const h = makeWrite(idempotentConfig({ recoverCommittedResponse: async () => null }), { port })
    expect((await h.send({})).status).toBe(409)
    expect("invalidations" in completion({ port })).toBe(false)
  })

  it("fails when a business-committed receipt carries no resource to recover", async () => {
    const port = scriptedPort("transactional", () => ({ outcome: "business-committed", token: "t" }) as never)
    const h = makeWrite(idempotentConfig(), { port })
    expect((await h.send({})).status).toBe(409)
    expect(lastError()).toEqual(new ConflictError("The mutation for this Idempotency-Key committed without a replayable response"))
    expect(port.complete).not.toHaveBeenCalled()
  })
})

describe("completion and receipts", () => {
  it("completes the reservation with the serialized response, resource and lease token", async () => {
    const h = makeWrite(idempotentConfig())
    const response = await h.send({})
    expect(response.status).toBe(200)
    expect(h.port.complete).toHaveBeenCalledOnce()
    const done = completion(h)
    expect(done).toEqual({
      ...acquireRequest(h),
      token: "token-1",
      result: { version: "v1", body: '{"id":"created"}', status: 200, headers: expect.arrayContaining([["cache-control", "no-store"], ["content-type", "application/json; charset=utf-8"]]) },
      resource: { entity: "thing", id: "thing-1" },
    })
    expect("invalidations" in done).toBe(false)
    expect(await bodyOf(response)).toEqual({ id: "created" })
    expect(response.headers.get("x-request-id")).toBeTruthy()
  })

  it("resolves the resource identity from the input and the context", async () => {
    const resolveResourceIdentity = vi.fn(() => ({ entity: "thing", id: "from-input" }))
    const h = makeWrite(idempotentConfig({ resolveResourceIdentity }))
    h.resolveInput.mockResolvedValueOnce({ marker: 1 })
    await h.send({})
    expect(resolveResourceIdentity).toHaveBeenCalledWith({ input: { marker: 1 }, context: expect.objectContaining({ scopeId: PLATFORM_SCOPE_ID }) })
    expect(completion(h).resource).toEqual({ entity: "thing", id: "from-input" })
  })

  it("builds the stored response with the configured response builder", async () => {
    const toResponse = vi.fn((result: unknown) => Response.json({ wrapped: result }, { status: 202 }))
    const h = makeWrite(idempotentConfig({ toResponse }))
    const response = await h.send({})
    expect(response.status).toBe(202)
    expect(await bodyOf(response)).toEqual({ wrapped: { id: "created" } })
    expect((completion(h).result as { body: string }).body).toBe('{"wrapped":{"id":"created"}}')
    expect(toResponse).toHaveBeenCalledTimes(2)
  })

  it("answers a non-idempotent write with the response built once from the business result", async () => {
    const toResponse = vi.fn((result: unknown) => Response.json({ wrapped: result }, { status: 202 }))
    const h = makeWrite({ toResponse })
    const response = await h.send({ key: null })
    expect(response.status).toBe(202)
    expect(toResponse).toHaveBeenCalledTimes(1)
  })

  it("builds the response from the final result when the operation reports no business result", async () => {
    spy.runOverride = async () => ({ id: "from-result" })
    const h = makeWrite({})
    const response = await h.send({ key: null })
    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toEqual({ id: "from-result" })
    const withBuilder = makeWrite({ toResponse: (result: unknown) => Response.json({ via: result }, { status: 203 }) })
    const built = await withBuilder.send({ key: null })
    expect(built.status).toBe(203)
    expect(await bodyOf(built)).toEqual({ via: { id: "from-result" } })
  })

  it("records the cache invalidation obligation on the completion and invalidates after commit", async () => {
    const cache = recordingCache()
    const h = makeWrite(idempotentConfig({ getCacheAdapter: async () => cache.adapter, invalidateTags: () => ["list", "detail:1"] }))
    expect((await h.send({})).status).toBe(200)
    expect(cache.advanced).toEqual(["list", "detail:1"])
    expect(cache.raw.deleteTag).not.toHaveBeenCalled()
    expect(completion(h).invalidations).toEqual(["list", "detail:1"])
    const order = [...cache.raw.advanceTagGeneration.mock.invocationCallOrder, ...h.port.complete.mock.invocationCallOrder]
    expect(Math.max(...cache.raw.advanceTagGeneration.mock.invocationCallOrder)).toBeLessThan(Math.min(...h.port.complete.mock.invocationCallOrder))
    expect(order).toHaveLength(3)
  })

  it("passes the validated context to invalidateTags", async () => {
    const invalidateTags = vi.fn(() => ["t"])
    const h = makeWrite(idempotentConfig({ getCacheAdapter: async () => recordingCache().adapter, invalidateTags, validation: { body: passthroughSchema } }))
    await h.send({ body: '{"a":1}' })
    expect(invalidateTags).toHaveBeenCalledWith({ validatedBody: { a: 1 }, validatedParams: undefined, validatedQuery: undefined }, expect.objectContaining({ scopeId: PLATFORM_SCOPE_ID }))
  })

  it("fails the response when physical invalidation fails and keeps the reservation uncompleted", async () => {
    const cache = recordingCache({ advanceTagGeneration: vi.fn(async () => { throw new Error("cache down") }) })
    const h = makeWrite(idempotentConfig({ getCacheAdapter: async () => cache.adapter, invalidateTags: () => ["a"] }))
    expect((await h.send({})).status).toBe(500)
    expect(h.port.complete).not.toHaveBeenCalled()
    expect(h.port.abandon).not.toHaveBeenCalled()
  })

  it("rejects a cache that cannot guarantee shared linearizable invalidation", async () => {
    const cache = recordingCache({ capabilities: { tagGenerationConsistency: "eventual", coherenceScope: "shared" } })
    const h = makeWrite(idempotentConfig({ getCacheAdapter: async () => cache.adapter, invalidateTags: () => ["a"] }))
    expect((await h.send({})).status).toBe(500)
    expect(h.port.complete).not.toHaveBeenCalled()
  })

  it("leaves invalidation to the persistence when it applies cache generations atomically", async () => {
    const cache = recordingCache()
    const h = makeWrite(idempotentConfig({ getCacheAdapter: async () => cache.adapter, invalidateTags: () => ["a", "b"] }), { persistence: testPersistence({ atomicBatchCacheGeneration: true }) })
    expect((await h.send({})).status).toBe(200)
    expect(cache.advanced).toEqual([])
    expect("invalidations" in completion(h)).toBe(false)
    const markers = (spy.contexts[0]?.commitMarkers ?? []) as Array<{ name: string; batchItem?: () => unknown; commit?: unknown }>
    expect(markers.map((marker) => marker.name)).toEqual(["cache-generation:a", "cache-generation:b", "idempotency-commit"])
    expect(markers[0]?.batchItem?.()).toEqual({ kind: "cache-generation", tag: "a" })
    expect(markers[1]?.batchItem?.()).toEqual({ kind: "cache-generation", tag: "b" })
    expect(markers[0]?.commit).toBeUndefined()
  })

  it("does not treat a truthy non-true capability flag as atomic cache generation", async () => {
    const cache = recordingCache()
    const h = makeWrite(idempotentConfig({ getCacheAdapter: async () => cache.adapter, invalidateTags: () => ["a"] }), { persistence: testPersistence({ atomicBatchCacheGeneration: "yes" }) })
    await h.send({})
    expect(cache.advanced).toEqual(["a"])
  })

  it("does not use atomic cache generation without invalidation tags", async () => {
    const h = makeWrite(idempotentConfig(), { persistence: testPersistence({ atomicBatchCacheGeneration: true }) })
    await h.send({})
    expect((spy.contexts[0]?.commitMarkers as unknown[]).length).toBe(1)
  })
})

describe("invalidation tag limits", () => {
  const run = async (tags: string[]) => {
    const cache = recordingCache()
    const h = makeWrite(idempotentConfig({ getCacheAdapter: async () => cache.adapter, invalidateTags: () => tags }))
    const response = await h.send({})
    return { response, cache, h }
  }

  it("accepts fifty tags and rejects fifty-one", async () => {
    const fifty = Array.from({ length: 50 }, (_, index) => `t${index}`)
    const ok = await run(fifty)
    expect(ok.response.status).toBe(200)
    expect(ok.cache.advanced).toHaveLength(50)
    const tooMany = await run([...fifty, "t50"])
    expect(tooMany.response.status).toBe(500)
    expect(lastError()).toEqual(new ConfigurationError("Invalidation tag count 51 exceeds maximum 50"))
    expect(tooMany.h.execute).not.toHaveBeenCalled()
    expect(tooMany.h.port.acquire).not.toHaveBeenCalled()
  })

  it("accepts a tag of 255 bytes and rejects 256, counting bytes rather than characters", async () => {
    expect((await run(["a".repeat(255)])).response.status).toBe(200)
    const long = "a".repeat(256)
    expect((await run([long])).response.status).toBe(500)
    expect(lastError()).toEqual(new ConfigurationError(`Invalidation tag "${long}" exceeds maximum byte length of 255`))
    const multibyte = "é".repeat(128)
    expect(multibyte.length).toBe(128)
    expect((await run([multibyte])).response.status).toBe(500)
  })

  it("checks every tag, not just the first", async () => {
    expect((await run(["ok", "b".repeat(300)])).response.status).toBe(500)
  })

  it("accepts an empty tag list without touching the cache", async () => {
    const { response, cache } = await run([])
    expect(response.status).toBe(200)
    expect(cache.advanced).toEqual([])
  })
})

describe("commit markers", () => {
  it("joins the idempotency receipt to the business transaction for a transactional port", async () => {
    const h = makeWrite(idempotentConfig())
    await h.send({})
    const markers = spy.contexts[0]?.commitMarkers as Array<{ name: string; commit?: (r: unknown, p: PersistenceProvider) => Promise<void>; batchItem?: unknown }>
    expect(markers).toHaveLength(1)
    expect(markers[0]?.name).toBe("idempotency-commit")
    expect(markers[0]?.batchItem).toBeUndefined()
    expect(h.port.markCommittedInTransaction).toHaveBeenCalledOnce()
    const [receipt, persistence] = h.port.markCommittedInTransaction.mock.calls[0] as unknown as [IdempotencyCommitItem, PersistenceProvider]
    const request = acquireRequest(h)
    expect(receipt).toEqual({ scope: request.scope, key: request.key, fingerprint: request.fingerprint, token: "token-1", resource: { entity: "thing", id: "thing-1" } })
    expect(persistence).toBeDefined()
    expect(h.port.markCommittedInTransaction.mock.contexts[0]).toBe(h.port.port)
  })

  it("lists the receipt's invalidation obligation when cache generations are not atomic", async () => {
    const cache = recordingCache()
    const h = makeWrite(idempotentConfig({ getCacheAdapter: async () => cache.adapter, invalidateTags: () => ["a"] }))
    await h.send({})
    const [receipt] = h.port.markCommittedInTransaction.mock.calls[0] as unknown as [IdempotencyCommitItem]
    expect(receipt.invalidations).toEqual(["a"])
  })

  it("joins the receipt to the atomic batch for an atomic-batch port on a capable persistence", async () => {
    const port = scriptedPort("atomic-batch")
    const h = makeWrite(idempotentConfig(), { port, persistence: testPersistence({ atomicBatchIdempotency: true }) })
    const response = await h.send({})
    expect(response.status, await response.clone().text()).toBe(200)
    const markers = spy.contexts[0]?.commitMarkers as Array<{ name: string; commit?: unknown; batchItem?: () => unknown }>
    expect(markers).toHaveLength(1)
    expect(markers[0]?.name).toBe("idempotency-commit")
    expect(markers[0]?.commit).toBeUndefined()
    expect(markers[0]?.batchItem?.()).toBe(port.batchItem)
    const [receipt] = port.createCommitBatchItem.mock.calls[0] as unknown as [IdempotencyCommitItem]
    const request = acquireRequest({ port })
    expect(receipt).toEqual({ scope: request.scope, key: request.key, fingerprint: request.fingerprint, token: "token-1", resource: { entity: "thing", id: "thing-1" } })
    expect(port.createCommitBatchItem.mock.contexts[0]).toBe(port.port)
  })

  it("refuses an atomic-batch port on a persistence that cannot join the batch", async () => {
    for (const capabilities of [{}, { atomicBatchIdempotency: false }, { atomicBatchIdempotency: "yes" }]) {
      const port = scriptedPort("atomic-batch")
      const h = makeWrite(idempotentConfig(), { port, persistence: testPersistence(capabilities) })
      expect((await h.send({})).status).toBe(500)
      expect(lastError()).toEqual(new ConfigurationError(`"${MODULE}" requires atomic-batch idempotency persistence for the configured D1 idempotency port`))
      expect(h.execute).not.toHaveBeenCalled()
      expect(port.abandon).not.toHaveBeenCalled()
    }
  })

  it("does not need atomic-batch persistence for a transactional port", async () => {
    for (const capabilities of [{}, { atomicBatchIdempotency: true }]) {
      const h = makeWrite(idempotentConfig(), { persistence: testPersistence(capabilities) })
      expect((await h.send({})).status).toBe(200)
    }
  })

  it("passes no commit markers when there is no reservation and no atomic cache generation", async () => {
    const h = makeWrite({})
    await h.send({ key: null })
    expect("commitMarkers" in (spy.contexts[0] ?? {})).toBe(false)
  })
})

describe("reservation release", () => {
  it("abandons the reservation when resolving the input fails, and rethrows the failure", async () => {
    const h = makeWrite(idempotentConfig())
    h.resolveInput.mockRejectedValueOnce(new Error("bad input"))
    expect((await h.send({})).status).toBe(500)
    expect(h.port.abandon).toHaveBeenCalledOnce()
    expect(h.port.abandon.mock.calls[0]).toEqual([{ ...acquireRequest(h), token: "token-1" }])
    expect((lastError() as Error).message).toBe("bad input")
    expect(h.execute).not.toHaveBeenCalled()
  })

  it("abandons the reservation when resolving the existing record fails", async () => {
    const h = makeWrite(idempotentConfig({ resolveExistingRecord: async () => { throw new Error("lookup failed") } }))
    expect((await h.send({})).status).toBe(500)
    expect(h.port.abandon).toHaveBeenCalledOnce()
    expect((lastError() as Error).message).toBe("lookup failed")
  })

  it("abandons the reservation when the operation fails", async () => {
    const h = makeWrite(idempotentConfig(), { execute: async () => { throw new Error("business failure") } })
    expect((await h.send({})).status).toBe(500)
    expect(h.port.abandon).toHaveBeenCalledOnce()
    expect(h.port.complete).not.toHaveBeenCalled()
    expect((lastError() as Error).message).toBe("business failure")
  })

  it("does not abandon anything when the write succeeds", async () => {
    const h = makeWrite(idempotentConfig())
    await h.send({})
    expect(h.port.abandon).not.toHaveBeenCalled()
  })

  it("tolerates a port without an abandon method", async () => {
    const port = scriptedPort("transactional")
    const bare = { ...port.port } as { abandon?: unknown }
    delete bare.abandon
    const h = makeWrite(idempotentConfig(), { port: { ...port, port: bare as never }, execute: async () => { throw new Error("business failure") } })
    expect((await h.send({})).status).toBe(500)
    expect((lastError() as Error).message).toBe("business failure")
  })

  it("reports a failed release through telemetry and still surfaces the original failure", async () => {
    const emit = vi.fn()
    const port = scriptedPort("transactional")
    port.abandon.mockRejectedValueOnce(new TypeError("release failed"))
    const h = makeWrite(idempotentConfig(), { port, deps: { telemetry: { emit } }, execute: async () => { throw new Error("business failure") } })
    expect((await h.send({})).status).toBe(500)
    expect((lastError() as Error).message).toBe("business failure")
    const events = eventsNamed(emit, "idempotency.abandon.failure")
    expect(events).toHaveLength(1)
    const event = events[0]!
    expect(event.name).toBe("idempotency.abandon.failure")
    expect(event.severity).toBe("warn")
    expect(event.timestamp).toBeInstanceOf(Date)
    expect(event.attributes).toEqual({ phase: "idempotency-abandon", errorType: "TypeError" })
  })

  it("labels a non-Error release failure as unknown, and works without telemetry", async () => {
    const emit = vi.fn()
    const port = scriptedPort("transactional")
    port.abandon.mockRejectedValueOnce("plain string")
    const h = makeWrite(idempotentConfig(), { port, deps: { telemetry: { emit } }, execute: async () => { throw new Error("business failure") } })
    await h.send({})
    expect(eventsNamed(emit, "idempotency.abandon.failure")[0]?.attributes.errorType).toBe("unknown")

    const quiet = scriptedPort("transactional")
    quiet.abandon.mockRejectedValueOnce(new Error("x"))
    const noTelemetry = makeWrite(idempotentConfig(), { port: quiet, execute: async () => { throw new Error("business failure") } })
    expect((await noTelemetry.send({})).status).toBe(500)
    expect((lastError() as Error).message).toBe("business failure")
  })
})

describe("lease heartbeat", () => {
  async function runWithGate(telemetry?: { emit: ReturnType<typeof vi.fn> }, renew?: () => Promise<void>) {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const port = scriptedPort("transactional")
    if (renew) port.renew.mockImplementation(async () => { await renew(); return undefined })
    const h = makeWrite(idempotentConfig(), { port, ...(telemetry ? { deps: { telemetry } } : {}), execute: async () => { await gate; return { id: "slow" } } })
    const pending = h.send({})
    await untilCalled(h.execute)
    return { h, port, pending, release: () => release() }
  }

  it("renews the lease every third of the lease duration, with the lease token", async () => {
    const { h, port, pending, release } = await runWithGate()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(port.renew).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(port.renew).toHaveBeenCalledTimes(1)
    expect(port.renew.mock.calls[0]).toEqual([{ ...acquireRequest(h), token: "token-1" }])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(port.renew).toHaveBeenCalledTimes(2)
    release()
    await pending
  })

  it("stops renewing once the operation settles", async () => {
    const { port, pending, release } = await runWithGate()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(port.renew).toHaveBeenCalledTimes(1)
    release()
    expect((await pending).status).toBe(200)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(port.renew).toHaveBeenCalledTimes(1)
  })

  it("stops renewing when the operation fails", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    let fail: (error: Error) => void = () => undefined
    const gate = new Promise<void>((_resolve, reject) => { fail = reject })
    const port = scriptedPort("transactional")
    const h = makeWrite(idempotentConfig(), { port, execute: async () => { await gate; return {} } })
    const pending = h.send({})
    await untilCalled(h.execute)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(port.renew).toHaveBeenCalledTimes(1)
    fail(new Error("stop"))
    expect((await pending).status).toBe(500)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(port.renew).toHaveBeenCalledTimes(1)
  })

  it("reports a failed renewal through telemetry without failing the write", async () => {
    const emit = vi.fn()
    const { pending, release } = await runWithGate({ emit }, async () => { throw new RangeError("lost lease") })
    await vi.advanceTimersByTimeAsync(10_000)
    release()
    expect((await pending).status).toBe(200)
    const events = eventsNamed(emit, "idempotency.heartbeat.failure")
    expect(events).toHaveLength(1)
    const event = events[0]!
    expect(event.name).toBe("idempotency.heartbeat.failure")
    expect(event.severity).toBe("error")
    expect(event.timestamp).toBeInstanceOf(Date)
    expect(event.attributes).toEqual({ phase: "idempotency-heartbeat", effectName: "renew", errorType: "RangeError" })
  })

  it("labels a non-Error renewal failure as unknown and tolerates missing telemetry", async () => {
    const emit = vi.fn()
    const first = await runWithGate({ emit }, async () => { throw "nope" })
    await vi.advanceTimersByTimeAsync(10_000)
    first.release()
    await first.pending
    expect(eventsNamed(emit, "idempotency.heartbeat.failure")[0]?.attributes.errorType).toBe("unknown")

    const second = await runWithGate(undefined, async () => { throw new Error("quiet") })
    await vi.advanceTimersByTimeAsync(10_000)
    second.release()
    expect((await second.pending).status).toBe(200)
  })

  it("starts no heartbeat for a write without a reservation", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    const h = makeWrite({})
    const response = await h.send({ key: null })
    expect(response.status).toBe(200)
    expect(vi.getTimerCount()).toBe(0)
  })
})
