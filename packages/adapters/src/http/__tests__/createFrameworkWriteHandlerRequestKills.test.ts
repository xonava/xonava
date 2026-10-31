import { beforeEach, describe, expect, it, vi } from "vitest"
import { ConfigurationError, ForbiddenError, RequiredHeaderMissingError, ValidationError, encodeExecutionScopeId } from "@xonava/core/domain"
import type { RateLimitStore } from "@xonava/core/rate-limit"
import type { CacheAdapter } from "@xonava/core/cache"
import type { PersistenceProvider } from "@xonava/core/persistence"
import { MAX_IDEMPOTENCY_KEY_LENGTH } from "../idempotency"
import { MODULE, bodyOf, idempotentConfig, makeWrite, passthroughSchema, scriptedPort, testPersistence } from "./writeHandlerHarness"

type Captured = Record<string, unknown>

const SCOPE_ID = encodeExecutionScopeId({ kind: "platform", platformKey: "test" })

const spy = vi.hoisted(() => ({
  errors: [] as unknown[],
  normalize: [] as Captured[],
  authorize: [] as Captured[],
  rate: [] as Captured[],
  contexts: [] as Captured[],
  runs: [] as Captured[],
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

vi.mock("../crudHandlers/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../crudHandlers/shared")>()
  return {
    ...actual,
    normalizeCrudRequest: (args: Parameters<typeof actual.normalizeCrudRequest>[0]) => {
      spy.normalize.push(args as never)
      return actual.normalizeCrudRequest(args)
    },
    authorizeFrameworkModule: (args: Parameters<typeof actual.authorizeFrameworkModule>[0]) => {
      spy.authorize.push(args as never)
      return actual.authorizeFrameworkModule(args)
    },
  }
})

vi.mock("@xonava/core/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xonava/core/rate-limit")>()
  return { ...actual, enforceRateLimit: vi.fn(async (args: Captured) => { spy.rate.push(args) }) }
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
      spy.runs.push(args as never)
      if (spy.runOverride) return spy.runOverride(args as never)
      return actual.runOperation(args)
    },
  }
})

beforeEach(() => {
  spy.errors.length = 0
  spy.normalize.length = 0
  spy.authorize.length = 0
  spy.rate.length = 0
  spy.contexts.length = 0
  spy.runs.length = 0
  spy.runOverride = undefined
})

const lastError = () => spy.errors.at(-1)

describe("response metadata", () => {
  it("sets request, correlation and no-store headers on success", async () => {
    const { send } = makeWrite()
    const response = await send({ key: null, headers: { "x-correlation-id": "corr-7" } })
    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toEqual({ id: "created" })
    expect(response.headers.get("x-correlation-id")).toBe("corr-7")
    expect(response.headers.get("cache-control")).toBe("no-store")
    const requestId = response.headers.get("x-request-id")
    expect(requestId).toBeTruthy()
    expect(spy.normalize[0]?.requestId).toBe(requestId)
    expect(spy.normalize[0]?.correlationId).toBe("corr-7")
  })

  it("falls back to the request id as the correlation id", async () => {
    const { send } = makeWrite()
    const response = await send({ key: null })
    expect(response.headers.get("x-correlation-id")).toBe(response.headers.get("x-request-id"))
  })

  it("passes the trusted client ip resolver and runtime metadata to the request metadata", async () => {
    const resolveClientIp = vi.fn(() => "9.9.9.9")
    const resolveHttpMetadata = vi.fn(() => ({ peerAddress: "10.0.0.1" }))
    const { send } = makeWrite({}, { deps: { resolveClientIp, resolveHttpMetadata } })
    await send({ key: null, headers: { "user-agent": "agent/1" } })
    expect(resolveClientIp).toHaveBeenCalledWith(expect.any(Request), { peerAddress: "10.0.0.1" })
    expect(spy.normalize[0]?.metadata).toEqual({ requestId: spy.normalize[0]?.requestId, ipAddress: "9.9.9.9", userAgent: "agent/1" })
  })

  it("uses an unknown ip and a null user agent when nothing identifies the client", async () => {
    const { send } = makeWrite()
    await send({ key: null })
    expect(spy.normalize[0]?.metadata).toEqual({ requestId: spy.normalize[0]?.requestId, ipAddress: "unknown", userAgent: null })
  })

  it("answers a failure with the request id and no-store headers too", async () => {
    const { send } = makeWrite({}, { execute: async () => { throw new Error("boom") } })
    const response = await send({ key: null })
    expect(response.status).toBe(500)
    expect(response.headers.get("x-request-id")).toBeTruthy()
    expect(response.headers.get("cache-control")).toBe("no-store")
  })
})

