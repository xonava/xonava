import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { defineEntity } from "@xonava/core/entity"
import { evaluatePredicate, type PredicateNode } from "@xonava/core/domain"
import type { PersistenceProvider } from "@xonava/core/persistence"
import { CRUD } from "../../crud"
import { allowAllAbacBundle, allowAllModuleFacts, canonicalRequestNormalization, trustedSession } from "../../__tests__/canonicalRequest"

type Row = { id: string; tenantId: string; name: string; version: number }
type Command = { kind: string; values?: Record<string, unknown>; filter?: PredicateNode }

const descriptor = { name: "pcrPersistenceItem", primaryKey: "id", tenantField: "tenantId", versionField: "version", fields: { id: { type: "string" }, tenantId: { type: "string" }, name: { type: "string" }, version: { type: "number" } } } as const

/**
 * Interactive provider with PostgreSQL/MySQL visibility: a write is visible
 * only to the transaction that made it until commit. Counts transactions so a
 * test can tell which persistence a hook was handed.
 */
function interactiveProvider(seed: Row[] = []) {
  const committed = new Map<string, Row>(seed.map(row => [row.id, { ...row }]))
  const repositoryOver = (visible: () => Map<string, Row>, write: (row: Row) => void) => {
    const select = (filter?: PredicateNode) => [...visible().values()].filter(row => !filter || evaluatePredicate(row, filter))
    return {
      findById: async (id: string) => visible().get(id) ?? null,
      findOneWhere: async (filter: PredicateNode) => select(filter)[0] ?? null,
      findMany: async ({ filter }: { filter?: PredicateNode }) => ({ rows: select(filter), rowCount: select(filter).length, page: 1, pageSize: 20 }),
      insert: async (data: Row) => { write({ ...data }); return { ...data } },
      updateOneWhereReturning: async (filter: PredicateNode, patch: Partial<Row>) => {
        const current = select(filter)[0]
        if (!current) return null
        const updated = { ...current, ...patch, version: current.version + 1 }
        write(updated)
        return { ...updated }
      },
    }
  }
  const capabilities = { interactiveTransactions: true, atomicBatch: false, returningInsert: true, readSessions: false, jsonQueries: false, exactDecimal: false, persistentConnection: false, maxPageSize: 100 }
  const state = { transactionRepositoryCalls: 0, freshRepositoryCalls: 0 }
  const root = {
    dialect: "test",
    capabilities,
    repository: () => { state.freshRepositoryCalls++; return repositoryOver(() => committed, row => { committed.set(row.id, row) }) },
    runInTransaction: async (work: (provider: PersistenceProvider) => Promise<unknown>) => {
      const pending = new Map<string, Row>()
      const view = () => new Map([...committed, ...pending])
      const tx = { dialect: "test", capabilities, repository: () => { state.transactionRepositoryCalls++; return repositoryOver(view, row => { pending.set(row.id, row) }) } } as unknown as PersistenceProvider
      const result = await work(tx)
      for (const [id, row] of pending) committed.set(id, row)
      return result
    },
  } as unknown as PersistenceProvider
  return { root, committed, state }
}

/** Atomic-batch provider (D1-like): no interactive transaction, the batch is applied before `after` runs. */
function atomicBatchProvider(seed: Row[] = []) {
  const rows = new Map<string, Row>(seed.map(row => [row.id, { ...row }]))
  const select = (filter?: PredicateNode) => [...rows.values()].filter(row => !filter || evaluatePredicate(row, filter))
  const state = { freshRepositoryCalls: 0 }
  const repository = {
    findById: async (id: string) => rows.get(id) ?? null,
    findOneWhere: async (filter: PredicateNode) => select(filter)[0] ?? null,
    findMany: async ({ filter }: { filter?: PredicateNode }) => ({ rows: select(filter), rowCount: select(filter).length, page: 1, pageSize: 20 }),
  }
  const encoder = (tenantId: string) => ({ tenantId, encode: (command: Command) => command })
  const root = {
    dialect: "test-d1",
    capabilities: { interactiveTransactions: false, atomicBatch: true, atomicBatchScope: "tenant-scoped", maxPageSize: 100, maxBindParams: 100, maxStatementBytes: 100_000 },
    tenantId: "tenant-1",
    commandEncoder: encoder("tenant-1"),
    createTenantScopedCommandEncoder: encoder,
    repository: () => { state.freshRepositoryCalls++; return repository },
    executeAtomicBatch: async (plan: { items: readonly { kind: string; command?: Command }[] }) => plan.items.map((item) => {
      const command = item.command
      if (item.kind !== "command" || !command) return { kind: item.kind, result: { ok: true } }
      if (command.kind === "insert") { rows.set(String(command.values!.id), command.values as Row); return { kind: "command", result: { meta: { changes: 1 } } } }
      const targets = select(command.filter)
      for (const target of targets) rows.set(target.id, { ...target, ...command.values, version: target.version + 1 })
      return { kind: "command", result: { meta: { changes: targets.length } } }
    }),
  } as unknown as PersistenceProvider
  return { root, rows, state }
}

type HookContext = { persistence: { repository: (entity: typeof descriptor) => Record<string, unknown> & { findById: (id: string) => Promise<Row | null> } } }

