/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { EntityDescriptor, PersistenceProvider } from "@xonava/core/persistence"
import { Predicate, bindAbacSecurityDigest, evaluatePredicate, type NormalizedAbacPolicy, type PredicateNode, type VerifiedAbacPolicyBundle } from "@xonava/core/domain"
import { createUpdateHandler } from "../update"
import type { CrudShared } from "../types"
import { allowAllModuleFacts, canonicalRequestNormalization, trustedSession } from "../../__tests__/canonicalRequest"

type TestRow = {
  id: string
  tenantId: string
  name: string
}

const entity: EntityDescriptor<TestRow> = {
  name: "toctou-test",
  primaryKey: "id",
  tenantField: "tenantId",
  // No versionField — this is the key precondition for the TOCTOU check
  fields: {
    id: { type: "string" },
    tenantId: { type: "string" },
    name: { type: "string" },
  },
}

function makeSession() {
  return {
    scope: "tenant" as const,
    actor: { id: "actor-1", type: "tenant" as const, tenantId: "tenant-1", bypassAuthority: true },
    tenant: { id: "tenant-1", enabledModuleKeys: [], enabledModuleActions: {} },
    raw: {} as never,
  }
}

function makeShared(
  options: CrudShared<TestRow, TestRow, Partial<TestRow>, TestRow, TestRow>["options"],
): CrudShared<TestRow, TestRow, Partial<TestRow>, TestRow, TestRow> {
  return {
    options,
    entity: options.entity,
    deps: options.adapterDeps,
    idParamsSchema: z.object({ id: z.string() }),
    capabilityMode: { enabled: false, key: undefined },
    writeCapabilityConfig: { skipCapabilityCheck: true },
    routes: { list: false, detail: false, create: false, update: true, delete: false },
    writeRuntimeCapabilities: { deferredExecution: true, cache: true },
    resolveReadScopeForSession: async () => ({ filter: undefined }),
  } as unknown as CrudShared<TestRow, TestRow, Partial<TestRow>, TestRow, TestRow>
}

function makePersistence(interactiveTransactions = true): PersistenceProvider {
  return {
    dialect: "test",
    capabilities: { interactiveTransactions } as PersistenceProvider["capabilities"],
    repository: () => ({
      findOneWhere: vi.fn(async () => null),
      findMany: vi.fn(async () => ({ rows: [], rowCount: 0, page: 1, pageSize: 10 })),
      updateOneWhereReturning: vi.fn(async () => null),
    }),
    runInTransaction: async (work: (scoped: PersistenceProvider) => Promise<unknown>) => work(makePersistence()),
  } as unknown as PersistenceProvider
}