describe("capability selection", () => {
  it("authorizes a custom capability key and refuses a handler whose module does not grant it", async () => {
    const allowed = makeWrite({ skipCapabilityCheck: undefined, customCapabilityKey: "manage" })
    expect((await allowed.send({ key: null })).status).toBe(200)
    expect(spy.authorize[0]?.capabilityKey).toBe("manage")

    const denied = makeWrite({ skipCapabilityCheck: undefined, customCapabilityKey: "other" })
    expect((await denied.send({ key: null })).status).toBe(403)
    expect(denied.execute).not.toHaveBeenCalled()
  })

  it("does not pass a capability key when the check is skipped, even if a key is declared", async () => {
    const { send, execute } = makeWrite({ skipCapabilityCheck: true, customCapabilityKey: "other" })
    expect((await send({ key: null })).status).toBe(200)
    expect(execute).toHaveBeenCalledOnce()
    expect("capabilityKey" in (spy.authorize[0] ?? {})).toBe(false)
  })

  it("fails closed when neither a capability key nor the explicit skip is configured", async () => {
    const { send, execute } = makeWrite({ skipCapabilityCheck: undefined })
    const response = await send({ key: null })
    expect(response.status).toBe(500)
    expect(execute).not.toHaveBeenCalled()
    expect(lastError()).toEqual(new ConfigurationError(`Write handler for "${MODULE}" must either declare customCapabilityKey or set skipCapabilityCheck: true`))
  })

  it("does not treat a truthy non-true skip flag as a skip", async () => {
    const { send } = makeWrite({ skipCapabilityCheck: "yes" as never })
    expect((await send({ key: null })).status).toBe(500)
  })

  it("authorizes with the module key, action, resolved context and bundle", async () => {
    const { send } = makeWrite()
    await send({ key: null })
    const call = spy.authorize[0]
    expect(call?.moduleKey).toBe(MODULE)
    expect(call?.action).toBe("create")
    expect((call?.context as { requestId?: string }).requestId).toBe(spy.normalize[0]?.requestId)
    expect(call?.bundle).toBeTruthy()
  })
})

