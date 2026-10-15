/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unnecessary-type-assertion */
import { describe, expect, it, vi, type Mock } from "vitest"
import { createFrameworkWriteHandler } from "../createFrameworkWriteHandler"
import { deserializeResponse, type SerializedResponse, type SerializedResponseIdempotencyPort } from "../idempotency"
import type { FrameworkAdapterDeps } from "../../server"
import type { IdempotencyPort, TransactionalIdempotencyPort } from "@xonava/core/events"
import type { PersistenceProvider } from "@xonava/core/persistence"
import { allowAllAbacBundle, allowAllModuleFacts, canonicalRequestNormalization } from "./canonicalRequest"

const persistence = {
  dialect: "test",
  capabilities: { interactiveTransactions: true, atomicBatch: false, returningInsert: false, readSessions: false, jsonQueries: false, exactDecimal: false, persistentConnection: false, maxPageSize: 100 },
  repository: vi.fn(),
  runInTransaction: async (work: (scoped: PersistenceProvider) => Promise<unknown>) => work(persistence),
} as unknown as PersistenceProvider

function createDeps(port: SerializedResponseIdempotencyPort): FrameworkAdapterDeps {
  return {
    assertValidCsrf: vi.fn(),
    resolveAbacBundle: vi.fn(async ({ moduleKey }) => allowAllAbacBundle(moduleKey)),
    resolveModuleAuthorizationFacts: allowAllModuleFacts,
    createIdempotencyPort: <TResult>() => port as unknown as IdempotencyPort<TResult>,
  }
}

function createPort(acquireFn: SerializedResponseIdempotencyPort["acquire"]): TransactionalIdempotencyPort<SerializedResponse> {
  return {
    acquire: acquireFn,
    renew: vi.fn(async () => undefined),
    markCommittedInTransaction: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
  }
}

function createHandler(deps: FrameworkAdapterDeps, execute: ReturnType<typeof vi.fn>, recoverCommittedResponse?: (args: { resource: { entity: string; id: string; version?: number }; context: import("@xonava/core/domain").RequestContext }) => Promise<unknown>, invalidations?: string[], resourceVersion?: number) {
  return createFrameworkWriteHandler({
    adapterDeps: deps,
    requestNormalization: canonicalRequestNormalization(undefined, "test.module"),
    scope: { scope: "platform", idempotency: { required: true } },
    moduleKey: "test.module",
    action: "create",
    skipCapabilityCheck: true,
    runtimeCapabilities: { deferredExecution: true, cache: true },
    createPersistence: () => persistence,
    definition: { key: "test.module.create", kind: "mutation", atomicity: { kind: "standard", mode: "required" }, authorization: { authorize: async () => ({ allowed: true }) }, execute } as never,
    resolveResourceIdentity: () => ({ entity: "test.module", id: "resource-1", ...(resourceVersion !== undefined ? { version: resourceVersion } : {}) }),
    ...(invalidations ? {
      invalidateTags: async () => invalidations,
      getCacheAdapter: async () => ({
        capabilities: { tagGenerationConsistency: "linearizable" as const, coherenceScope: "shared" as const },
        get: vi.fn(), set: vi.fn(), delete: vi.fn(), has: vi.fn(), clear: vi.fn(),
        addToTag: vi.fn(), getTagKeys: vi.fn(async () => []), deleteTag: vi.fn(),
        getTagGeneration: vi.fn(async () => "0"), advanceTagGeneration: vi.fn(async () => "1"),
      }),
    } : {}),
    ...(recoverCommittedResponse ? { recoverCommittedResponse } : {}),
    resolveInput: vi.fn(async () => ({})),
    validation: { body: { parse: (value: unknown) => value, parseAsync: async (value: unknown) => value } },
  })
}

function createRequest(key: string) {
  return new Request("https://example.test", {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json", "Idempotency-Key": key },
  })
}