describe("P1-09 TOCTOU: ABAC without optimistic concurrency version field", () => {
  it("does not throw when entity has a version field", () => {
    const entityWithVersion: EntityDescriptor<TestRow & { version: number }> = {
      name: "toctou-test",
      primaryKey: "id",
      tenantField: "tenantId",
      versionField: "version",
      fields: {
        id: { type: "string" },
        tenantId: { type: "string" },
        name: { type: "string" },
        version: { type: "number" },
      },
    }
    const repository = {
      findOneWhere: vi.fn(async () => null),
      findMany: vi.fn(async () => ({ rows: [], rowCount: 0, page: 1, pageSize: 10 })),
      updateOneWhereReturning: vi.fn(async () => null),
    }
    const options = {
      adapterDeps: {
        assertValidCsrf: () => undefined,
        resolveAbacBundle: async () => undefined,
      },
      requestNormalization: canonicalRequestNormalization(trustedSession({ kind: "tenant", tenantId: "tenant-1" })),
      scope: { scope: "tenant" as const },
      moduleKey: "test.toctou-ok",
      entity: entityWithVersion,
      entityScope: { kind: "tenant" as const },
      policy: { skipCapabilityCheck: true },
      cache: { enabled: false, tag: "test", keyPrefix: "test" },
      getCacheAdapter: async () => ({ deleteTag: async () => undefined }),
      createPersistence: () => makePersistence(true),
      validation: {
        idParams: z.object({ id: z.string() }),
        updateBody: z.object({ name: z.string() }),
      },
      audit: { enabled: false },
      crud: {},
    } as unknown as CrudShared<TestRow & { version: number }, TestRow & { version: number }, Partial<TestRow & { version: number }>, TestRow & { version: number }, TestRow & { version: number }>["options"]
    const shared = makeShared(options as unknown as CrudShared<TestRow, TestRow, Partial<TestRow>, TestRow, TestRow>["options"]) as unknown as CrudShared<TestRow & { version: number }, TestRow & { version: number }, Partial<TestRow & { version: number }>, TestRow & { version: number }, TestRow & { version: number }>

    expect(() => createUpdateHandler(shared)).not.toThrow()
  })

  it("does not throw when optimisticConcurrency is configured even without entity.versionField", () => {
    const repository = {
      findOneWhere: vi.fn(async () => null),
      findMany: vi.fn(async () => ({ rows: [], rowCount: 0, page: 1, pageSize: 10 })),
      updateOneWhereReturning: vi.fn(async () => null),
    }
    const options = {
      adapterDeps: {
        assertValidCsrf: () => undefined,
        resolveAbacBundle: async () => undefined,
      },
      requestNormalization: canonicalRequestNormalization(trustedSession({ kind: "tenant", tenantId: "tenant-1" })),
      scope: { scope: "tenant" as const },
      moduleKey: "test.toctou-oc-config",
      entity,
      entityScope: { kind: "tenant" as const },
      policy: { skipCapabilityCheck: true },
      cache: { enabled: false, tag: "test", keyPrefix: "test" },
      getCacheAdapter: async () => ({ deleteTag: async () => undefined }),
      createPersistence: () => makePersistence(true),
      validation: {
        idParams: z.object({ id: z.string() }),
        updateBody: z.object({ name: z.string() }),
      },
      optimisticConcurrency: { versionField: "version" },
      audit: { enabled: false },
      crud: {},
    } as unknown as CrudShared<TestRow, TestRow, Partial<TestRow>, TestRow, TestRow>["options"]
    const shared = makeShared(options)

    expect(() => createUpdateHandler(shared)).not.toThrow()
  })

  it("does not throw when scope is public (ABAC not active)", () => {
    const repository = {
      findOneWhere: vi.fn(async () => null),
      findMany: vi.fn(async () => ({ rows: [], rowCount: 0, page: 1, pageSize: 10 })),
      updateOneWhereReturning: vi.fn(async () => null),
    }
    const options = {
      adapterDeps: {
        assertValidCsrf: () => undefined,
        resolveAbacBundle: async () => undefined,
      },
      requestNormalization: canonicalRequestNormalization(),
      scope: { scope: "public" as const },
      moduleKey: "test.toctou-public",
      entity,
      policy: { skipCapabilityCheck: true },
      cache: { enabled: false, tag: "test", keyPrefix: "test" },
      getCacheAdapter: async () => ({ deleteTag: async () => undefined }),
      createPersistence: () => makePersistence(true),
      validation: {
        idParams: z.object({ id: z.string() }),
        updateBody: z.object({ name: z.string() }),
      },
      audit: { enabled: false },
      crud: {},
    } as unknown as CrudShared<TestRow, TestRow, Partial<TestRow>, TestRow, TestRow>["options"]
    const shared = makeShared(options)

    expect(() => createUpdateHandler(shared)).not.toThrow()
  })

  it("rejects construction when resolveAbacBundle is not configured", () => {
    const repository = {
      findOneWhere: vi.fn(async () => null),
      findMany: vi.fn(async () => ({ rows: [], rowCount: 0, page: 1, pageSize: 10 })),
      updateOneWhereReturning: vi.fn(async () => null),
    }
    const options = {
      adapterDeps: {
        assertValidCsrf: () => undefined,
        // No resolveAbacBundle — ABAC is not configured
      },
      requestNormalization: canonicalRequestNormalization(trustedSession({ kind: "tenant", tenantId: "tenant-1" })),
      scope: { scope: "tenant" as const },
      moduleKey: "test.toctou-no-abac",
      entity,
      entityScope: { kind: "tenant" as const },
      policy: { skipCapabilityCheck: true },
      cache: { enabled: false, tag: "test", keyPrefix: "test" },
      getCacheAdapter: async () => ({ deleteTag: async () => undefined }),
      createPersistence: () => makePersistence(true),
      validation: {
        idParams: z.object({ id: z.string() }),
        updateBody: z.object({ name: z.string() }),
      },
      audit: { enabled: false },
      crud: {},
    } as unknown as CrudShared<TestRow, TestRow, Partial<TestRow>, TestRow, TestRow>["options"]
    const shared = makeShared(options)

    expect(() => createUpdateHandler(shared)).toThrow(/invalid required member.*resolveAbacBundle/)
  })
})

// TM10b: a record-dependent field-write policy decides on the row as read
// before the write. Without a version fence the row can change in between, so
// the handler refuses to run the update at all.

type FenceRow = { id: string; tenantId: string; name: string; locked: boolean; price: number; version: number }
type FenceShared = CrudShared<FenceRow, FenceRow, Partial<FenceRow>, FenceRow, FenceRow>

const FENCE_MODULE = "test.update-toctou"
const fenceId = "00000000-0000-4000-8000-000000000001"