describe("path parameters", () => {
  const params = (parsed: unknown) => ({ params: { parse: () => parsed, parseAsync: async () => parsed } })

  it("passes only the string members of the validated params", async () => {
    const { send } = makeWrite({ validation: params({ id: "p1", count: 5, flag: true, nested: { a: 1 }, none: null }) })
    expect((await send({ key: null, params: { id: "p1" } })).status).toBe(200)
    expect(spy.normalize[0]?.pathParameters).toEqual({ id: "p1" })
    expect(Object.keys(spy.normalize[0]?.pathParameters as object)).toEqual(["id"])
  })

  it("passes an empty record when no validated member is a string", async () => {
    const { send } = makeWrite({ validation: params({ count: 5 }) })
    await send({ key: null, params: { count: "5" } })
    expect(spy.normalize[0]?.pathParameters).toEqual({})
  })

  it("omits path parameters when no params schema is configured", async () => {
    const { send } = makeWrite()
    await send({ key: null, params: { id: "p1" } })
    expect("pathParameters" in (spy.normalize[0] ?? {})).toBe(false)
  })

  it.each([["a string", "text"], ["null", null], ["zero", 0], ["undefined", undefined]])("omits path parameters when the validated params are %s", async (_label, parsed) => {
    const { send } = makeWrite({ validation: params(parsed) })
    expect((await send({ key: null, params: { id: "p1" } })).status).toBe(200)
    expect("pathParameters" in (spy.normalize[0] ?? {})).toBe(false)
  })

  it("validates the awaited route params and the unique query", async () => {
    const parse = vi.fn((value: unknown) => value)
    const queryParse = vi.fn((value: unknown) => value)
    const { send } = makeWrite({ validation: { params: { parse, parseAsync: async (v: unknown) => v }, query: { parse: queryParse, parseAsync: async (v: unknown) => v } } })
    await send({ key: null, params: { id: "p1" }, url: "https://example.test/things?a=1&b=2" })
    expect(parse).toHaveBeenCalledWith({ id: "p1" })
    expect(queryParse).toHaveBeenCalledWith({ a: "1", b: "2" })
  })

  it("refuses a duplicate query parameter as a validation error", async () => {
    const { send, execute } = makeWrite()
    const response = await send({ key: null, url: "https://example.test/things?a=1&a=2" })
    expect(response.status).toBe(400)
    expect(execute).not.toHaveBeenCalled()
    expect(lastError()).toBeInstanceOf(ValidationError)
  })
})

describe("authorization bundle", () => {
  it("refuses a request when no bundle is available", async () => {
    const { send, execute } = makeWrite({}, { deps: { resolveAbacBundle: vi.fn(async () => null) } })
    const response = await send({ key: null })
    expect(response.status).toBe(403)
    expect(execute).not.toHaveBeenCalled()
    expect(lastError()).toEqual(new ForbiddenError("ABAC authorization bundle unavailable"))
  })

  it("refuses a bundle that was not issued by the verified bundle builder", async () => {
    const { send, execute } = makeWrite({}, { deps: { resolveAbacBundle: vi.fn(async () => ({ defaultEffect: "deny", securityDigest: "x", policies: [] }) as never) } })
    const response = await send({ key: null })
    expect(response.status).toBe(500)
    expect(execute).not.toHaveBeenCalled()
    expect((lastError() as Error).message).toBe("ABAC bundle is not a verified production bundle")
  })

  it("asks the bundle resolver for this module with the resolved context", async () => {
    const resolveAbacBundle = vi.fn(async () => (await import("./canonicalRequest")).allowAllAbacBundle(MODULE))
    const { send } = makeWrite({}, { deps: { resolveAbacBundle } })
    await send({ key: null })
    expect(resolveAbacBundle).toHaveBeenCalledWith({ moduleKey: MODULE, context: spy.authorize[0]?.context })
  })
})

describe("CSRF and anonymous actors", () => {
  it("checks CSRF by default and honours an explicit opt-out", async () => {
    const checked = makeWrite()
    await checked.send({ key: null })
    expect(checked.deps.assertValidCsrf).toHaveBeenCalledOnce()
    const skipped = makeWrite({ scope: { scope: "platform", csrfRequired: false } })
    await skipped.send({ key: null })
    expect(skipped.deps.assertValidCsrf).not.toHaveBeenCalled()
  })

  it("does not require CSRF on a public scope unless configured", async () => {
    const publicScope = makeWrite({ scope: { scope: "public" } })
    await publicScope.send({ key: null })
    expect(publicScope.deps.assertValidCsrf).not.toHaveBeenCalled()
    const required = makeWrite({ scope: { scope: "public", csrfRequired: true } })
    await required.send({ key: null })
    expect(required.deps.assertValidCsrf).toHaveBeenCalledOnce()
  })
})

