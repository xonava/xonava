/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, expect, it, vi } from "vitest"
import type { EntityDescriptor, PersistenceProvider } from "core/persistence"
import { Predicate, bindAbacSecurityDigest, createAbacAuthorizer, evaluatePredicate, type AbacPolicyBundle, type VerifiedAbacPolicyBundle, type NormalizedAbacPolicy } from "core/domain"
import { z } from "zod"
import { createDeleteHandler } from "../delete"
import { createUpdateHandler } from "../update"
import type { CrudShared } from "../types"
import { allowAllModuleFacts, canonicalRequestNormalization, trustedSession } from "../../__tests__/canonicalRequest"

type TestRow = { id: string; tenantId: string; name: string; version: number }
type TestShared = CrudShared<TestRow, TestRow, Partial<TestRow>, TestRow, TestRow>

const id = "00000000-0000-4000-8000-000000000001"
const entity: EntityDescriptor<TestRow> = {
  name: "write-read-scope-test",
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

const row: TestRow = { id, tenantId: "tenant-1", name: "before", version: 1 }

function session() {
  return {
    scope: "tenant" as const,
    actor: { id: "actor-1", type: "tenant" as const, tenantId: "tenant-1" },
    tenant: { id: "tenant-1", enabledModuleKeys: [], enabledModuleActions: {} },
    raw: {} as never,
  }
}

async function mutationOnlyBundle(action: "update" | "delete"): Promise<VerifiedAbacPolicyBundle> {
  const policy: NormalizedAbacPolicy = {
    source: { policyId: "mutation-only", scopeType: "tenant_default" },
    moduleKey: "test.write-read-scope",
    effect: "allow",
    priority: 100,
    payload: {
      actions: [action],
      capabilities: [],
      conditions: {
        version: 2,
        systemScope: { logic: "AND", conditions: [] },
        userFilters: { logic: "AND", conditions: [] },
      },
      fieldAccess: { write: ["name"] },
    },
    compiledConditions: Predicate.alwaysTrue(),
  }
  return bindAbacSecurityDigest({
    mode: "tenant",
    moduleKey: "test.write-read-scope",
    policies: [policy],
    context: { tenantId: "tenant-1" },
    defaultEffect: "deny",
    fieldCatalog: {},
  })
}

async function makeOptions(repository: Record<string, unknown>, action: "update" | "delete") {
  const currentSession = session()
  const abacBundle = await mutationOnlyBundle(action)
  const persistence = {
    dialect: "test",
    capabilities: { interactiveTransactions: true } as PersistenceProvider["capabilities"],
    repository: () => repository,
    runInTransaction: async (work: (scoped: PersistenceProvider) => Promise<unknown>) => work(persistence),
  } as unknown as PersistenceProvider
  return {
    adapterDeps: {
      assertValidCsrf: () => undefined,
      resolveAbacBundle: async () => abacBundle,
      resolveModuleAuthorizationFacts: allowAllModuleFacts,
    },
    requestNormalization: canonicalRequestNormalization(trustedSession({ kind: "tenant", tenantId: "tenant-1" }), "test.write-read-scope"),
    scope: { scope: "tenant" as const },
    moduleKey: "test.write-read-scope",
    entity,
    policy: { skipCapabilityCheck: true },
    cache: { enabled: false, tag: "test", keyPrefix: "test" },
    getCacheAdapter: async () => ({ deleteTag: async () => undefined }),
    createPersistence: () => persistence,
    validation: {
      idParams: z.object({ id: z.string() }),
      ...(action === "update" ? { updateBody: z.object({ name: z.string() }) } : {}),
    },
    audit: { enabled: false },
  } as unknown as TestShared["options"]
}

function makeShared(options: TestShared["options"]): TestShared {
  return {
    options,
    entity,
    deps: options.adapterDeps,
    idParamsSchema: z.object({ id: z.string() }),
    capabilityMode: { enabled: false, key: undefined },
    writeCapabilityConfig: { skipCapabilityCheck: true },
    routes: { list: false, detail: false, create: false, update: true, delete: true },
    writeRuntimeCapabilities: { deferredExecution: true, cache: true },
    buildReadTags: () => [],
    resolveDefaultSort: () => undefined,
    enforceReadRateLimit: async () => undefined,
    enforceReadAccess: async () => undefined,
    buildReadScope: () => ({ filter: undefined }),
    resolveReadScopeForContext: async () => ({ filter: Predicate.alwaysFalse() }),
  }
}

describe("CRUD mutation and read scopes", () => {
  it("updates when update is allowed but read is denied, without returning entity content", async () => {
    let updated = false
    const repository = {
      findOneWhere: vi.fn(async (filter: Parameters<typeof evaluatePredicate>[1]) =>
        evaluatePredicate(row, filter) ? row : null),
      findMany: vi.fn(async () => ({ rows: [], rowCount: 0, page: 1, pageSize: 1 })),
      updateOneWhereReturning: vi.fn(async (filter: Parameters<typeof evaluatePredicate>[1]) => {
        updated = evaluatePredicate(row, filter)
        return updated ? { ...row, name: "after" } : null
      }),
    }
    createAbacAuthorizer(await mutationOnlyBundle("update")).assertWrite({ action: "update", record: { ...row, name: "after" }, changedFields: ["name"] })
    const handler = createUpdateHandler(makeShared(await makeOptions(repository, "update")))

    const response = await handler(new Request(`https://example.test/items/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "after" }),
      headers: { "content-type": "application/json", "if-match": "1" },
    }), { params: Promise.resolve({ id }) })

    const body = await response.json() as Record<string, unknown>
    expect(response.status).toBe(200)
    expect(updated).toBe(true)
    expect(body).toEqual({ success: true, reason: "UPDATED_OUTSIDE_READ_SCOPE" })
    expect(body).not.toHaveProperty("name")
  })

  it("deletes when delete is allowed but read is denied", async () => {
    const repository = {
      findOneWhere: vi.fn(async (filter: Parameters<typeof evaluatePredicate>[1]) =>
        evaluatePredicate(row, filter) ? row : null),
      deleteWhere: vi.fn(async (filter: Parameters<typeof evaluatePredicate>[1]) => ({
        deletedCount: evaluatePredicate(row, filter) ? 1 : 0,
      })),
    }
    const handler = createDeleteHandler(makeShared(await makeOptions(repository, "delete")))

    const response = await handler(new Request(`https://example.test/items/${id}`, {
      method: "DELETE",
      headers: { "if-match": "1" },
    }), { params: Promise.resolve({ id }) })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ message: "Deleted" })
  })
})
