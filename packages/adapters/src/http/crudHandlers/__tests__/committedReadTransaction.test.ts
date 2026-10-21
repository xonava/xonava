import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { defineEntity } from "@xonava/core/entity"
import { evaluatePredicate, type PredicateNode } from "@xonava/core/domain"
import type { PersistenceProvider } from "@xonava/core/persistence"
import { CRUD } from "../../crud"
import { allowAllAbacBundle, allowAllModuleFacts, canonicalRequestNormalization, trustedSession } from "../../__tests__/canonicalRequest"

type Row = { id: string; tenantId?: string; name: string; version: number }
type TenantRow = { id: string; tenantId: string; name: string; version: number }
type PlatformRow = { id: string; name: string; version: number }

/**
 * A provider that behaves like PostgreSQL/MySQL: a write is visible only to
 * the transaction that made it until that transaction commits. Reads through
 * the root provider (any other connection) see committed rows only. Fakes that
 * ignore this masked a bug where the create/update response was read through a
 * fresh connection before commit.
 */
function isolatedProvider(seed: Row[] = []) {
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
  const root = {
    dialect: "test",
    capabilities,
    repository: () => repositoryOver(() => committed, row => { committed.set(row.id, row) }),
    runInTransaction: async (work: (provider: PersistenceProvider) => Promise<unknown>) => {
      const pending = new Map<string, Row>()
      const view = () => new Map([...committed, ...pending])
      const tx = { dialect: "test", capabilities, repository: () => repositoryOver(view, row => { pending.set(row.id, row) }) } as unknown as PersistenceProvider
      const result = await work(tx)
      for (const [id, row] of pending) committed.set(id, row)
      return result
    },
  } as unknown as PersistenceProvider
  return { root, committed }
}

function handlersFor(kind: "tenant" | "platform", provider: PersistenceProvider) {
  const session = kind === "tenant" ? trustedSession({ kind: "tenant", tenantId: "tenant-1" }) : trustedSession({ kind: "platform", platformKey: "test" })
  const moduleKey = `isolated.${kind}`
  const runtime = {
    adapterDeps: { assertValidCsrf: () => undefined, resolveModuleAuthorizationFacts: allowAllModuleFacts, resolveAbacBundle: async ({ moduleKey: key }: { moduleKey: string }) => allowAllAbacBundle(key) },
    requestNormalization: canonicalRequestNormalization(session, moduleKey),
    scope: { scope: kind, idempotency: { required: false } } as const,
    createPersistence: () => provider,
    getCacheAdapter: vi.fn(),
  }
  const validation = { createBody: z.object({ name: z.string() }), updateBody: z.object({ name: z.string() }), idParams: z.object({ id: z.string() }) }
  const fields = { id: { type: "string" }, name: { type: "string" }, version: { type: "number" } } as const
  return kind === "tenant"
    ? CRUD(defineEntity<TenantRow, { name: string }, { name: string }>({
        moduleKey, entity: { name: "isolatedTenant", primaryKey: "id", tenantField: "tenantId", versionField: "version", fields: { ...fields, tenantId: { type: "string" } } },
        entityScope: { kind: "tenant" }, policy: { skipCapabilityCheck: true }, cache: false, audit: false, validation,
      }), runtime as never)
    : CRUD(defineEntity<PlatformRow, { name: string }, { name: string }>({
        moduleKey, entity: { name: "isolatedPlatform", primaryKey: "id", versionField: "version", fields },
        entityScope: { kind: "platform", acknowledged: true }, policy: { skipCapabilityCheck: true }, cache: false, audit: false, validation,
      }), runtime as never)
}

const request = (method: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://example.test/items", { method, body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } })

describe("built-in CRUD reads the written row inside the writing transaction", () => {
  for (const kind of ["tenant", "platform"] as const) {
    it(`create returns the row for a ${kind}-scoped entity when only the transaction sees the uncommitted insert`, async () => {
      const { root, committed } = isolatedProvider()
      const response = await handlersFor(kind, root).create(request("POST", { name: "created" }))
      const body = await response.json() as Record<string, unknown>
      expect(response.status).toBe(201)
      expect(body).toMatchObject({ name: "created", version: 1 })
      expect(body).not.toHaveProperty("reason")
      expect(committed.get(body.id as string)).toMatchObject({ name: "created" })
    })

    it(`update returns the row for a ${kind}-scoped entity when only the transaction sees the uncommitted update`, async () => {
      const { root } = isolatedProvider([{ id: "r1", ...(kind === "tenant" ? { tenantId: "tenant-1" } : {}), name: "before", version: 1 }])
      const response = await handlersFor(kind, root).update(request("PATCH", { name: "after" }, { "if-match": '"1"' }), { params: Promise.resolve({ id: "r1" }) })
      const body = await response.json() as Record<string, unknown>
      expect(response.status).toBe(200)
      expect(body).toMatchObject({ id: "r1", name: "after", version: 2 })
      expect(body).not.toHaveProperty("reason")
    })
  }
})