describe("rate limiting", () => {
  const config = { max: 5, timeWindow: "1 minute" } as const
  const store = (): RateLimitStore => ({}) as never
  const cache = (): CacheAdapter => ({}) as never

  it("namespaces the atomic key by scope, module, action, actor and ip", async () => {
    const getRateLimitStore = vi.fn(async () => store())
    const getCacheAdapter = vi.fn(async () => cache())
    const { send } = makeWrite({ rateLimit: { config }, getRateLimitStore, getCacheAdapter }, { deps: { resolveClientIp: () => "7.7.7.7" } })
    expect((await send({ key: null })).status).toBe(200)
    expect(getCacheAdapter).not.toHaveBeenCalled()
    expect(getRateLimitStore).toHaveBeenCalledOnce()
    expect(spy.rate).toHaveLength(1)
    expect(spy.rate[0]?.key).toBe(`${SCOPE_ID}:${MODULE}:create:actor-1:7.7.7.7`)
    expect(spy.rate[0]?.consistency).toBe("atomic")
    expect(spy.rate[0]?.config).toBe(config)
    expect(spy.rate[0]?.store).toBe(await getRateLimitStore.mock.results[0]?.value)
    expect("failureMode" in (spy.rate[0] ?? {})).toBe(false)
  })

  it("appends a bounded custom key after the module and action", async () => {
    const key = vi.fn((_request: Request, _context: unknown) => "tenant-key")
    const { send } = makeWrite({ rateLimit: { config, key: key as never }, getRateLimitStore: async () => store() })
    await send({ key: null })
    expect(spy.rate[0]?.key).toBe(`${SCOPE_ID}:${MODULE}:create:tenant-key`)
    expect(key).toHaveBeenCalledWith(expect.any(Request), spy.authorize[0]?.context)
  })

  it("keeps an empty custom key as the custom segment", async () => {
    const { send } = makeWrite({ rateLimit: { config, key: () => "" }, getRateLimitStore: async () => store() })
    await send({ key: null })
    expect(spy.rate[0]?.key).toBe(`${SCOPE_ID}:${MODULE}:create:`)
  })

  it("bounds an oversized custom key with a digest", async () => {
    const { send } = makeWrite({ rateLimit: { config, key: () => "k".repeat(500) }, getRateLimitStore: async () => store() })
    await send({ key: null })
    const key = spy.rate[0]?.key as string
    expect(key.startsWith(`${SCOPE_ID}:${MODULE}:create:${"k".repeat(128)}:`)).toBe(true)
    expect(key.length).toBeLessThan(500)
  })

  it("passes an explicit failure mode and omits it otherwise", async () => {
    const withMode = makeWrite({ rateLimit: { config, failureMode: "fail-open" as never }, getRateLimitStore: async () => store() })
    await withMode.send({ key: null })
    expect(spy.rate[0]?.failureMode).toBe("fail-open")
  })

  it("refuses an atomic limit without an atomic store provider or with a provider that returns none", async () => {
    const missing = makeWrite({ rateLimit: { config } })
    expect((await missing.send({ key: null })).status).toBe(500)
    expect(lastError()).toEqual(new ConfigurationError(`Atomic rate limit for "${MODULE}" requires an atomic rate-limit store`))
    const none = makeWrite({ rateLimit: { config }, getRateLimitStore: async () => null as never })
    expect((await none.send({ key: null })).status).toBe(500)
    expect(lastError()).toEqual(new ConfigurationError(`Atomic rate limit for "${MODULE}" requires an atomic rate-limit store`))
    expect(missing.execute).not.toHaveBeenCalled()
    expect(none.execute).not.toHaveBeenCalled()
  })

  it("uses the cache-backed store for best-effort limits and requires a cache adapter", async () => {
    const getCacheAdapter = vi.fn(async () => cache())
    const getRateLimitStore = vi.fn(async () => store())
    const ok = makeWrite({ rateLimit: { config, consistency: "best-effort" }, getCacheAdapter, getRateLimitStore })
    expect((await ok.send({ key: null })).status).toBe(200)
    expect(getCacheAdapter).toHaveBeenCalledOnce()
    expect(getRateLimitStore).not.toHaveBeenCalled()
    expect(spy.rate[0]?.consistency).toBe("best-effort")
    expect((spy.rate[0]?.store as object).constructor.name).toBe("CacheBackedRateLimitStore")

    const absent = makeWrite({ rateLimit: { config, consistency: "best-effort" } })
    expect((await absent.send({ key: null })).status).toBe(500)
    expect(lastError()).toEqual(new ConfigurationError(`Rate limit configured for "${MODULE}" but no cache adapter is available`))

    const unavailable = makeWrite({ rateLimit: { config, consistency: "best-effort" }, getCacheAdapter: async () => null as never })
    expect((await unavailable.send({ key: null })).status).toBe(500)
    expect(lastError()).toEqual(new ConfigurationError(`Rate limit configured for "${MODULE}" but no cache adapter is available`))
  })

  it("reads the consistency from the limit config when the handler sets none", async () => {
    const getCacheAdapter = vi.fn(async () => cache())
    const { send } = makeWrite({ rateLimit: { config: { ...config, consistency: "best-effort" } }, getCacheAdapter })
    expect((await send({ key: null })).status).toBe(200)
    expect(spy.rate[0]?.consistency).toBe("best-effort")
    expect(getCacheAdapter).toHaveBeenCalledOnce()
  })

  it("prefers the handler consistency over the config consistency", async () => {
    const getRateLimitStore = vi.fn(async () => store())
    const { send } = makeWrite({ rateLimit: { config: { ...config, consistency: "best-effort" }, consistency: "atomic" }, getRateLimitStore })
    await send({ key: null })
    expect(spy.rate[0]?.consistency).toBe("atomic")
    expect(getRateLimitStore).toHaveBeenCalledOnce()
  })

  it("loads no cache adapter when nothing needs one, and skips enforcement without a limit", async () => {
    const getCacheAdapter = vi.fn(async () => cache())
    const { send } = makeWrite({ getCacheAdapter })
    expect((await send({ key: null })).status).toBe(200)
    expect(getCacheAdapter).not.toHaveBeenCalled()
    expect(spy.rate).toHaveLength(0)
  })

  it("loads the cache adapter for invalidation even with an atomic limit", async () => {
    const getCacheAdapter = vi.fn(async () => cache())
    const { send } = makeWrite(idempotentConfig({ rateLimit: { config }, getRateLimitStore: async () => store(), getCacheAdapter, invalidateTags: () => [] }))
    await send({})
    expect(getCacheAdapter).toHaveBeenCalledOnce()
  })

  it("fails when invalidation needs a cache adapter that is unavailable", async () => {
    const { send, execute } = makeWrite(idempotentConfig({ getCacheAdapter: async () => null as never, invalidateTags: () => ["t"] }))
    expect((await send({})).status).toBe(500)
    expect(execute).not.toHaveBeenCalled()
    expect(lastError()).toEqual(new ConfigurationError(`Cache invalidation for "${MODULE}" requires an available cache adapter`))
  })
})

