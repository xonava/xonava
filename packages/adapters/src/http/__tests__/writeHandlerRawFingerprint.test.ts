// @ts-nocheck
import { describe, expect, it, vi } from "vitest"
import type { IdempotencyPort, TransactionalIdempotencyPort } from "@xonava/core/events"
import type { PersistenceProvider } from "@xonava/core/persistence"
import type { ValidationSchema } from "@xonava/core/kernel"
import { createFrameworkWriteHandler } from "../createFrameworkWriteHandler"
import type { SerializedResponse, SerializedResponseIdempotencyPort } from "../idempotency"
import type { FrameworkAdapterDeps } from "../../server"
import { allowAllAbacBundle, allowAllModuleFacts, canonicalRequestNormalization, trustedSession } from "./canonicalRequest"

const persistence = {
  dialect: "test",
  capabilities: { interactiveTransactions: true, atomicBatch: false, returningInsert: false, readSessions: false, jsonQueries: false, exactDecimal: false, persistentConnection: false, maxPageSize: 100 },
  repository: vi.fn(),
  runInTransaction: async (work: (scoped: PersistenceProvider) => Promise<unknown>) => work(persistence),
} as unknown as PersistenceProvider

// Mirrors common schema behaviour: coercion to Date, optional keys present as
// undefined, and an ordinary "constructor" data key.
const coercingSchema: ValidationSchema = {
  parse: (value: unknown) => coerce(value),
  parseAsync: async (value: unknown) => coerce(value),
}
function coerce(value: unknown) {
  const body = value as { when?: string; constructor?: unknown; note?: string }
  return { when: new Date(body.when ?? "2026-01-01T00:00:00.000Z"), note: body.note, constructor: body.constructor }
}

function setup() {
  const acquire = vi.fn<SerializedResponseIdempotencyPort["acquire"]>(async () => ({ outcome: "acquired", token: "token" }))
  const port: TransactionalIdempotencyPort<SerializedResponse> = { acquire, renew: vi.fn(async () => undefined), markCommittedInTransaction: vi.fn(async () => undefined), complete: vi.fn(async () => undefined) }
  const deps: FrameworkAdapterDeps = {
    assertValidCsrf: vi.fn(),
    resolveAbacBundle: vi.fn(async ({ moduleKey }) => allowAllAbacBundle(moduleKey)),
    resolveModuleAuthorizationFacts: allowAllModuleFacts,
    createIdempotencyPort: <TResult>() => port as unknown as IdempotencyPort<TResult>,
  }
  const execute = vi.fn(async () => ({ id: "created" }))
  const handler = createFrameworkWriteHandler({
    adapterDeps: deps,
    requestNormalization: canonicalRequestNormalization(trustedSession(), "test.module"),
    scope: { scope: "platform", idempotency: { required: true } },
    moduleKey: "test.module",
    action: "create",
    skipCapabilityCheck: true,
    runtimeCapabilities: { deferredExecution: true, cache: true },
    createPersistence: () => persistence,
    resolveResourceIdentity: () => ({ entity: "test.module", id: "resource-1" }),
    definition: { key: "test.module.create", kind: "mutation", atomicity: { kind: "standard", mode: "required" }, authorization: { authorize: async () => ({ allowed: true }) }, execute } as never,
    resolveInput: vi.fn(async () => ({})),
    recoverCommittedResponse: vi.fn(async () => ({ id: "recovered" })),
    validation: { body: coercingSchema },
  })
  const send = (body: string, key = "key-1") => handler(new Request("https://example.test", {
    method: "POST", body, headers: { "content-type": "application/json", "Idempotency-Key": key },
  }))
  return { send, acquire, execute }
}

describe("idempotent write fingerprint", () => {
  it("fingerprints the client's JSON, so Date/undefined/constructor in the validated body do not fail the write", async () => {
    const { send, acquire, execute } = setup()
    const response = await send('{"when":"2026-01-01T00:00:00.000Z","constructor":"x"}')
    expect(response.status, await response.clone().text()).toBe(200)
    expect(execute).toHaveBeenCalledOnce()
    expect(acquire.mock.calls[0]?.[0].fingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it("is stable across key order and whitespace and distinguishes different payloads", async () => {
    const { send, acquire } = setup()
    await send('{"when":"2026-01-01T00:00:00.000Z","note":"a"}')
    await send('{ "note": "a", "when": "2026-01-01T00:00:00.000Z" }')
    await send('{"when":"2026-01-01T00:00:00.000Z","note":"b"}')
    const [first, second, third] = acquire.mock.calls.map(call => call[0].fingerprint)
    expect(first).toBe(second)
    expect(first).not.toBe(third)
  })

  it("rejects client JSON that cannot be fingerprinted as a 400, not a 500", async () => {
    const { send, execute } = setup()
    const response = await send('{"__proto__":{"polluted":true}}')
    expect(response.status).toBe(400)
    expect(execute).not.toHaveBeenCalled()
  })
})
