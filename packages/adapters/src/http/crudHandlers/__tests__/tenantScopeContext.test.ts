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

// TM13b: platform routes do not consult module entitlements. ABAC is the only
// authorization input, and a missing bundle still fails closed.
type Announcement = { id: string; title: string; version: number }

function platformFixture(options: { facts?: ReturnType<typeof vi.fn>; bundle?: "allow" | "none" } = {}) {
  const rows: Announcement[] = [{ id: "n1", title: "maintenance", version: 1 }]
  const repository = {
    findById: vi.fn(async (id: string) => rows.find((row) => row.id === id) ?? null),
    insert: vi.fn(async (data: Announcement) => { rows.push({ ...data }); return { ...data } }),
    findOneWhere: vi.fn(async (filter: PredicateNode) => rows.find((row) => evaluatePredicate(row, filter)) ?? null),
    findMany: vi.fn(async ({ filter }: { filter?: PredicateNode }) => {
      const selected = rows.filter((row) => !filter || evaluatePredicate(row, filter))
      return { rows: selected, rowCount: selected.length, page: 1, pageSize: 20 }
    }),
  }
  const persistence = {
    dialect: "test",
    capabilities: { interactiveTransactions: true, atomicBatch: false, returningInsert: true, readSessions: false, jsonQueries: false, exactDecimal: false, persistentConnection: false, maxPageSize: 100 },
    repository: () => repository,
    runInTransaction: async (work: (provider: PersistenceProvider) => Promise<unknown>) => work(persistence),
  } as unknown as PersistenceProvider
  const entity = defineEntity<Announcement, { title: string }, { title?: string | undefined }, Announcement, Announcement>({
    moduleKey: "platform.announcements",
    entity: { name: "announcement", primaryKey: "id", versionField: "version", fields: { id: { type: "string" }, title: { type: "string" }, version: { type: "number" } } },
    entityScope: { kind: "platform", acknowledged: true },
    policy: { skipCapabilityCheck: true },
    cache: false,
    audit: false,
    validation: { createBody: z.object({ title: z.string() }).strict(), updateBody: z.object({ title: z.string().optional() }).strict(), idParams: z.object({ id: z.string() }) },
  })
  // Entitlements that would deny a tenant request for every action: nothing is enabled.
  const facts = options.facts ?? vi.fn(() => ({ enabledModuleKeys: [], enabledModuleActions: {}, enabledModuleCapabilities: {} }))
  const resolveAbacBundle = vi.fn(async ({ moduleKey }: { moduleKey: string }) => options.bundle === "none" ? null : allowAllAbacBundle(moduleKey))
  const handlers = CRUD(entity, {
    adapterDeps: { assertValidCsrf: () => undefined, resolveModuleAuthorizationFacts: facts as never, resolveAbacBundle },
    requestNormalization: canonicalRequestNormalization(trustedSession({ kind: "platform", platformKey: "ops" }), "platform.announcements"),
    scope: { scope: "platform", idempotency: { required: false } },
    createPersistence: () => persistence,
    getCacheAdapter: vi.fn(),
    runtimeCapabilities: { deferredExecution: true, cache: false },
  })
  return { handlers, repository, facts, resolveAbacBundle }
}

describe("platform-scoped CRUD does not consult module entitlements (TM13b)", () => {
  it("serves list and detail while the entitlement facts enable nothing", async () => {
    const { handlers, facts } = platformFixture()
    const list = await handlers.list(get("https://example.test/announcements"))
    expect(list.status, await list.clone().text()).toBe(200)
    expect(JSON.stringify(await list.json())).toContain("maintenance")
    const detail = await handlers.detail(get("https://example.test/announcements/n1"), { id: "n1" })
    expect(detail.status, await detail.clone().text()).toBe(200)
    // The facts may be resolved, but their entitlement lists decide nothing on a platform route.
    expect(facts).toHaveBeenCalled()
  })

  it("serves the same requests whatever the entitlement facts say", async () => {
    const enabledEverything = vi.fn((args: { moduleKey: string }) => ({
      enabledModuleKeys: [args.moduleKey], enabledModuleActions: { [args.moduleKey]: ["manage"] }, enabledModuleCapabilities: { [args.moduleKey]: ["manage"] },
    }))
    for (const facts of [enabledEverything, vi.fn(() => ({})), vi.fn(() => ({ enabledModuleKeys: ["unrelated"] }))]) {
      const { handlers } = platformFixture({ facts })
      expect((await handlers.list(get("https://example.test/announcements"))).status).toBe(200)
    }
  })

  it("lets a write through while the entitlement facts enable nothing", async () => {
    const { handlers, repository } = platformFixture()
    const response = await handlers.create(new Request("https://example.test/announcements", {
      method: "POST", body: JSON.stringify({ title: "new" }), headers: { "content-type": "application/json" },
    }))
    expect(response.status, await response.clone().text()).toBe(201)
    expect(repository.insert).toHaveBeenCalledOnce()
  })

  it("fails closed with 403 and no repository call when the platform route has no ABAC bundle", async () => {
    const { handlers, repository, resolveAbacBundle } = platformFixture({ bundle: "none" })
    const list = await handlers.list(get("https://example.test/announcements"))
    expect(list.status, await list.clone().text()).toBe(403)
    const detail = await handlers.detail(get("https://example.test/announcements/n1"), { id: "n1" })
    expect(detail.status).toBe(403)
    const create = await handlers.create(new Request("https://example.test/announcements", {
      method: "POST", body: JSON.stringify({ title: "new" }), headers: { "content-type": "application/json" },
    }))
    expect(create.status).toBe(403)
    expect(resolveAbacBundle).toHaveBeenCalled()
    for (const fn of Object.values(repository)) expect(fn).not.toHaveBeenCalled()
  })
})