function setup(provider: PersistenceProvider) {
  const seen: { derived?: string; hasInsert?: boolean; hasUpdate?: boolean; hasDelete?: boolean; afterCommitResult?: Record<string, unknown> } = {}
  const projectCommittedResult = async ({ result, context }: { result: Row; context: HookContext }) => {
    const repository = context.persistence.repository(descriptor)
    const reread = await repository.findById(result.id)
    seen.hasInsert = typeof repository.insert === "function"
    seen.hasUpdate = typeof repository.updateOneWhereReturning === "function" || typeof repository.update === "function"
    seen.hasDelete = typeof repository.deleteWhere === "function" || typeof repository.delete === "function"
    seen.derived = `seen:${reread?.name ?? "missing"}`
    return { ...result, derived: seen.derived } as unknown as Row
  }
  const afterCommit = async ({ result }: { result: Record<string, unknown> }) => { seen.afterCommitResult = result }
  const session = trustedSession({ kind: "tenant", tenantId: "tenant-1" })
  const entity = defineEntity<Row, { name: string }, { name: string }>({
    moduleKey: "pcr.persistence",
    entity: { ...descriptor, fields: { ...descriptor.fields, derived: { type: "string" } } } as never,
    entityScope: { kind: "tenant" }, policy: { skipCapabilityCheck: true }, cache: false, audit: false,
    validation: { createBody: z.object({ name: z.string() }), updateBody: z.object({ name: z.string() }), idParams: z.object({ id: z.string() }) },
    crud: { create: { projectCommittedResult, afterCommit }, update: { projectCommittedResult, afterCommit } },
  } as never)
  const handlers = CRUD(entity, {
    adapterDeps: { assertValidCsrf: () => undefined, resolveModuleAuthorizationFacts: allowAllModuleFacts, resolveAbacBundle: async ({ moduleKey }: { moduleKey: string }) => allowAllAbacBundle(moduleKey) },
    requestNormalization: canonicalRequestNormalization(session, "pcr.persistence"),
    scope: { scope: "tenant", idempotency: { required: false } },
    createPersistence: () => provider,
    getCacheAdapter: vi.fn(),
  } as never)
  return { handlers, seen }
}

const request = (method: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://example.test/items", { method, body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } })

describe("projectCommittedResult persistence", () => {
  it("create hook reads through the writing transaction on an interactive provider and cannot write", async () => {
    const { root, state } = interactiveProvider()
    const { handlers, seen } = setup(root)
    const response = await handlers.create(request("POST", { name: "created" }))
    const body = await response.json() as Record<string, unknown>
    expect(response.status).toBe(201)
    // The fresh connection cannot see the uncommitted insert, so seeing the row proves the hook read through the transaction.
    expect(seen.derived).toBe("seen:created")
    expect(body).toMatchObject({ name: "created", derived: "seen:created" })
    expect(state.transactionRepositoryCalls).toBeGreaterThan(0)
    expect(seen.hasInsert).toBe(false)
    expect(seen.hasUpdate).toBe(false)
    expect(seen.hasDelete).toBe(false)
    expect(body).not.toHaveProperty("hookPersistence")
    if (seen.afterCommitResult) expect(seen.afterCommitResult).not.toHaveProperty("hookPersistence")
  })

  it("update hook reads through the writing transaction on an interactive provider and cannot write", async () => {
    const { root } = interactiveProvider([{ id: "r1", tenantId: "tenant-1", name: "before", version: 1 }])
    const { handlers, seen } = setup(root)
    const response = await handlers.update(request("PATCH", { name: "after" }, { "if-match": '"1"' }), { params: Promise.resolve({ id: "r1" }) })
    const body = await response.json() as Record<string, unknown>
    expect(response.status).toBe(200)
    expect(seen.derived).toBe("seen:after")
    expect(body).toMatchObject({ id: "r1", name: "after", version: 2, derived: "seen:after" })
    expect(seen.hasInsert).toBe(false)
    expect(seen.hasUpdate).toBe(false)
    expect(seen.hasDelete).toBe(false)
    expect(body).not.toHaveProperty("hookPersistence")
    if (seen.afterCommitResult) expect(seen.afterCommitResult).not.toHaveProperty("hookPersistence")
  })

  it("create hook gets a fresh read-only persistence on an atomic-batch provider", async () => {
    const { root, rows, state } = atomicBatchProvider()
    const { handlers, seen } = setup(root)
    const response = await handlers.create(request("POST", { name: "created" }))
    const body = await response.json() as Record<string, unknown>
    expect(response.status).toBe(201)
    expect(rows.size).toBe(1)
    expect(state.freshRepositoryCalls).toBeGreaterThan(0)
    expect(seen.derived).toBe("seen:created")
    expect(body).toMatchObject({ name: "created", derived: "seen:created" })
    expect(seen.hasInsert).toBe(false)
    expect(seen.hasUpdate).toBe(false)
    expect(seen.hasDelete).toBe(false)
    expect(body).not.toHaveProperty("hookPersistence")
  })

  it("update hook gets a fresh read-only persistence on an atomic-batch provider", async () => {
    const { root, state } = atomicBatchProvider([{ id: "r1", tenantId: "tenant-1", name: "before", version: 1 }])
    const { handlers, seen } = setup(root)
    const response = await handlers.update(request("PATCH", { name: "after" }, { "if-match": '"1"' }), { params: Promise.resolve({ id: "r1" }) })
    const body = await response.json() as Record<string, unknown>
    expect(response.status).toBe(200)
    expect(state.freshRepositoryCalls).toBeGreaterThan(0)
    expect(seen.derived).toBe("seen:after")
    expect(body).toMatchObject({ id: "r1", name: "after", derived: "seen:after" })
    expect(seen.hasInsert).toBe(false)
    expect(body).not.toHaveProperty("hookPersistence")
  })
})
