import { vi } from "vitest"
import { z } from "zod"
import { defineEntity } from "@xonava/core/entity"
import { evaluatePredicate, type PredicateNode } from "@xonava/core/domain"
import type { PersistenceProvider } from "@xonava/core/persistence"
import { CRUD } from "../crud"
import { allowAllAbacBundle, allowAllModuleFacts, canonicalRequestNormalization, trustedSession } from "./canonicalRequest"

type Row = { id: string; tenantId: string; name: string; version: number }

export function httpCrudFixture(options: { deny?: boolean; disabled?: boolean; protectedFields?: readonly string[] } = {}) {
  const rows = new Map<string, Row>()
  const select = (filter?: PredicateNode) => [...rows.values()].filter(row => !filter || evaluatePredicate(row, filter))
  const repository = {
    findById: vi.fn(async (id: string) => rows.get(id) ?? null),
    findOneWhere: vi.fn(async (filter: PredicateNode) => select(filter)[0] ?? null),
    findMany: vi.fn(async ({ filter }: { filter?: PredicateNode }) => ({ rows: select(filter), rowCount: select(filter).length, page: 1, pageSize: 20 })),
    insert: vi.fn(async (data: Row) => { rows.set(data.id, { ...data }); return { ...data } }),
    update: vi.fn(async (id: string, patch: Partial<Row>) => { const current = rows.get(id); if (!current) throw new Error("missing row"); const updated = { ...current, ...patch, version: current.version + 1 }; rows.set(id, updated); return { ...updated } }),
    delete: vi.fn(async (id: string) => { rows.delete(id) }),
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
    dialect: 'test',
    capabilities: { interactiveTransactions: true, atomicBatch: false, returningInsert: true, readSessions: false, jsonQueries: false, exactDecimal: false, persistentConnection: false, maxPageSize: 100 },
    repository: () => repository,
    runInTransaction: async (work: (provider: PersistenceProvider) => Promise<unknown>) => work(persistence),
  } as PersistenceProvider
  const entity = defineEntity<Row, { name: string }, { name: string }>({
    moduleKey: 'http.people',
    entity: { name: 'person', primaryKey: 'id', tenantField: 'tenantId', versionField: 'version', fields: { id: { type: 'string' }, tenantId: { type: 'string' }, name: { type: 'string' }, version: { type: 'number' } } },
    entityScope: { kind: 'tenant' }, policy: { skipCapabilityCheck: true },
    cache: false, audit: false,
    validation: { createBody: z.object({ name: z.string() }), updateBody: z.object({ name: z.string() }), idParams: z.object({ id: z.string() }) },
    ...(options.disabled ? { routes: { list: false, detail: false, create: false, update: false, delete: false } } : {}),
  })
  const handlers = CRUD(entity, {
    adapterDeps: { assertValidCsrf: () => undefined, resolveModuleAuthorizationFacts: allowAllModuleFacts, resolveAbacBundle: async ({ moduleKey }) => options.deny ? null : allowAllAbacBundle(moduleKey) },
    requestNormalization: canonicalRequestNormalization(trustedSession({ kind: 'tenant', tenantId: 'tenant-1' }), 'http.people'),
    scope: { scope: 'tenant', idempotency: { required: false } },
    createPersistence: () => persistence,
    getCacheAdapter: vi.fn(),
    ...(options.protectedFields ? { update: { protectedFields: options.protectedFields } } : {}),
  })
  return { handlers, repository, rows }
}
