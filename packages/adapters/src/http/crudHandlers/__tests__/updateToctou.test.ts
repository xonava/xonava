/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { EntityDescriptor, PersistenceProvider } from "core/persistence"
import { createUpdateHandler } from "../update"
import type { CrudShared } from "../types"
import { canonicalRequestNormalization, trustedSession } from "../../__tests__/canonicalRequest"

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