describe("idempotency crash recovery", () => {
  it("rejects a required-idempotency handler without committed-response recovery", () => {
    const port = createPort(async () => ({ outcome: "acquired", token: "token-1" }))
    expect(() => createHandler(createDeps(port), vi.fn(async () => ({ id: "created" })))).toThrow(
      "requires a resource identity and recoverCommittedResponse",
    )
  })

  it("recovers after a crash between commit and complete without re-executing", async () => {
    // Simulates: Request 1 acquires, executes, commits in the transaction, but
    // complete() fails after the transaction marks the row business-committed.
    let committed = false
    let failComplete = true
    const port = createPort(async () =>
      committed
        ? { outcome: "business-committed", token: "token-2", resource: { entity: "test.module", id: "resource-1" } }
        : { outcome: "acquired", token: "token-1" },
    )
    ;(port.complete as Mock).mockImplementation(async () => {
      if (failComplete) {
        failComplete = false
        committed = true
        throw new Error("finalize unavailable — process crashed")
      }
    })

    const execute = vi.fn(async () => ({ id: "created" }))
    const recoverCommittedResponse = vi.fn(async () => ({ id: "recovered" }))

    // First request: acquire → execute → commit → complete() fails → 500
    const first = await createHandler(createDeps(port), execute, recoverCommittedResponse)(createRequest("crash-key"))
    expect(first.status).toBe(500)
    expect(execute).toHaveBeenCalledTimes(1)
    expect((port.markCommittedInTransaction as Mock)).toHaveBeenCalledTimes(1)

    // Second request: business-committed → recover → complete → replay
    const second = await createHandler(createDeps(port), execute, recoverCommittedResponse)(createRequest("crash-key"))
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ id: "recovered" })
    expect(execute).toHaveBeenCalledTimes(1) // Execute must NOT re-run
    expect(recoverCommittedResponse).toHaveBeenCalledTimes(1)
  })

  it("rejects a required-idempotency handler without a resolver even when a resource identity exists", () => {
    const committed = false
    const port = createPort(async () =>
      committed
        ? { outcome: "business-committed", token: "token-2", resource: { entity: "test.module", id: "resource-1" } }
        : { outcome: "acquired", token: "token-1" },
    )
    expect(() => createHandler(createDeps(port), vi.fn(async () => ({ id: "created" })))).toThrow(
      "requires a resource identity and recoverCommittedResponse",
    )
  })

  it("returns 409 when recoverCommittedResponse returns null (resource deleted after commit)", async () => {
    let committed = false
    let finalized = false
    let failComplete = true
    const port = createPort(async () =>
      finalized
        ? { outcome: "replay", result: { version: "v1", body: JSON.stringify({ error: "Conflict" }), status: 409, headers: [["content-type", "application/json"]] } }
        : committed
        ? { outcome: "business-committed", token: "token-2", resource: { entity: "test.module", id: "resource-1" } }
        : { outcome: "acquired", token: "token-1" },
    )
    ;(port.complete as Mock).mockImplementation(async () => {
      if (failComplete) { failComplete = false; committed = true; throw new Error("crash") }
      committed = true
      finalized = true
    })

    const execute = vi.fn(async () => ({ id: "created" }))
    const recoverCommittedResponse = vi.fn(async () => null) // Resource deleted

    // First request: crash
    await createHandler(createDeps(port), execute, recoverCommittedResponse)(createRequest("gone-key"))

    // Second request: business-committed, resource gone → 409
    const second = await createHandler(createDeps(port), execute, recoverCommittedResponse)(createRequest("gone-key"))
    expect(second.status).toBe(409)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(recoverCommittedResponse).toHaveBeenCalledTimes(1)
    expect((port.complete as Mock)).toHaveBeenCalledTimes(2)
    const third = await createHandler(createDeps(port), execute, recoverCommittedResponse)(createRequest("gone-key"))
    expect(third.status).toBe(409)
    expect(recoverCommittedResponse).toHaveBeenCalledTimes(1)
    expect((port.complete as Mock)).toHaveBeenCalledTimes(2)
  })

  it("replays committed receipt invalidations when the current state changed", async () => {
    let committed = false
    const invalidateTag = vi.fn()
    const port = createPort(async () => committed
      ? { outcome: "business-committed", token: "token-1", resource: { entity: "test.module", id: "resource-1" }, invalidations: ["receipt-tag"] }
      : { outcome: "acquired", token: "token-1" })
    ;(port.complete as Mock).mockImplementation(async () => { committed = true })

    const execute = vi.fn(async () => ({ id: "created" }))
    const recover = vi.fn(async () => ({ id: "newer-current-state" }))
    const handler = createHandler(createDeps(port), execute, recover, ["freshly-recomputed-tag"])
    const first = await handler(createRequest("changed-state-key"))
    expect(first.status).toBe(200)
    const second = await handler(createRequest("changed-state-key"))
    expect(second.status).toBe(200)
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({ resource: expect.objectContaining({ id: "resource-1" }) }))
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("does not recover a create receipt against a modified replacement row", async () => {
    let committed = false
    const port = createPort(async () => committed
      ? { outcome: "business-committed", token: "token-1", resource: { entity: "test.module", id: "resource-1", version: 1 } }
      : { outcome: "acquired", token: "token-1" })
    let failComplete = true
    ;(port.complete as Mock).mockImplementation(async () => {
      committed = true
      if (failComplete) { failComplete = false; throw new Error("crash after commit") }
    })

    const execute = vi.fn(async () => ({ id: "created" }))
    const currentRowVersion = 2
    const recover = vi.fn(async ({ resource }: { resource: { version?: number } }) =>
      resource.version === currentRowVersion ? { id: "replacement" } : null)
    const handler = createHandler(createDeps(port), execute, recover, undefined, 1)

    expect((await handler(createRequest("replacement-key"))).status).toBe(500)
    const retry = await handler(createRequest("replacement-key"))

    expect(retry.status).toBe(409)
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({ resource: { entity: "test.module", id: "resource-1", version: 1 } }))
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("replays a previously completed response on third retry (stable replay)", async () => {
    // Verifies the stable replay path: once a row is completed, subsequent
    // retries replay the serialized response without re-executing business logic.
    const port = createPort(async () => ({
      outcome: "replay",
      result: { version: "v1", body: JSON.stringify({ id: "replayed" }), status: 200, headers: [["content-type", "application/json"]] } as SerializedResponse,
    }))
    const execute = vi.fn(async () => ({ id: "created" }))

    const recoverCommittedResponse = vi.fn(async () => ({ id: "recovered" }))
    const response = await createHandler(createDeps(port), execute, recoverCommittedResponse)(createRequest("replay-key"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: "replayed" })
    expect(execute).not.toHaveBeenCalled() // Business logic must NOT run on replay
  })
})