describe("idempotency key header", () => {
  const withKeyPort = () => scriptedPort("transactional")

  it("accepts a key of exactly the maximum length and rejects one character more", async () => {
    const accepted = makeWrite(idempotentConfig(), { port: withKeyPort() })
    expect((await accepted.send({ key: "k".repeat(MAX_IDEMPOTENCY_KEY_LENGTH) })).status).toBe(200)
    const rejected = makeWrite(idempotentConfig(), { port: withKeyPort() })
    const response = await rejected.send({ key: "k".repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1) })
    expect(response.status).toBe(400)
    expect(lastError()).toEqual(new ValidationError("Idempotency-Key is too long"))
    expect(rejected.execute).not.toHaveBeenCalled()
  })

  it("trims the key and treats a blank key as absent", async () => {
    const port = withKeyPort()
    const trimmed = makeWrite(idempotentConfig(), { port })
    await trimmed.send({ key: "  spaced-key  " })
    expect((port.acquire.mock.calls[0] as unknown as [{ key: string }])[0].key).toBe("spaced-key")

    const blank = makeWrite(idempotentConfig(), { port: withKeyPort() })
    const response = await blank.send({ key: "   " })
    expect(response.status).toBe(400)
    expect(lastError()).toEqual(new RequiredHeaderMissingError("Idempotency-Key"))
    expect(await bodyOf(response)).toEqual({ error: "A required request header is missing", code: "REQUIRED_HEADER_MISSING", details: { header: "Idempotency-Key" } })
  })

  it("requires the key only when the scope marks idempotency required", async () => {
    const optional = makeWrite({ scope: { scope: "platform", idempotency: { required: false } } })
    expect((await optional.send({ key: null })).status).toBe(200)
    const absent = makeWrite({ scope: { scope: "platform" } })
    expect((await absent.send({ key: null })).status).toBe(200)
  })

  it("refuses a supplied key when the handler cannot recover a committed response", async () => {
    const { send, execute } = makeWrite({})
    const response = await send({ key: "key-1" })
    expect(response.status).toBe(500)
    expect(execute).not.toHaveBeenCalled()
    expect(lastError()).toEqual(new ConfigurationError(`Idempotent write handler "${MODULE}" requires a resource identity and recoverCommittedResponse`))
    const onlyIdentity = makeWrite({ resolveResourceIdentity: () => ({ entity: "t", id: "1" }) })
    expect((await onlyIdentity.send({ key: "key-1" })).status).toBe(500)
    const onlyRecover = makeWrite({ recoverCommittedResponse: async () => null })
    expect((await onlyRecover.send({ key: "key-1" })).status).toBe(500)
  })

  it("refuses a supplied key when the adapter has no idempotency port factory", async () => {
    const { send, execute } = makeWrite(idempotentConfig(), { deps: { createIdempotencyPort: undefined } })
    expect((await send({})).status).toBe(500)
    expect(execute).not.toHaveBeenCalled()
    expect(lastError()).toEqual(new ConfigurationError(`Idempotency is not configured for "${MODULE}"`))
  })

  it("refuses a port that cannot join the business commit boundary", async () => {
    const { send, execute, port } = makeWrite(idempotentConfig(), { port: scriptedPort("plain") })
    expect((await send({})).status).toBe(500)
    expect(execute).not.toHaveBeenCalled()
    expect(port.acquire).not.toHaveBeenCalled()
    expect(lastError()).toEqual(new ConfigurationError(`Idempotency for "${MODULE}" requires a transaction- or atomic-batch-integrated idempotency port`))
  })
})

