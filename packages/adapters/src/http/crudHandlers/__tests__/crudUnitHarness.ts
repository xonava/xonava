import { vi } from "vitest"
import { z } from "zod"
import type { RequestContext } from "@xonava/core/domain"
import type { EntityDescriptor, PersistenceProvider } from "@xonava/core/persistence"
import type { CrudOptions, CrudShared } from "../types"
import { normalizeCrudRequest } from "../shared"
import { allowAllAbacBundle, allowAllModuleFacts, canonicalRequestNormalization, trustedSession } from "../../__tests__/canonicalRequest"

export type Row = {
  id: string
  tenantId: string
  version: number
  name: string
  deletedAt?: string | null
}

export const MODULE_KEY = "test.widgets"

export function widgetEntity(over: Partial<EntityDescriptor<Row>> = {}): EntityDescriptor<Row> {
  return {
    name: "widget",
    primaryKey: "id",
    tenantField: "tenantId",
    versionField: "version",
    fields: {
      id: { type: "string" },
      tenantId: { type: "string" },
      version: { type: "number" },
      name: { type: "string" },
      deletedAt: { type: "string" },
    },
    ...over,
  }
}

export function plainEntity(over: Partial<EntityDescriptor<Row>> = {}): EntityDescriptor<Row> {
  const { versionField: _versionField, ...rest } = widgetEntity()
  return { ...rest, ...over }
}

/** No tenant column and no version column: a platform-scoped, unversioned entity. */
export function unscopedEntity(over: Partial<EntityDescriptor<Row>> = {}): EntityDescriptor<Row> {
  const { versionField: _versionField, tenantField: _tenantField, ...rest } = widgetEntity()
  return { ...rest, ...over }
}

export type RepoMock = ReturnType<typeof fakeRepo>

/** A repository whose methods are all spies; pass `undefined` to remove an optional method. */
export function fakeRepo(over: Record<string, unknown> = {}) {
  const repo: Record<string, unknown> = {
    findById: vi.fn(async () => null),
    findOneWhere: vi.fn(async () => null),
    findMany: vi.fn(async () => ({ rows: [], rowCount: 0, page: 1, pageSize: 1 })),
    insert: vi.fn(async (data: Record<string, unknown>) => ({ ...data })),
    update: vi.fn(async () => ({})),
    updateOneWhereReturning: vi.fn(async () => null),
    deleteWhere: vi.fn(async () => ({ deletedCount: 0 })),
    ...over,
  }
  for (const key of Object.keys(repo)) if (repo[key] === undefined) delete repo[key]
  return repo as {
    findById?: ReturnType<typeof vi.fn>
    findOneWhere?: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    insert: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    updateOneWhereReturning?: ReturnType<typeof vi.fn>
    deleteWhere?: ReturnType<typeof vi.fn>
  }
}

export function persistenceOf(repo: object, capabilities: Record<string, unknown> = {}): PersistenceProvider {
  const provider: PersistenceProvider = {
    dialect: "test",
    capabilities: {
      interactiveTransactions: true,
      atomicBatch: false,
      returningInsert: true,
      readSessions: false,
      jsonQueries: false,
      exactDecimal: false,
      persistentConnection: false,
      maxPageSize: 100,
      ...capabilities,
    },
    repository: () => repo,
    runInTransaction: async (work: (scoped: PersistenceProvider) => Promise<unknown>) => work(provider),
  } as never
  return provider
}

export type ScopeKind = "tenant" | "platform"

export async function contextFor(kind: ScopeKind = "tenant", routeKey = "create", actorId = "actor-1"): Promise<RequestContext> {
  const session = trustedSession(kind === "tenant" ? { kind: "tenant", tenantId: "tenant-1" } : { kind: "platform", platformKey: "test" }, actorId)
  return normalizeCrudRequest({
    request: new Request("https://example.test/widgets/w1"),
    routeKey,
    normalization: canonicalRequestNormalization(session, MODULE_KEY),
    requestId: "req-1",
    correlationId: "corr-1",
  })
}

