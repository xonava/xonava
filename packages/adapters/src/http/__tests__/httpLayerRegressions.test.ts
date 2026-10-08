import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { defineEntity } from "core/entity"
import {
  bindAbacSecurityDigest,
  evaluatePredicate,
  RetryablePersistenceError,
  UnavailableError,
  type PredicateNode,
} from "core/domain"
import { CRUD } from "../crud"
import { defaultListQuerySchema } from "../crudHandlers/types"
import { createFrameworkErrorHandler } from "../handleFrameworkCoreError"
import { predicateFromFilterCondition } from "../filterInterop"
import { allowAllAbacBundle, allowAllModuleFacts, canonicalRequestNormalization, trustedSession } from "./canonicalRequest"

type Row = { id: string; tenantId: string; name: string; ssn?: string; ownerId?: string; version: number }

function memoryPersistence(atomicBatch = false) {
  const rows = new Map<string, Row>()
  const select = (f?: PredicateNode) => [...rows.values()].filter(r => !f || evaluatePredicate(r, f))
  const findMany = vi.fn(async ({ filter }: { filter?: PredicateNode }) => ({ rows: select(filter), rowCount: select(filter).length, page: 1, pageSize: 20 }))
  const repository = {
    findById: async (id: string) => rows.get(id) ?? null,
    findOneWhere: async (f: PredicateNode) => select(f)[0] ?? null,
    findMany,
    insert: async (d: Row) => { rows.set(d.id, { ...d }); return { ...d } },
    updateOneWhereReturning: async (f: PredicateNode, p: Partial<Row>) => {
      const c = select(f)[0]
      if (!c) return null
      const u = { ...c, ...p, version: c.version + 1 }
      rows.set(u.id, u)
      return { ...u }
    },
    deleteWhere: async (f: PredicateNode) => { const m = select(f); for (const r of m) rows.delete(r.id); return { deletedCount: m.length } },
  }
  type Command = { kind: string; values?: Record<string, unknown>; filter?: PredicateNode }
  const encoder = (tenantId: string) => ({ tenantId, encode: (c: Command) => c })
  const persistence: Record<string, unknown> = atomicBatch
    ? {
        dialect: "test-d1",
        capabilities: { interactiveTransactions: false, atomicBatch: true, atomicBatchScope: "tenant-scoped", maxPageSize: 100, maxBindParams: 100, maxStatementBytes: 100_000 },
        tenantId: "tenant-1",
        commandEncoder: encoder("tenant-1"),
        createTenantScopedCommandEncoder: encoder,
        repository: () => repository,
        executeAtomicBatch: async (plan: { items: readonly { kind: string; command?: Command }[] }) => plan.items.map((item) => {
          const cmd = item.command
          if (item.kind !== "command" || !cmd) return { kind: item.kind, result: { ok: true } }
          if (cmd.kind === "insert") { rows.set(String(cmd.values!.id), cmd.values as Row); return { kind: "command", result: { meta: { changes: 1 } } } }
          const targets = select(cmd.filter)
          for (const t of targets) {
            if (cmd.kind === "delete") rows.delete(t.id)
            else rows.set(t.id, { ...t, ...cmd.values, version: t.version + 1 })
          }
          return { kind: "command", result: { meta: { changes: targets.length } } }
        }),
      }
    : {
        dialect: "test",
        capabilities: { interactiveTransactions: true, atomicBatch: false, maxPageSize: 100 },
        repository: () => repository,
        runInTransaction: async (w: (p: unknown) => unknown) => w(persistence),
      }
  return { rows, findMany, persistence }
}

function memoryIdempotencyPort() {
  const store = new Map<string, { fp: string; state: string; result?: unknown }>()
  return {
    acquire: async (r: { scope: string; key: string; fingerprint: string }) => {
      const k = `${r.scope}|${r.key}`
      const e = store.get(k)
      if (!e) { store.set(k, { fp: r.fingerprint, state: "pending" }); return { outcome: "acquired", token: "t" } }
      if (e.fp !== r.fingerprint) return { outcome: "conflict" }
      if (e.state === "done") return { outcome: "replay", result: e.result }
      return { outcome: "in-progress" }
    },
    renew: async () => undefined,
    markCommittedInTransaction: async () => undefined,
    complete: async (r: { scope: string; key: string; fingerprint: string; result: unknown }) => {
      store.set(`${r.scope}|${r.key}`, { fp: r.fingerprint, state: "done", result: r.result })
    },
  }
}

const fields = {
  id: { type: "string" },
  tenantId: { type: "string" },
  name: { type: "string" },
  ssn: { type: "string", classification: "restricted" },
  ownerId: { type: "string" },
  version: { type: "number" },
}