describe("existing record and input resolution", () => {
  it("passes the existing record to resolveInput only when one was found", async () => {
    const resolveExistingRecord = vi.fn(async () => ({ id: "e1" }))
    const found = makeWrite({ resolveExistingRecord })
    await found.send({ key: null })
    const foundArgs = found.resolveInput.mock.calls[0]?.[0] as Captured
    expect(foundArgs.existing).toEqual({ id: "e1" })
    expect(Object.keys(foundArgs).sort()).toEqual(["context", "existing", "request", "validated"])
    expect(resolveExistingRecord).toHaveBeenCalledWith({ request: expect.any(Request), validated: foundArgs.validated, context: foundArgs.context })

    const missing = makeWrite({ resolveExistingRecord: async () => undefined })
    await missing.send({ key: null })
    expect(Object.keys(missing.resolveInput.mock.calls[0]?.[0] as Captured).sort()).toEqual(["context", "request", "validated"])

    const none = makeWrite()
    await none.send({ key: null })
    expect(Object.keys(none.resolveInput.mock.calls[0]?.[0] as Captured).sort()).toEqual(["context", "request", "validated"])
  })

  it("validates and passes the body, query and params", async () => {
    const body = { parse: (v: unknown) => ({ parsed: v }), parseAsync: async (v: unknown) => ({ parsed: v }) }
    const { send, resolveInput } = makeWrite({ validation: { body } })
    expect((await send({ key: null, body: '{"a":1}' })).status).toBe(200)
    const args = resolveInput.mock.calls[0]?.[0] as { validated: Captured }
    expect(args.validated).toEqual({ validatedBody: { parsed: { a: 1 } }, validatedParams: undefined, validatedQuery: undefined })
  })

  it("rejects a body for an operation without a body schema", async () => {
    const { send, execute } = makeWrite()
    const response = await send({ key: null, body: '{"a":1}' })
    expect(response.status).toBe(415)
    expect(execute).not.toHaveBeenCalled()
  })

  it("applies the configured body size limit", async () => {
    const { send } = makeWrite({ validation: { body: passthroughSchema, bodyMaxBytes: 5 } })
    expect((await send({ key: null, body: '"abc"' })).status).toBe(200)
    expect((await send({ key: null, body: '"abcd"' })).status).toBe(413)
  })
})

