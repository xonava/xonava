import { vi } from "vitest"
import type {
  AtomicBatchIdempotencyPort,
  IdempotencyAcquireResult,
  IdempotencyCommitItem,
  IdempotencyPort,
  TransactionalIdempotencyPort,
} from "@xonava/core/events"
import type { AtomicBatchItem, PersistenceProvider } from "@xonava/core/persistence"
import type { RequestContext } from "@xonava/core/domain"
import { createFrameworkWriteHandler } from "../createFrameworkWriteHandler"
import type { SerializedResponse } from "../idempotency"
import type { FrameworkAdapterDeps, FrameworkRequestNormalization } from "../../server"
import { allowAllAbacBundle, allowAllModuleFacts, canonicalRequestNormalization, trustedSession } from "./canonicalRequest"

export const MODULE = "test.module"

export type WriteHandlerArgs = Parameters<typeof createFrameworkWriteHandler<unknown, unknown>>[0]

export function testPersistence(capabilities: Record<string, unknown> = {}): PersistenceProvider {
  const provider: PersistenceProvider = {
    dialect: "test",
    capabilities: {
      interactiveTransactions: true,
      atomicBatch: false,
      returningInsert: false,
      readSessions: false,
      jsonQueries: false,
      exactDecimal: false,
      persistentConnection: false,
      maxPageSize: 100,
      ...capabilities,
    },
    repository: vi.fn(),
    runInTransaction: async (work: (scoped: PersistenceProvider) => Promise<unknown>) => work(provider),
  } as never
  return provider
}

export type AcquireScript = (call: number) => IdempotencyAcquireResult<SerializedResponse>

export type PortFlavour = "transactional" | "atomic-batch" | "plain"

export function scriptedPort(flavour: PortFlavour = "transactional", script: AcquireScript = () => ({ outcome: "acquired", token: "token-1" })) {
  let calls = 0
  /** The request as it was when each acquire call happened: the handler mutates its request object afterwards. */
  const snapshots: Array<{ scope: string; key: string; fingerprint: string; leaseDurationMs: number }> = []
  const acquire = vi.fn(async (request: { scope: string; key: string; fingerprint: string; leaseDurationMs: number }) => {
    snapshots.push({ ...request })
    return script(calls++)
  })
  const renew = vi.fn(async () => undefined)
  const complete = vi.fn(async () => undefined)
  const abandon = vi.fn(async () => undefined)
  const markCommittedInTransaction = vi.fn(async (_item: IdempotencyCommitItem, _persistence: PersistenceProvider) => undefined)
  const batchItem: AtomicBatchItem<unknown> = { kind: "cache-generation", tag: "from-port" } as never
  const createCommitBatchItem = vi.fn((_item: IdempotencyCommitItem) => batchItem)
  const base = { acquire, renew, complete, abandon }
  const transactional: TransactionalIdempotencyPort<SerializedResponse> = { ...base, markCommittedInTransaction }
  const atomicBatch: AtomicBatchIdempotencyPort<SerializedResponse> = { ...base, createCommitBatchItem }
  const port: IdempotencyPort<SerializedResponse> = flavour === "transactional" ? transactional : flavour === "atomic-batch" ? atomicBatch : base
  return { port, acquire, snapshots, renew, complete, abandon, markCommittedInTransaction, createCommitBatchItem, batchItem }
}

export type Harness = ReturnType<typeof makeWrite>

export function makeWrite(
  over: Record<string, unknown> = {},
  options: {
    deps?: Record<string, unknown>
    port?: ReturnType<typeof scriptedPort>
    persistence?: PersistenceProvider
    normalization?: FrameworkRequestNormalization
    execute?: (args: never) => Promise<unknown>
    definition?: Record<string, unknown>
  } = {},
) {
  const port = options.port ?? scriptedPort()
  const persistence = options.persistence ?? testPersistence()
  const execute = vi.fn(options.execute ?? (async () => ({ id: "created" })))
  const resolveInput = vi.fn(async (_args: unknown) => ({}))
  const deps: FrameworkAdapterDeps = {
    assertValidCsrf: vi.fn(),
    resolveAbacBundle: vi.fn(async ({ moduleKey }) => allowAllAbacBundle(moduleKey)),
    resolveModuleAuthorizationFacts: allowAllModuleFacts,
    createIdempotencyPort: <TResult>() => port.port as unknown as IdempotencyPort<TResult>,
    ...options.deps,
  } as FrameworkAdapterDeps
  const createPersistence = vi.fn((_context: RequestContext) => persistence)
  const args: WriteHandlerArgs = {
    adapterDeps: deps,
    requestNormalization: options.normalization ?? canonicalRequestNormalization(trustedSession(), MODULE),
    scope: { scope: "platform" },
    moduleKey: MODULE,
    action: "create",
    skipCapabilityCheck: true,
    runtimeCapabilities: { deferredExecution: true, cache: true },
    createPersistence,
    definition: {
      key: `${MODULE}.create`,
      kind: "mutation",
      atomicity: { kind: "standard", mode: "required" },
      authorization: { authorize: async () => ({ allowed: true }) },
      execute,
      ...options.definition,
    } as never,
    resolveInput: resolveInput as never,
    ...over,
  } as never
  const handler = createFrameworkWriteHandler(args)
  const send = (init: { key?: string | null; body?: string; headers?: Record<string, string>; url?: string; params?: Record<string, unknown> } = {}) => {
    const headers: Record<string, string> = { ...init.headers }
    if (init.key !== null) headers["Idempotency-Key"] = init.key ?? "key-1"
    if (init.body !== undefined) headers["content-type"] = "application/json"
    return handler(
      new Request(init.url ?? "https://example.test/things", {
        method: "POST",
        headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
      }),
      init.params ? { params: Promise.resolve(init.params) } : undefined,
    )
  }
  return { handler, send, args, deps, port, persistence, execute, resolveInput, createPersistence }
}

/** An idempotent handler config: required idempotency needs a resource identity and a recovery function. */
export const idempotentConfig = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  scope: { scope: "platform", idempotency: { required: true } },
  resolveResourceIdentity: () => ({ entity: "thing", id: "thing-1" }),
  recoverCommittedResponse: async () => ({ id: "recovered" }),
  ...extra,
})

export const passthroughSchema = { parse: (value: unknown) => value, parseAsync: async (value: unknown) => value }

export async function bodyOf(response: Response): Promise<unknown> {
  return response.clone().json() as Promise<unknown>
}

/** A shared, linearizable tag-generation cache adapter that records every invalidation. */
export function recordingCache(overrides: Record<string, unknown> = {}) {
  const advanced: string[] = []
  const adapter = {
    capabilities: { tagGenerationConsistency: "linearizable", coherenceScope: "shared" },
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => true),
    has: vi.fn(async () => false),
    clear: vi.fn(async () => undefined),
    addToTag: vi.fn(async () => undefined),
    getTagKeys: vi.fn(async () => []),
    deleteTag: vi.fn(async () => undefined),
    getTagGeneration: vi.fn(async () => "0"),
    advanceTagGeneration: vi.fn(async (tag: string) => { advanced.push(tag); return String(advanced.length) }),
    ...overrides,
  }
  return { adapter: adapter as never, advanced, raw: adapter }
}
