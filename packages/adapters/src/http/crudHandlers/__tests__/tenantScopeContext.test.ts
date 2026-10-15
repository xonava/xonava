import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { defineEntity } from "@xonava/core/entity"
import { evaluatePredicate, type ExecutionScope, type PredicateNode } from "@xonava/core/domain"
import type { PersistenceProvider } from "@xonava/core/persistence"
import { CRUD } from "../../crud"
import { allowAllAbacBundle, allowAllModuleFacts, canonicalRequestNormalization, trustedSession } from "../../__tests__/canonicalRequest"

type Row = { id: string; tenantId: string; name: string; version: number }

function fixture(scope: ExecutionScope) {
  const rows = new Map<string, Row>([
    ["a", { id: "a", tenantId: "tenant-a", name: "a", version: 1 }],
    ["b", { id: "b", tenantId: "tenant-b", name: "b", version: 1 }],
  ])
  const select = (filter?: PredicateNode) => [...rows.values()].filter(row => !filter || evaluatePredicate(row, filter))
  const repository = {
    findById: vi.fn(async (id: string) => rows.get(id) ?? null),
    findOneWhere: vi.fn(async (filter: PredicateNode) => select(filter)[0] ?? null),
    findMany: vi.fn(async ({ filter }: { filter?: PredicateNode }) => ({ rows: select(filter), rowCount: select(filter).length, page: 1, pageSize: 20 })),
    deleteWhere: vi.fn(async (filter: PredicateNode) => {
      const matches = select(filter)
      for (const row of matches) rows.delete(row.id)
      return { deletedCount: matches.length }
    }),
  }
  const persistence = {
    dialect: "test",
    capabilities: { interactiveTransactions: true, atomicBatch: false, returningInsert: true, readSessions: false, jsonQueries: false, exactDecimal: false, persistentConnection: false, maxPageSize: 100 },
    repository: () => repository,
    runInTransaction: async (work: (provider: PersistenceProvider) => Promise<unknown>) => work(persistence),
  } as unknown as PersistenceProvider
  const body = z.object({ name: z.string().optional() }).strict()
  const entity = defineEntity<Row, { name?: string | undefined }, { name?: string | undefined }, Row, Row>({
    moduleKey: "tenants.records",
    entity: { name: "record", primaryKey: "id", tenantField: "tenantId", versionField: "version", fields: { id: { type: "string" }, tenantId: { type: "string" }, name: { type: "string" }, version: { type: "number" } } },
    entityScope: { kind: "tenant" },
    policy: { skipCapabilityCheck: true },
    cache: false,
    audit: false,
    validation: { createBody: body, updateBody: body, idParams: z.object({ id: z.string() }) },
  })
  const handlers = CRUD(entity, {
    adapterDeps: { assertValidCsrf: () => undefined, resolveModuleAuthorizationFacts: allowAllModuleFacts, resolveAbacBundle: async ({ moduleKey }) => allowAllAbacBundle(moduleKey) },
    requestNormalization: canonicalRequestNormalization(trustedSession(scope), "tenants.records"),
    scope: { scope: scope.kind === "tenant" ? "tenant" : "platform", idempotency: { required: false } },
    createPersistence: () => persistence,
    getCacheAdapter: vi.fn(),
    runtimeCapabilities: { deferredExecution: true, cache: false },
  })
  return { handlers, rows }
}

const get = (url: string) => new Request(url, { method: "GET" })

describe("tenant-scoped CRUD outside a tenant scope", () => {
  it("never serves rows across tenants to a non-tenant request", async () => {
    const { handlers, rows } = fixture({ kind: "platform", platformKey: "ops" })
    expect((await handlers.list(get("https://example.test/records"))).status).toBe(403)
    expect((await handlers.detail(get("https://example.test/records/b"), { id: "b" })).status).toBe(403)
    expect(rows.size).toBe(2)
  })

  it("still serves the caller's own tenant", async () => {
    const { handlers } = fixture({ kind: "tenant", tenantId: "tenant-a" })
    const response = await handlers.list(get("https://example.test/records"))
    expect(response.status, await response.clone().text()).toBe(200)
    const payload = await response.json() as { data?: { id: string }[]; rows?: { id: string }[] }
    expect(JSON.stringify(payload)).toContain("\"a\"")
    expect(JSON.stringify(payload)).not.toContain("tenant-b")
  })
})
