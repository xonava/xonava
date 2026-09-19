import { describe, expect, it, vi } from "vitest"
import { createFrameworkWriteHandler } from "../createFrameworkWriteHandler"
import type { FrameworkAdapterDeps } from "../../server"
import { allowAllAbacBundle, canonicalRequestNormalization } from "./canonicalRequest"
import type { PersistenceProvider } from "core/persistence"

const rateLimit = { config: { max: 1, timeWindow: "1 minute" }, consistency: "best-effort" as const }

function createRequest(): Request {
  return new Request("https://example.test/api/write", { method: "POST" })
}

function createPersistence(): PersistenceProvider {
  return {
    dialect: "memory",
    capabilities: {
       interactiveTransactions: true,
      atomicBatch: false,
      returningInsert: false,
      readSessions: false,
      jsonQueries: false,
      exactDecimal: false,
      persistentConnection: false,
      maxPageSize: 100,
      maxBindParams: 100,
      maxStatementBytes: 100_000,
    },
     repository: () => { throw new Error("not used") },
     runInTransaction: async (work: (scoped: PersistenceProvider) => Promise<unknown>) => work(createPersistence()),
  } as unknown as PersistenceProvider
}

describe("HTTP write handler rate-limit configuration", () => {
  it("reports post-commit effect failures through adapter dependencies", async () => {
    const emit = vi.fn()
    const handler = createFrameworkWriteHandler({
      adapterDeps: {
        telemetry: { emit },
        assertValidCsrf: vi.fn(),
         resolveAbacBundle: vi.fn(async ({ moduleKey }) => allowAllAbacBundle(moduleKey)),
      } satisfies FrameworkAdapterDeps,
      requestNormalization: canonicalRequestNormalization(undefined, "test.module"),
      scope: { scope: "platform" },
      moduleKey: "test.module",
      action: "create",
    skipCapabilityCheck: true,
    runtimeCapabilities: { deferredExecution: true, cache: true },
      auditSinkFactory: () => ({ write: vi.fn(async () => { throw new Error("secret-value") }) }),
      createPersistence: vi.fn(() => createPersistence()),
      definition: {
        key: "test.module.create",
        kind: "mutation",
        atomicity: { kind: "standard", mode: "required" },
        authorization: { authorize: async () => ({ allowed: true }) },
        audit: {
          action: "test.created",
          resourceType: "test",
          resolveResourceId: () => "record-1",
        },
        execute: async () => ({}),
      },
      resolveInput: vi.fn(async () => ({})),
    })

    const response = await handler(createRequest())

    expect(response.status).toBe(200)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ name: "operation.effect.failure", attributes: expect.objectContaining({ phase: "bestEffort", effectName: "audit-write" }) }))
  })

  it("fails closed when the framework cache adapter is absent", async () => {
    const execute = vi.fn()
    const handler = createFrameworkWriteHandler({
      adapterDeps: {
        assertValidCsrf: vi.fn(),
         resolveAbacBundle: vi.fn(async ({ moduleKey }) => allowAllAbacBundle(moduleKey)),
      } satisfies FrameworkAdapterDeps,
      requestNormalization: canonicalRequestNormalization(undefined, "test.module"),
      scope: { scope: "platform" },
      moduleKey: "test.module",
      action: "create",
      rateLimit,
      skipCapabilityCheck: true,
      createPersistence: vi.fn(() => createPersistence()),
      definition: { key: "test.module.create", kind: "mutation", atomicity: { kind: "standard", mode: "required" }, authorization: { authorize: async () => ({ allowed: true }) }, execute } as never,
      resolveInput: vi.fn(async () => ({})),
    })

    const response = await handler(createRequest())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: "Internal Server Error", code: "INTERNAL_SERVER_ERROR" })
    expect(execute).not.toHaveBeenCalled()
  })

})