describe("operation context", () => {
  it("builds the context from the request and handler configuration", async () => {
    const persistence = testPersistence()
    const auditSinkFactory = vi.fn((_context: unknown, _persistence?: PersistenceProvider) => ({ write: vi.fn() }))
    const outboxSinkFactory = vi.fn((_context: unknown, _persistence?: PersistenceProvider) => ({ append: vi.fn() }))
    const runtimeCapabilities = { deferredExecution: true, cache: true }
    const telemetry = { emit: vi.fn() }
    const { send } = makeWrite({ auditSinkFactory: auditSinkFactory as never, outboxSinkFactory: outboxSinkFactory as never, runtimeCapabilities }, { persistence, deps: { telemetry } })
    expect((await send({ key: null })).status).toBe(200)
    const created = spy.contexts[0] as Captured
    expect(created.persistence).toBe(persistence)
    expect(created.runtimeCapabilities).toBe(runtimeCapabilities)
    expect(created.request).toBe(spy.authorize[0]?.context)
    expect(created.signal).toBeInstanceOf(AbortSignal)
    expect(created.telemetry).toBe(telemetry)
    expect(typeof created.auditSanitizer).toBe("function")
    expect(created.auditSink).toBe(auditSinkFactory.mock.results[0]?.value)
    expect(auditSinkFactory.mock.calls[0]).toEqual([spy.authorize[0]?.context, persistence])
    expect("enforceAbac" in created).toBe(true)

    const auditFactory = created.auditSinkFactory as { create(p: PersistenceProvider): unknown }
    const other = testPersistence()
    expect(auditFactory.create(other)).toBe(auditSinkFactory.mock.results.at(-1)?.value)
    expect(auditSinkFactory.mock.calls.at(-1)).toEqual([spy.authorize[0]?.context, other])
    const outboxFactory = created.outboxSinkFactory as { create(p: PersistenceProvider): unknown }
    expect(outboxFactory.create(other)).toBe(outboxSinkFactory.mock.results.at(-1)?.value)
    expect(outboxSinkFactory.mock.calls.at(-1)).toEqual([spy.authorize[0]?.context, other])
  })

  it("omits optional pieces that are not configured", async () => {
    const { send } = makeWrite()
    await send({ key: null })
    const created = spy.contexts[0] as Captured
    for (const key of ["commitMarkers", "auditSink", "auditSinkFactory", "outboxSinkFactory", "telemetry"]) expect(key in created).toBe(false)
  })

  it("fails closed without runtime capabilities", async () => {
    const { send, execute } = makeWrite({ runtimeCapabilities: undefined })
    expect((await send({ key: null })).status).toBe(500)
    expect(execute).not.toHaveBeenCalled()
    expect(lastError()).toEqual(new ConfigurationError(`Runtime capabilities are required for "${MODULE}"`))
  })

  it("scopes persistence to the tenant for a tenant scope and leaves other scopes untouched", async () => {
    const persistence = testPersistence()
    const { canonicalRequestNormalization, trustedSession } = await import("./canonicalRequest")
    const tenant = makeWrite({ scope: { scope: "tenant" } }, { persistence, normalization: canonicalRequestNormalization(trustedSession({ kind: "tenant", tenantId: "t-1" }), MODULE) })
    await tenant.send({ key: null })
    const tenantPersistence = (spy.contexts.at(-1) as Captured).persistence as { tenantId?: string }
    expect(tenantPersistence).not.toBe(persistence)
    expect(tenantPersistence.tenantId).toBe("t-1")

    const platform = makeWrite({}, { persistence })
    await platform.send({ key: null })
    expect((spy.contexts.at(-1) as Captured).persistence).toBe(persistence)
  })

  it("passes the field-level write enforcer only for a bundle, delegating to the authorizer", async () => {
    const { send } = makeWrite({}, { execute: async () => ({ id: "created" }) })
    await send({ key: null })
    const enforcer = (spy.contexts[0] as { enforceAbac?: { enforce(a: string, r: Record<string, unknown>, c?: string[]): void } }).enforceAbac
    expect(() => enforcer?.enforce("create", { id: "1" }, ["id"])).not.toThrow()
    expect(() => enforcer?.enforce("create", { id: "1" })).not.toThrow()
    expect(() => enforcer?.enforce("approve", { id: "1" })).toThrow()
  })
})

