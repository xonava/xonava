// @ts-nocheck
import { z } from "zod"
import type { IdempotencyPort } from "@xonava/core/events"
import type { PersistenceProvider } from "@xonava/core/persistence"
import { createFrameworkWriteHandler } from "../../createFrameworkWriteHandler"
import { allowAllAbacBundle, allowAllModuleFacts, canonicalRequestNormalization } from "../canonicalRequest"
import { memoryIdempotencyPort } from "./fuzzFixture"

const MODULE = "http.custom"
/** Names the custom write handler executed (rolled back when the transaction fails). */
export const executed: string[] = []
export const customIdempotency = memoryIdempotencyPort()
const persistence = {
  dialect: "test",
  capabilities: { interactiveTransactions: true, atomicBatch: false, returningInsert: true, readSessions: false, jsonQueries: false, exactDecimal: false, persistentConnection: false, maxPageSize: 100 },
  repository: () => { throw new Error("unused") },
  runInTransaction: async (work: (provider: PersistenceProvider) => Promise<unknown>) => {
    const before = executed.length
    try { return await work(persistence) } catch (error) { executed.length = before; throw error }
  },
} as unknown as PersistenceProvider

/** A platform-scoped create handler with params, query and body contracts and optional idempotency. */
export function createCustomWriteHandler() {
  return createFrameworkWriteHandler({
    adapterDeps: {
      assertValidCsrf: () => undefined,
      resolveModuleAuthorizationFacts: allowAllModuleFacts,
      resolveAbacBundle: async ({ moduleKey }) => allowAllAbacBundle(moduleKey),
      createIdempotencyPort: <T>() => customIdempotency as unknown as IdempotencyPort<T>,
    },
    requestNormalization: canonicalRequestNormalization(undefined, MODULE),
    moduleKey: MODULE, action: "create", skipCapabilityCheck: true,
    scope: { scope: "platform", idempotency: { required: false } },
    createPersistence: () => persistence,
    runtimeCapabilities: { deferredExecution: false, cache: false },
    definition: {
      key: `${MODULE}.create`, kind: "mutation", atomicity: { kind: "standard", mode: "required" },
      authorization: { authorize: async () => ({ allowed: true }) },
      execute: async ({ input }: { input: { name: string; id: string } }) => { executed.push(input.name); return { id: input.id } },
    } as never,
    resolveInput: async ({ validated }) => ({ name: (validated.validatedBody as { name: string }).name, id: (validated.validatedParams as { id: string }).id }),
    resolveResourceIdentity: ({ input }) => ({ entity: MODULE, id: (input as { id: string }).id }),
    recoverCommittedResponse: async ({ resource }) => ({ id: resource.id }),
    validation: {
      params: z.object({ id: z.string().min(1).max(100) }),
      query: z.object({ note: z.string().max(100).optional() }),
      body: z.object({ name: z.string().min(1).max(500) }),
    },
  })
}
