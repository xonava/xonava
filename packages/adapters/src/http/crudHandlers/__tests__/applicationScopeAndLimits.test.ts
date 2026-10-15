import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { defineEntity } from "@xonava/core/entity"
import { evaluatePredicate, type ExecutionScope, type PredicateNode } from "@xonava/core/domain"
import type { AuditRecord } from "@xonava/core/events"
import type { PersistenceProvider } from "@xonava/core/persistence"
import { CRUD } from "../../crud"
import { allowAllAbacBundle, allowAllModuleFacts, canonicalRequestNormalization, trustedSession } from "../../__tests__/canonicalRequest"

type Row = { id: string; appId: string; name: string; badge?: string; version: number }

function memoryPersistence() {
  const rows = new Map<string, Row>()
  const select = (filter?: PredicateNode) => [...rows.values()].filter(row => !filter || evaluatePredicate(row, filter))
  const repository = {
    findById: vi.fn(async (id: string) => rows.get(id) ?? null),
    findOneWhere: vi.fn(async (filter: PredicateNode) => select(filter)[0] ?? null),
    findMany: vi.fn(async ({ filter }: { filter?: PredicateNode }) => ({ rows: select(filter), rowCount: select(filter).length, page: 1, pageSize: 20 })),
    insert: vi.fn(async (data: Row) => { rows.set(data.id, { ...data }); return { ...data } }),
    updateOneWhereReturning: vi.fn(async (filter: PredicateNode, patch: Partial<Row>) => {
      const current = select(filter)[0]
      if (!current) return null
      const updated = { ...current, ...patch, version: current.version + 1 }
      rows.set(updated.id, updated)
      return { ...updated }
    }),
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
  return { rows, persistence }
}

type Body = { name?: string | undefined; appId?: string | undefined; badge?: string | undefined }
const passthroughBody = z.object({ name: z.string().optional(), appId: z.string().optional(), badge: z.string().optional() }).strict()

function fixture(options: { scope?: ExecutionScope; queryLimits?: Record<string, number>; auditSink?: { write: (record: AuditRecord) => Promise<void> } } = {}) {
  const { rows, persistence } = memoryPersistence()
  const entity = defineEntity<Row, Body, Body, Row, Row>({
    moduleKey: "apps.records",
    entity: { name: "record", primaryKey: "id", versionField: "version", fields: { id: { type: "string" }, appId: { type: "string" }, name: { type: "string" }, badge: { type: "string", classification: "confidential", nullable: true }, version: { type: "number" } } },
    entityScope: { kind: "application", field: "appId" },
    policy: { skipCapabilityCheck: true },
    cache: false,
    audit: options.auditSink ? { includeValues: true, fieldClassification: { name: "include", badge: "include" } } : false,
    ...(options.queryLimits ? { queryLimits: options.queryLimits } : {}),
    validation: { createBody: passthroughBody, updateBody: passthroughBody, idParams: z.object({ id: z.string() }) },
  })
  const scope = options.scope ?? { kind: "application", applicationKey: "app-a" }
  const handlers = CRUD(entity, {
    adapterDeps: { assertValidCsrf: () => undefined, resolveModuleAuthorizationFacts: allowAllModuleFacts, resolveAbacBundle: async ({ moduleKey }) => allowAllAbacBundle(moduleKey) },
    requestNormalization: canonicalRequestNormalization(trustedSession(scope), "apps.records"),
    scope: { scope: "application", idempotency: { required: false } },
    createPersistence: () => persistence,
    getCacheAdapter: vi.fn(),
    runtimeCapabilities: { deferredExecution: true, cache: false },
    ...(options.auditSink ? { auditSinkFactory: () => options.auditSink! } : {}),
  })
  return { handlers, rows }
}

const json = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => new Request(url, {
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
})

describe("application-scoped CRUD isolation", () => {
  it("injects the trusted application key on create and rejects client-chosen scope values", async () => {
    const { handlers, rows } = fixture()
    const created = await handlers.create(json("POST", "https://example.test/records", { name: "Ada" }))
    expect(created.status, await created.clone().text()).toBe(201)
    const row = await created.json() as Row
    expect(rows.get(row.id)?.appId).toBe("app-a")

    const forged = await handlers.create(json("POST", "https://example.test/records", { name: "Eve", appId: "app-b" }))
    expect(forged.status).toBe(403)
    expect([...rows.values()].some(candidate => candidate.appId === "app-b")).toBe(false)
  })

  it("rejects an update that moves a row to another application", async () => {
    const { handlers, rows } = fixture()
    rows.set("r1", { id: "r1", appId: "app-a", name: "Ada", version: 1 })
    const moved = await handlers.update(json("PATCH", "https://example.test/records/r1", { appId: "app-b" }, { "if-match": "1" }), { params: Promise.resolve({ id: "r1" }) })
    expect(moved.status).toBe(403)
    expect(rows.get("r1")?.appId).toBe("app-a")
  })

  it("filters list, detail, and delete by the trusted application key", async () => {
    const { handlers, rows } = fixture()
    rows.set("mine", { id: "mine", appId: "app-a", name: "mine", version: 1 })
    rows.set("theirs", { id: "theirs", appId: "app-b", name: "theirs", version: 1 })
    const list = await handlers.list(json("GET", "https://example.test/records"))
    expect(list.status).toBe(200)
    const text = await list.text()
    expect(text).toContain("mine")
    expect(text).not.toContain("theirs")
    expect((await handlers.detail(json("GET", "https://example.test/records/theirs"), { id: "theirs" })).status).toBe(404)
    expect((await handlers.delete(json("DELETE", "https://example.test/records/theirs", undefined, { "if-match": "1" }), { params: Promise.resolve({ id: "theirs" }) })).status).toBe(404)
    expect(rows.has("theirs")).toBe(true)
  })

  it("fails closed when an application-scoped entity is reached outside an application scope", async () => {
    const { handlers, rows } = fixture({ scope: { kind: "platform", platformKey: "ops" } })
    rows.set("theirs", { id: "theirs", appId: "app-b", name: "theirs", version: 1 })
    expect((await handlers.list(json("GET", "https://example.test/records"))).status).toBe(403)
    expect((await handlers.create(json("POST", "https://example.test/records", { name: "x" }))).status).toBe(403)
    expect(rows.size).toBe(1)
  })
})

describe("entity query limits on list", () => {
  it("serves lists for entities that declare pagination/count/search limits", async () => {
    const { handlers, rows } = fixture({ queryLimits: { maxOffset: 100, maxCount: 50, maxSearchableColumns: 2, maxSortFields: 2 } })
    rows.set("mine", { id: "mine", appId: "app-a", name: "mine", version: 1 })
    const list = await handlers.list(json("GET", "https://example.test/records"))
    expect(list.status, await list.clone().text()).toBe(200)
  })

  it("still enforces maxOffset", async () => {
    const { handlers } = fixture({ queryLimits: { maxOffset: 10 } })
    const list = await handlers.list(json("GET", "https://example.test/records?page=3&pageSize=10"))
    expect(list.status).toBe(400)
  })
})

describe("audit classification", () => {
  it("never lets an explicit audit map weaken classification-derived redaction", async () => {
    const records: AuditRecord[] = []
    const { handlers } = fixture({ auditSink: { write: async (record) => { records.push(record) } } })
    const created = await handlers.create(json("POST", "https://example.test/records", { name: "Ada", badge: "zebra77" }))
    expect(created.status, await created.clone().text()).toBe(201)
    expect(records).toHaveLength(1)
    const serialized = JSON.stringify(records[0])
    expect((records[0]?.newValue as Record<string, unknown>).badge).toBe("[masked]")
    expect(serialized).not.toContain("zebra77")
  })
})