export function baseOptions(over: Record<string, unknown> = {}): CrudOptions<Row> {
  const persistence = persistenceOf(fakeRepo())
  return {
    adapterDeps: {
      assertValidCsrf: () => undefined,
      resolveAbacBundle: async ({ moduleKey }: { moduleKey: string }) => allowAllAbacBundle(moduleKey),
      resolveModuleAuthorizationFacts: allowAllModuleFacts,
    },
    requestNormalization: canonicalRequestNormalization(trustedSession({ kind: "tenant", tenantId: "tenant-1" }), MODULE_KEY),
    scope: { scope: "tenant" },
    moduleKey: MODULE_KEY,
    entity: widgetEntity(),
    entityScope: { kind: "tenant" },
    policy: { skipCapabilityCheck: true },
    cache: { enabled: false, tag: "widgets", keyPrefix: "widgets" },
    getCacheAdapter: async () => ({}) as never,
    createPersistence: () => persistence,
    runtimeCapabilities: { deferredExecution: true, cache: true },
    validation: { idParams: z.object({ id: z.string() }), createBody: z.object({ name: z.string() }), updateBody: z.object({ name: z.string() }) },
    audit: { enabled: false, resource: "widget" },
    crud: {},
    ...over,
  } as never
}

export function sharedOf(options: CrudOptions<Row>, over: Record<string, unknown> = {}): CrudShared<Row, Row, Partial<Row>, Row, Row> {
  return {
    options,
    entity: options.entity,
    deps: options.adapterDeps,
    idParamsSchema: options.validation?.idParams ?? z.object({ id: z.string() }),
    capabilityMode: { enabled: false, key: undefined },
    writeCapabilityConfig: { skipCapabilityCheck: true },
    routes: { list: false, detail: false, create: true, update: true, delete: true },
    writeRuntimeCapabilities: { deferredExecution: true, cache: true },
    ...over,
  } as never
}

type Callback<R = unknown> = (arg: never) => Promise<R>

/** What a CRUD handler factory passed to createFrameworkWriteHandler. */
export interface WriteCapture {
  adapterDeps: unknown
  requestNormalization: unknown
  scope: unknown
  moduleKey: string
  action: string
  skipCapabilityCheck?: boolean
  customCapabilityKey?: string
  validation?: { params?: unknown; body?: unknown }
  rateLimit?: Record<string, unknown>
  getCacheAdapter: unknown
  getRateLimitStore?: unknown
  runtimeCapabilities: unknown
  auditSinkFactory?: unknown
  outboxSinkFactory?: unknown
  createPersistence: unknown
  invalidateTags?: unknown
  resolveInput: Callback
  resolveExistingRecord?: Callback
  resolveResourceIdentity: (arg: never) => Record<string, unknown>
  recoverCommittedResponse: Callback<Record<string, unknown> | null>
  toResponse: (arg: never) => Response
  definition: {
    key: string
    kind: string
    atomicity: unknown
    before?: Callback
    execute: Callback
    after?: Callback
    afterCommit?: Callback
    atomicBatch: { prepare: Callback<{ commands: unknown[]; result: unknown; verify: (arg: never) => void }> }
    authorization: { authorize: Callback<{ allowed: boolean }> }
    audit?: Record<string, unknown> & {
      resolveResourceId: (arg: never) => string
      extractNewValue?: (arg: never) => unknown
      extractOldValue?: (arg: never) => unknown
    }
  }
}

export function lastCapture(calls: unknown[]): WriteCapture {
  const capture = calls.at(-1)
  if (!capture) throw new Error("createFrameworkWriteHandler was not called")
  return capture as WriteCapture
}

/** A mutation operation context with just enough surface for the CRUD hooks. */
export function mutationOperation(context: RequestContext, persistence: PersistenceProvider, extra: Record<string, unknown> = {}) {
  return {
    operationId: "op-1",
    correlationId: "corr-1",
    request: context,
    persistence,
    services: { clock: { now: () => new Date(0) } },
    signal: new AbortController().signal,
    deadline: undefined,
    ...extra,
  }
}
