import { describe, expect, it, vi } from "vitest"
import type { EntityDescriptor, PersistenceProvider } from "@xonava/core/persistence"
import { Predicate, bindAbacSecurityDigest, evaluatePredicate, type NormalizedAbacPolicy, type PredicateNode, type VerifiedAbacPolicyBundle } from "@xonava/core/domain"
import { z } from "zod"
import { createUpdateHandler } from "../update"
import type { CrudShared } from "../types"
import { allowAllModuleFacts, canonicalRequestNormalization, trustedSession } from "../../__tests__/canonicalRequest"

type TestRow = { id: string; tenantId: string; name: string; locked: boolean; price: number; version: number }
type TestShared = CrudShared<TestRow, TestRow, Partial<TestRow>, TestRow, TestRow>

const MODULE = "test.update-pre-image"
const id = "00000000-0000-4000-8000-000000000001"
const entity: EntityDescriptor<TestRow> = {
  name: "update-pre-image-test",
  primaryKey: "id",
  tenantField: "tenantId",
  versionField: "version",
  fields: {
    id: { type: "string" },
    tenantId: { type: "string" },
    name: { type: "string" },
    locked: { type: "boolean" },
    price: { type: "number" },
    version: { type: "number" },
  },
}

function policy(policyId: string, priority: number, compiledConditions: PredicateNode, write?: string[]): NormalizedAbacPolicy {
  return {
    source: { policyId, scopeType: "tenant_default" },
    moduleKey: MODULE,
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

async function lockedBundle(): Promise<VerifiedAbacPolicyBundle> {
  return bindAbacSecurityDigest({
    mode: "tenant",
    moduleKey: MODULE,
    // A locked row only allows name edits; everything else is open.
    policies: [policy("locked", 100, Predicate.isTrue("locked"), ["name"]), policy("all", 10, Predicate.alwaysTrue())],
    context: { tenantId: "tenant-1" },
    defaultEffect: "deny",
    fieldCatalog: {},
  })
}

async function makeShared(repository: Record<string, unknown>): Promise<TestShared> {
  const abacBundle = await lockedBundle()
  const persistence = {
    dialect: "test",
    capabilities: { interactiveTransactions: true } as PersistenceProvider["capabilities"],
    repository: () => repository,
    runInTransaction: async (work: (scoped: PersistenceProvider) => Promise<unknown>) => work(persistence),
  } as unknown as PersistenceProvider
  const options = {
    adapterDeps: {
      assertValidCsrf: () => undefined,
      resolveAbacBundle: async () => abacBundle,
      resolveModuleAuthorizationFacts: allowAllModuleFacts,
    },
    requestNormalization: canonicalRequestNormalization(trustedSession({ kind: "tenant", tenantId: "tenant-1" }), MODULE),
    scope: { scope: "tenant" as const },
    moduleKey: MODULE,
    entity,
    policy: { skipCapabilityCheck: true },
    cache: { enabled: false, tag: "test", keyPrefix: "test" },
    getCacheAdapter: async () => ({ deleteTag: async () => undefined }),
    createPersistence: () => persistence,
    validation: {
      idParams: z.object({ id: z.string() }),
      updateBody: z.object({ name: z.string().optional(), locked: z.boolean().optional(), price: z.number().optional() }),
    },
    audit: { enabled: false },
  } as unknown as TestShared["options"]
  return {
    options,
    entity,
    deps: options.adapterDeps,
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

function setup() {
  const row: TestRow = { id, tenantId: "tenant-1", name: "before", locked: true, price: 10, version: 1 }
  const repository = {
    findOneWhere: vi.fn(async (filter: PredicateNode) => evaluatePredicate(row, filter) ? row : null),
    findMany: vi.fn(async () => ({ rows: [], rowCount: 0, page: 1, pageSize: 1 })),
    updateOneWhereReturning: vi.fn(async (filter: PredicateNode, patch: Partial<TestRow>) =>
      evaluatePredicate(row, filter) ? { ...row, ...patch, version: row.version + 1 } : null),
  }
  return repository
}

async function patch(repository: Record<string, unknown>, body: Record<string, unknown>): Promise<Response> {
  const handler = createUpdateHandler(await makeShared(repository))
  return handler(new Request(`https://example.test/items/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "if-match": "1" },
  }), { params: Promise.resolve({ id }) })
}

describe("update field-write ABAC uses the pre-image", () => {
  it("rejects a patch that unlocks the row to escape the restricting policy", async () => {
    const repository = setup()
    const response = await patch(repository, { locked: false, price: 0 })
    expect(response.status).toBe(403)
    expect(repository.updateOneWhereReturning).not.toHaveBeenCalled()
  })

  it("allows a change the restricting policy permits", async () => {
    const repository = setup()
    const response = await patch(repository, { name: "after" })
    expect(response.status).toBe(200)
    expect(repository.updateOneWhereReturning).toHaveBeenCalledTimes(1)
  })
})