const unfencedEntity: EntityDescriptor<FenceRow> = {
  name: "update-toctou-unfenced",
  primaryKey: "id",
  tenantField: "tenantId",
  fields: {
    id: { type: "string" },
    tenantId: { type: "string" },
    name: { type: "string" },
    locked: { type: "boolean" },
    price: { type: "number" },
    version: { type: "number" },
  },
}
const fencedEntity: EntityDescriptor<FenceRow> = { ...unfencedEntity, name: "update-toctou-fenced", versionField: "version" }

function fencePolicy(policyId: string, priority: number, compiledConditions: PredicateNode, write?: string[]): NormalizedAbacPolicy {
  return {
    source: { policyId, scopeType: "tenant_default" },
    moduleKey: FENCE_MODULE,
    effect: "allow",
    priority,
    payload: {
      actions: ["update"],
      capabilities: [],
      conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } },
      ...(write ? { fieldAccess: { write } } : {}),
    },
    compiledConditions,
  }
}

/** A locked row only allows name edits; the decision depends on the stored `locked` value. */
async function recordDependentBundle(): Promise<VerifiedAbacPolicyBundle> {
  return bindAbacSecurityDigest({
    mode: "tenant",
    moduleKey: FENCE_MODULE,
    policies: [fencePolicy("locked", 100, Predicate.isTrue("locked"), ["name"]), fencePolicy("all", 10, Predicate.alwaysTrue())],
    context: { tenantId: "tenant-1" },
    defaultEffect: "deny",
    fieldCatalog: {},
  })
}

/** The same grant without any record-dependent field restriction. */
async function recordIndependentBundle(): Promise<VerifiedAbacPolicyBundle> {
  return bindAbacSecurityDigest({
    mode: "tenant",
    moduleKey: FENCE_MODULE,
    policies: [fencePolicy("all", 10, Predicate.alwaysTrue())],
    context: { tenantId: "tenant-1" },
    defaultEffect: "deny",
    fieldCatalog: {},
  })
}

async function fenceShared(
  repository: Record<string, unknown>,
  options: { entity: EntityDescriptor<FenceRow>; bundle: VerifiedAbacPolicyBundle; optimisticConcurrency?: { versionField: string } },
): Promise<FenceShared> {
  const persistence = {
    dialect: "test",
    capabilities: { interactiveTransactions: true } as PersistenceProvider["capabilities"],
    repository: () => repository,
    runInTransaction: async (work: (scoped: PersistenceProvider) => Promise<unknown>) => work(persistence),
  } as unknown as PersistenceProvider
  const handlerOptions = {
    adapterDeps: {
      assertValidCsrf: () => undefined,
      resolveAbacBundle: async () => options.bundle,
      resolveModuleAuthorizationFacts: allowAllModuleFacts,
    },
    requestNormalization: canonicalRequestNormalization(trustedSession({ kind: "tenant", tenantId: "tenant-1" }), FENCE_MODULE),
    scope: { scope: "tenant" as const },
    moduleKey: FENCE_MODULE,
    entity: options.entity,
    policy: { skipCapabilityCheck: true },
    cache: { enabled: false, tag: "test", keyPrefix: "test" },
    getCacheAdapter: async () => ({ deleteTag: async () => undefined }),
    createPersistence: () => persistence,
    validation: {
      idParams: z.object({ id: z.string() }),
      updateBody: z.object({ name: z.string().optional(), locked: z.boolean().optional(), price: z.number().optional() }),
    },
    audit: { enabled: false },
    ...(options.optimisticConcurrency ? { optimisticConcurrency: options.optimisticConcurrency } : {}),
  } as unknown as FenceShared["options"]
  return {
    options: handlerOptions,
    entity: options.entity,
    deps: handlerOptions.adapterDeps,
    idParamsSchema: z.object({ id: z.string() }),
    capabilityMode: { enabled: false, key: undefined },
    writeCapabilityConfig: { skipCapabilityCheck: true },
    routes: { list: false, detail: false, create: false, update: true, delete: false },
    writeRuntimeCapabilities: { deferredExecution: true, cache: true },
    buildReadTags: () => [],
    resolveDefaultSort: () => undefined,
    enforceReadRateLimit: async () => undefined,
    enforceReadAccess: async () => undefined,
    buildReadScope: () => ({ filter: undefined }),
    resolveReadScopeForContext: async () => ({ filter: Predicate.alwaysFalse() }),
  }
}

/**
 * A stored row and a repository over it. `beforeWrite` runs inside the
 * conditional update, before the filter is evaluated: it models a concurrent
 * writer that commits after this request read the pre-image.
 */