function build(extra: Record<string, unknown>, opts: { bundle?: (moduleKey: string) => unknown; atomicBatch?: boolean } = {}) {
  const mem = memoryPersistence(opts.atomicBatch)
  const port = memoryIdempotencyPort()
  const entity = defineEntity<Row, any, any>({
    moduleKey: "http.people",
    entity: { name: "person", primaryKey: "id", tenantField: "tenantId", versionField: "version", fields },
    entityScope: { kind: "tenant" }, policy: { skipCapabilityCheck: true }, cache: false, audit: false,
    validation: { createBody: z.object({ name: z.string() }), updateBody: z.object({ name: z.string() }), idParams: z.object({ id: z.string() }) },
    ...extra,
  } as any)
  const handlers = CRUD(entity, {
    adapterDeps: {
      assertValidCsrf: () => undefined,
      resolveModuleAuthorizationFacts: allowAllModuleFacts,
      resolveAbacBundle: async ({ moduleKey }: { moduleKey: string }) => (opts.bundle ?? allowAllAbacBundle)(moduleKey),
      createIdempotencyPort: () => port,
    } as any,
    requestNormalization: canonicalRequestNormalization(trustedSession({ kind: "tenant", tenantId: "tenant-1" }), "http.people"),
    scope: { scope: "tenant", idempotency: { required: false } },
    createPersistence: () => mem.persistence as any,
    getCacheAdapter: vi.fn(),
  })
  return { handlers, ...mem }
}

describe("defect 1: list query allowlists come from the compiled entity", () => {
  const listWith = (handlers: ReturnType<typeof build>["handlers"], query: Record<string, unknown>) =>
    handlers.list(new Request(`https://x/people?${new URLSearchParams(Object.fromEntries(Object.entries(query).map(([k, v]) => [k, JSON.stringify(v)]))).toString()}`))

  it("rejects sorting by fields that are not declared sortable", async () => {
    const { handlers, findMany } = build({ sortableColumns: ["name"], filterableColumns: ["name"] })
    for (const field of ["tenantId", "version", "ssn", "undeclaredColumn", "constructor", "__proto__"]) {
      const res = await listWith(handlers, { sorting: [{ id: field }] })
      expect(res.status, field).toBe(400)
    }
    expect(findMany).not.toHaveBeenCalled()
    const ok = await listWith(handlers, { sorting: [{ id: "name", desc: true }] })
    expect(ok.status).toBe(200)
    expect(findMany.mock.calls.at(-1)?.[0]).toMatchObject({ sort: [{ field: "name", direction: "desc" }] })
  })

  it("rejects all caller sorting when no sortable columns are declared", async () => {
    const { handlers } = build({ filterableColumns: ["name"] })
    expect((await listWith(handlers, { sorting: [{ id: "name" }] })).status).toBe(400)
    expect((await listWith(handlers, {})).status).toBe(200)
  })

  it("strips restricted classified fields from filter and search allowlists", async () => {
    const { handlers, findMany } = build({ filterableColumns: ["name", "ssn"], searchableColumns: ["name", "ssn"] })
    const filtered = await listWith(handlers, { filters: { conditions: [{ field: "ssn", operator: "startsWith", value: "12" }] } })
    expect(filtered.status).toBe(400)
    const searched = await listWith(handlers, { filters: { search: "12" } })
    expect(searched.status).toBe(200)
    expect(JSON.stringify(findMany.mock.calls.at(-1)?.[0]?.filter)).not.toContain("ssn")
  })

  it("does not honour inherited filter field metadata", () => {
    const meta = Object.create({ alias: { columnName: "secret" } }) as Record<string, { columnName?: string }>
    expect(() => predicateFromFilterCondition({ field: "alias", value: "x" }, ["secret"], meta as never)).toThrow("not allowed")
  })
})