describe("committed business result", () => {
  const committed = (extra: Record<string, unknown> = { committed: true }) => Object.assign(new Error("late failure"), extra)

  it("returns the business response when the commit happened but a later phase failed", async () => {
    spy.runOverride = async (args) => {
      await (args.onBusinessResult as (r: unknown) => Promise<void>)({ id: "done" })
      throw committed()
    }
    const { send } = makeWrite()
    const response = await send({ key: null })
    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toEqual({ id: "done" })
    expect(spy.errors).toHaveLength(0)
  })

  it("uses the configured response builder for that response", async () => {
    spy.runOverride = async (args) => {
      await (args.onBusinessResult as (r: unknown) => Promise<void>)({ id: "done" })
      throw committed()
    }
    const { send } = makeWrite({ toResponse: (result: unknown) => Response.json({ wrapped: result }, { status: 201 }) })
    const response = await send({ key: null })
    expect(response.status).toBe(201)
    expect(await bodyOf(response)).toEqual({ wrapped: { id: "done" } })
  })

  it.each([
    ["committed is false", { committed: false }],
    ["committed is truthy but not true", { committed: "yes" }],
    ["committed is absent", {}],
  ])("answers an error when %s", async (_label, extra) => {
    spy.runOverride = async (args) => {
      await (args.onBusinessResult as (r: unknown) => Promise<void>)({ id: "done" })
      throw committed(extra)
    }
    const { send } = makeWrite()
    expect((await send({ key: null })).status).toBe(500)
    expect(spy.errors).toHaveLength(1)
  })

  it("answers an error when the failure came before any business result", async () => {
    spy.runOverride = async () => { throw committed() }
    const { send } = makeWrite()
    expect((await send({ key: null })).status).toBe(500)
  })

  it("never returns a business response for a handler that holds an idempotency reservation", async () => {
    spy.runOverride = async (args) => {
      await (args.onBusinessResult as (r: unknown) => Promise<void>)({ id: "done" })
      throw committed()
    }
    const { send, port } = makeWrite(idempotentConfig())
    expect((await send({})).status).toBe(500)
    expect(port.abandon).toHaveBeenCalledOnce()
  })

  it.each([["a string", "boom"], ["null", null], ["a number", 7], ["undefined", undefined]])("rethrows %s thrown by the operation unchanged", async (_label, thrown) => {
    spy.runOverride = async () => { throw thrown }
    const { send } = makeWrite()
    expect((await send({ key: null })).status).toBe(500)
    expect(lastError()).toBe(thrown)
  })

  it("rethrows an error whose committed marker is not on an object", async () => {
    const error = Object.assign(new Error("x"), { committed: true })
    spy.runOverride = async () => { throw error }
    const { send } = makeWrite()
    expect((await send({ key: null })).status).toBe(500)
    expect(lastError()).toBe(error)
  })
})
