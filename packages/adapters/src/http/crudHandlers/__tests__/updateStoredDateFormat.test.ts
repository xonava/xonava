import { describe, expect, it, vi } from "vitest"
import type { EntityDescriptor, PersistenceProvider } from "@xonava/core/persistence"
import { Predicate, bindAbacSecurityDigest, evaluatePredicate, type NormalizedAbacPolicy, type PredicateNode, type VerifiedAbacPolicyBundle } from "@xonava/core/domain"
import { z } from "zod"
import { createUpdateHandler } from "../update"
import type { CrudShared } from "../types"
import { allowAllModuleFacts, canonicalRequestNormalization, trustedSession } from "../../__tests__/canonicalRequest"

type TestRow = { id: string; tenantId: string; name: string; dueOn: string; version: number }
type TestShared = CrudShared<TestRow, TestRow, Partial<TestRow>, TestRow, TestRow>

const MODULE = "test.update-stored-date"
const id = "00000000-0000-4000-8000-000000000001"
const entity: EntityDescriptor<TestRow> = {
  name: "update-stored-date-test",
  primaryKey: "id",
  tenantField: "tenantId",
  versionField: "version",
  fields: {
    id: { type: "string" },
    tenantId: { type: "string" },
    name: { type: "string" },
    dueOn: { type: "date" },
    version: { type: "number" },
  },
}

function policy(policyId: string, priority: number, compiledConditions: PredicateNode, write?: string[], effect: "allow" | "deny" = "allow"): NormalizedAbacPolicy {
  return {
    source: { policyId, scopeType: "tenant_default" },
    moduleKey: MODULE,
    effect,
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
    // New Year's Day is forbidden; everything else is open.
    policies: [policy("deny", 100, Predicate.eq("dueOn", "2024-01-01"), undefined, "deny"), policy("all", 10, Predicate.alwaysTrue())],
    context: { tenantId: "tenant-1" },
    defaultEffect: "deny",
    fieldCatalog: {
      dueOn: { key: "dueOn", type: "date", operators: [] },
      name: { key: "name", type: "string", operators: [] },
    },
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
      updateBody: z.object({ name: z.string().optional(), dueOn: z.string().optional() }),
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
  // Stored by an earlier release as a full date-time string (e.g. D1 text).
  const row: TestRow = { id, tenantId: "tenant-1", name: "before", dueOn: "2024-01-15T00:00:00.000Z", version: 1 }
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

describe("update date-format check validates only written values", () => {
  it("repairs a row whose stored date is not YYYY-MM-DD with a canonical patch", async () => {
    const repository = setup()
    const response = await patch(repository, { dueOn: "2024-01-20" })
    expect(response.status).toBe(200)
    expect(repository.updateOneWhereReturning).toHaveBeenCalledTimes(1)
  })

  it("still rejects a non-canonical written date and still applies the deny", async () => {
    const invalid = setup()
    expect((await patch(invalid, { dueOn: "2024-01-20T00:00:00.000Z" })).status).toBe(400)
    expect(invalid.updateOneWhereReturning).not.toHaveBeenCalled()
    const denied = setup()
    expect((await patch(denied, { dueOn: "2024-01-01" })).status).toBe(403)
    expect(denied.updateOneWhereReturning).not.toHaveBeenCalled()
  })

  it("leaves rows with a non-canonical stored date updatable on other fields", async () => {
    const repository = setup()
    expect((await patch(repository, { name: "after" })).status).toBe(200)
  })
})