describe("defect 2: idempotent replay runs before resource resolution", () => {
  it("replays a completed DELETE after the row is gone", async () => {
    const { handlers, rows } = build({})
    rows.set("r1", { id: "r1", tenantId: "tenant-1", name: "a", version: 1 })
    const req = () => new Request("https://x/people/r1", { method: "DELETE", headers: { "Idempotency-Key": "k1", "if-match": '"1"' } })
    const first = await handlers.delete(req(), { params: Promise.resolve({ id: "r1" }) })
    expect(first.status).toBe(200)
    const retry = await handlers.delete(req(), { params: Promise.resolve({ id: "r1" }) })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ message: "Deleted" })
  })

  it("replays a completed UPDATE after the row left the caller's scope", async () => {
    const { handlers, rows } = build({})
    rows.set("r1", { id: "r1", tenantId: "tenant-1", name: "a", version: 1 })
    const req = () => new Request("https://x/people/r1", { method: "PATCH", body: JSON.stringify({ name: "b" }), headers: { "content-type": "application/json", "Idempotency-Key": "k2", "if-match": '"1"' } })
    const first = await handlers.update(req(), { params: Promise.resolve({ id: "r1" }) })
    expect(first.status).toBe(200)
    const firstBody = await first.json()
    rows.set("r1", { ...rows.get("r1")!, tenantId: "tenant-2" })
    const retry = await handlers.update(req(), { params: Promise.resolve({ id: "r1" }) })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual(firstBody)
  })

  it("still reports a conflicting reuse of the key before loading the row", async () => {
    const { handlers, rows } = build({})
    rows.set("r1", { id: "r1", tenantId: "tenant-1", name: "a", version: 1 })
    const del = (id: string) => handlers.delete(new Request(`https://x/people/${id}`, { method: "DELETE", headers: { "Idempotency-Key": "k3", "if-match": '"1"' } }), { params: Promise.resolve({ id }) })
    expect((await del("r1")).status).toBe(200)
    expect((await del("missing")).status).toBe(409)
  })
})

describe("defect 3: ABAC create/update is re-enforced on the transformed record", () => {
  const writeNameOwnerBundle = (moduleKey: string) => bindAbacSecurityDigest({ mode: "platform", moduleKey, policies: [{
    source: { policyId: "p", scopeType: "platform_default" }, moduleKey, effect: "allow", priority: 1,
    payload: { actions: ["read", "create", "update", "delete"], capabilities: ["manage"], fieldAccess: { write: ["name", "owner"] },
      conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } } },
    compiledConditions: { kind: "literal", value: true } } as never], context: {}, defaultEffect: "deny", fieldCatalog: {} } as never)
  const crud = {
    create: { transformInput: async ({ input }: { input: { name: string; owner: string } }) => ({ name: input.name, ownerId: input.owner }) },
    update: { transformInput: async ({ patch }: { patch: { name: string; owner: string } }) => ({ name: patch.name, ownerId: patch.owner }) },
  }
  const validation = { createBody: z.object({ name: z.string(), owner: z.string() }), updateBody: z.object({ name: z.string(), owner: z.string() }), idParams: z.object({ id: z.string() }) }

  for (const atomicBatch of [false, true]) {
    it(`rejects a create whose transformed body writes a forbidden field (atomicBatch=${atomicBatch})`, async () => {
      const { handlers, rows } = build({ crud, validation }, { bundle: writeNameOwnerBundle, atomicBatch })
      const res = await handlers.create(new Request("https://x/people", { method: "POST", body: JSON.stringify({ name: "a", owner: "victim" }), headers: { "content-type": "application/json" } }))
      expect(res.status).toBe(403)
      expect(rows.size).toBe(0)
    })

    it(`rejects an update whose transformed patch writes a forbidden field (atomicBatch=${atomicBatch})`, async () => {
      const { handlers, rows } = build({ crud, validation }, { bundle: writeNameOwnerBundle, atomicBatch })
      rows.set("r1", { id: "r1", tenantId: "tenant-1", name: "a", ownerId: "me", version: 1 })
      const res = await handlers.update(new Request("https://x/people/r1", { method: "PATCH", body: JSON.stringify({ name: "b", owner: "victim" }), headers: { "content-type": "application/json", "if-match": '"1"' } }), { params: Promise.resolve({ id: "r1" }) })
      expect(res.status).toBe(403)
      expect(rows.get("r1")?.ownerId).toBe("me")
    })
  }
})

describe("defect 4: list pagination parameters are bounded integers", () => {
  it.each(["1.5", "1e308", "Infinity", "0", "-1", "9007199254740993"])("rejects page=%s", (page) => {
    expect(defaultListQuerySchema.safeParse({ page }).success).toBe(false)
  })
  it("rejects fractional pageSize and accepts sane values", () => {
    expect(defaultListQuerySchema.safeParse({ pageSize: "2.5" }).success).toBe(false)
    expect(defaultListQuerySchema.parse({ page: "3", pageSize: "25" })).toMatchObject({ page: 3, pageSize: 25 })
  })
})

describe("defect 5: 503 responses carry Retry-After", () => {
  const handler = createFrameworkErrorHandler()
  it("sets a default Retry-After for unavailable and retryable persistence errors", () => {
    for (const error of [new UnavailableError(), new RetryablePersistenceError()]) {
      const res = handler(error)
      expect(res.status).toBe(503)
      expect(res.headers.get("Retry-After")).toBe("1")
    }
  })
})