function fenceStore(beforeWrite?: (row: FenceRow) => void) {
  const row: FenceRow = { id: fenceId, tenantId: "tenant-1", name: "before", locked: false, price: 10, version: 1 }
  const repository = {
    findOneWhere: vi.fn(async (filter: PredicateNode) => evaluatePredicate(row, filter) ? { ...row } : null),
    findMany: vi.fn(async () => ({ rows: [], rowCount: 0, page: 1, pageSize: 1 })),
    updateOneWhereReturning: vi.fn(async (filter: PredicateNode, patch: Partial<FenceRow>) => {
      beforeWrite?.(row)
      if (!evaluatePredicate(row, filter)) return null
      Object.assign(row, patch, { version: row.version + 1 })
      return { ...row }
    }),
  }
  return { row, repository }
}

async function sendUpdate(shared: FenceShared, body: Record<string, unknown>, ifMatch?: string): Promise<Response> {
  const handler = createUpdateHandler(shared)
  return handler(new Request(`https://example.test/items/${fenceId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(ifMatch === undefined ? {} : { "if-match": ifMatch }) },
  }), { params: Promise.resolve({ id: fenceId }) })
}

describe("TM10b record-dependent field-write policy needs a version fence", () => {
  it("answers a ConfigurationError (500) and writes nothing when the entity has no versionField or optimisticConcurrency", async () => {
    const { row, repository } = fenceStore()
    const shared = await fenceShared(repository, { entity: unfencedEntity, bundle: await recordDependentBundle() })
    const response = await sendUpdate(shared, { name: "after" }, "1")
    const text = await response.clone().text()
    expect(response.status, text).toBe(500)
    expect(text).toContain("INTERNAL_SERVER_ERROR")
    expect(text).not.toContain("optimistic concurrency")
    expect(repository.updateOneWhereReturning).not.toHaveBeenCalled()
    expect(row).toEqual({ id: fenceId, tenantId: "tenant-1", name: "before", locked: false, price: 10, version: 1 })
  })

  it("answers the same 500 and writes nothing when the request carries no If-Match on an unfenced entity", async () => {
    const { row, repository } = fenceStore()
    const shared = await fenceShared(repository, { entity: unfencedEntity, bundle: await recordDependentBundle() })
    const response = await sendUpdate(shared, { name: "after" })
    expect(response.status, await response.clone().text()).toBe(500)
    expect(repository.updateOneWhereReturning).not.toHaveBeenCalled()
    expect(row.name).toBe("before")
    expect(row.version).toBe(1)
  })

  it("refuses a fenced entity whose request has no If-Match before any write (428)", async () => {
    const { row, repository } = fenceStore()
    const shared = await fenceShared(repository, { entity: fencedEntity, bundle: await recordDependentBundle() })
    const response = await sendUpdate(shared, { name: "after" })
    expect(response.status, await response.clone().text()).toBe(428)
    expect(repository.updateOneWhereReturning).not.toHaveBeenCalled()
    expect(row.name).toBe("before")
  })

  it("accepts the fence from optimisticConcurrency when the entity has no versionField", async () => {
    const { row, repository } = fenceStore()
    const shared = await fenceShared(repository, { entity: unfencedEntity, bundle: await recordDependentBundle(), optimisticConcurrency: { versionField: "version" } })
    const response = await sendUpdate(shared, { name: "after" }, "1")
    expect(response.status, await response.clone().text()).toBe(200)
    expect(repository.updateOneWhereReturning).toHaveBeenCalledOnce()
    expect(row.name).toBe("after")
  })

  it("does not require a fence when no field-write policy depends on the record", async () => {
    const { row, repository } = fenceStore()
    const shared = await fenceShared(repository, { entity: unfencedEntity, bundle: await recordIndependentBundle() })
    const response = await sendUpdate(shared, { name: "after" })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(repository.updateOneWhereReturning).toHaveBeenCalledOnce()
    expect(row.name).toBe("after")
  })

  it("answers 409 and leaves the row unchanged when a concurrent writer changed a policy-driving field after the pre-image read", async () => {
    // The request read an unlocked row (version 1) and the policy allowed the
    // patch. Before the conditional write, another writer locks the row.
    const { row, repository } = fenceStore((current) => { current.locked = true; current.version = 2 })
    const shared = await fenceShared(repository, { entity: fencedEntity, bundle: await recordDependentBundle() })
    const response = await sendUpdate(shared, { name: "after", price: 99 }, "1")
    const text = await response.clone().text()
    expect(response.status, text).toBe(409)
    expect(text).toContain("CONFLICT")
    expect(repository.updateOneWhereReturning).toHaveBeenCalledOnce()
    // Only the concurrent writer's change is stored; this request wrote nothing.
    expect(row).toEqual({ id: fenceId, tenantId: "tenant-1", name: "before", locked: true, price: 10, version: 2 })
  })
})
