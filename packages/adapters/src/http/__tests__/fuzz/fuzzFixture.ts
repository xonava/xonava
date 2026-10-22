import { z } from "zod"
import { defineEntity } from "@xonava/core/entity"
import { evaluatePredicate, type PredicateNode } from "@xonava/core/domain"
import type { PersistenceProvider } from "@xonava/core/persistence"
import type { CursorIntegrityPort } from "@xonava/core/query"
import type { IdempotencyAcquireResult, TransactionalIdempotencyPort } from "@xonava/core/events"
import { hmacSha256 } from "@xonava/core/serialization"
import { createCrudHandlersInternal } from "../../createCrudHandlers"
import type { SerializedResponse } from "../../idempotency"
import type { HttpCrudHandlers } from "../../frameworkAdapter"
import { allowAllAbacBundle, allowAllModuleFacts, canonicalRequestNormalization, trustedSession } from "../canonicalRequest"

export type FuzzRow = { id: string; tenantId: string; name: string; status: string; version: number }

/** Text an injected fault carries; it must never reach a response. */
export const FAULT_TEXT = "FAULT_SENTINEL_6f1c2a /srv/internal/secret-repository.ts:77:13 password=hunter2"

export type FaultOperation = "find" | "insert" | "update" | "delete"

export const MODULE_KEY = "http.people"
export const OWN_TENANT = "tenant-1"
export const FOREIGN_TENANT = "tenant-2"

const cursorKey = new TextEncoder().encode("fuzz-cursor-key")
export const cursorIntegrity: CursorIntegrityPort = {
  sign: async (payload) => hmacSha256(cursorKey, payload),
  verify: async (payload, signature) => {
    const expected = hmacSha256(cursorKey, payload)
    return expected.length === signature.length && expected.every((byte, index) => byte === signature[index])
  },
}

/** In-memory transactional idempotency port: enough state to drive acquire/replay/conflict/in-progress. */
export function memoryIdempotencyPort(): TransactionalIdempotencyPort<SerializedResponse> & { clear(): void } {
  type Record = { fingerprint: string; token: string; state: "in-progress" | "committed" | "complete"; result?: SerializedResponse; resource?: { entity: string; id: string; version?: number } }
  const records = new Map<string, Record>()
  const id = (scope: string, key: string) => `${scope}\u0000${key}`
  let counter = 0
  return {
    clear: () => records.clear(),
    acquire: async (request) => {
      const existing = records.get(id(request.scope, request.key))
      if (!existing) {
        const token = `token-${++counter}`
        records.set(id(request.scope, request.key), { fingerprint: request.fingerprint, token, state: "in-progress" })
        return { outcome: "acquired", token }
      }
      if (existing.fingerprint !== request.fingerprint) return { outcome: "conflict" }
      if (existing.state === "complete" && existing.result) return { outcome: "replay", result: existing.result }
      if (existing.state === "committed") return { outcome: "business-committed", token: existing.token, ...(existing.resource ? { resource: existing.resource } : {}) } as IdempotencyAcquireResult<SerializedResponse>
      return { outcome: "in-progress" }
    },
    renew: async () => undefined,
    markCommittedInTransaction: async (item) => {
      const existing = records.get(id(item.scope, item.key))
      if (existing) { existing.state = "committed"; if (item.resource) existing.resource = { ...item.resource } }
    },
    complete: async (completion) => {
      const existing = records.get(id(completion.scope, completion.key))
      if (existing) { existing.state = "complete"; existing.result = completion.result }
    },
    abandon: async (lease) => {
      const existing = records.get(id(lease.scope, lease.key))
      if (existing && existing.state === "in-progress" && existing.token === lease.token) records.delete(id(lease.scope, lease.key))
    },
  }
}

export interface FuzzFixture {
  handlers: HttpCrudHandlers
  rows: Map<string, FuzzRow>
  /** Counts every repository write call that reached the store (applied or not). */
  writes: { count: number }
  /** Arm a fault: the named repository operation throws {@link FAULT_TEXT} before touching state. */
  fault: { operation: FaultOperation | null }
  seed(): void
  /** Stable view of all rows, with server-generated ids replaced, for state comparison between transports. */
  snapshot(): string
}

export const SEED_ROWS: readonly FuzzRow[] = Object.freeze([
  { id: "row-1", tenantId: OWN_TENANT, name: "Ada", status: "active", version: 1 },
  { id: "row-2", tenantId: OWN_TENANT, name: "Grace", status: "active", version: 3 },
  { id: "row-3", tenantId: OWN_TENANT, name: "Edsger", status: "archived", version: 1 },
  { id: "foreign-1", tenantId: FOREIGN_TENANT, name: "FOREIGN_ROW_NAME_7e1", status: "active", version: 1 },
])

/**
 * A tenant-scoped people CRUD (cursor pagination, optimistic concurrency, optional idempotency) over an
 * in-memory store. Built with the same internal factory as `CRUD()` so the cursor strategy, which `CRUD()`
 * does not forward, is exercised too.
 */
export function createFuzzFixture(): FuzzFixture {
  const rows = new Map<string, FuzzRow>()
  const writes = { count: 0 }
  const fault: { operation: FaultOperation | null } = { operation: null }
  const idempotency = memoryIdempotencyPort()
  const select = (filter?: PredicateNode) => [...rows.values()].filter((row) => !filter || evaluatePredicate(row, filter))
  const guard = (operation: FaultOperation) => { if (fault.operation === operation) throw new Error(FAULT_TEXT) }
  const write = (operation: FaultOperation) => { guard(operation); writes.count++ }

  const compare = (a: unknown, b: unknown) => (a === b ? 0 : (a as string | number) < (b as string | number) ? -1 : 1)
  const repository = {
    findById: async (id: string) => { guard("find"); return rows.get(id) ?? null },
    findOneWhere: async (filter: PredicateNode) => { guard("find"); return select(filter)[0] ?? null },
    findMany: async (args: { filter?: PredicateNode; sort?: Array<{ field: string; direction: "asc" | "desc" }>; pagination?: { kind: string; page?: number; pageSize?: number; direction?: "after" | "before"; values?: unknown[]; limit?: number } }) => {
      guard("find")
      let matched = select(args.filter)
      const sort = args.sort ?? [{ field: "id", direction: "asc" as const }]
      const order = (a: FuzzRow, b: FuzzRow) => {
        for (const item of sort) {
          const result = compare((a as unknown as Record<string, unknown>)[item.field], (b as unknown as Record<string, unknown>)[item.field])
          if (result !== 0) return item.direction === "desc" ? -result : result
        }
        return 0
      }
      matched = matched.sort(order)
      const pagination = args.pagination
      if (pagination?.kind === "cursor") {
        const limit = pagination.limit ?? 10
        const values = pagination.values
        const before = pagination.direction === "before"
        const key = (row: FuzzRow) => sort.map((item) => (row as unknown as Record<string, unknown>)[item.field])
        const compareKeys = (row: FuzzRow) => {
          for (const [index, item] of sort.entries()) {
            const result = compare(key(row)[index], values?.[index])
            if (result !== 0) return item.direction === "desc" ? -result : result
          }
          return 0
        }
        const candidates = values ? matched.filter((row) => (before ? compareKeys(row) < 0 : compareKeys(row) > 0)) : matched
        const page = before ? candidates.slice(Math.max(0, candidates.length - limit)) : candidates.slice(0, limit)
        return {
          rows: page, rowCount: page.length, page: 1, pageSize: limit,
          pageInfo: { kind: "cursor" as const, hasNextPage: before ? true : candidates.length > limit, hasPreviousPage: before ? candidates.length > limit : values !== undefined },
        }
      }
      const pageSize = pagination?.pageSize ?? 10
      const page = pagination?.page ?? 1
      return { rows: matched.slice((page - 1) * pageSize, page * pageSize), rowCount: matched.length, page, pageSize }
    },
    insert: async (data: FuzzRow) => { write("insert"); rows.set(data.id, { ...data }); return { ...data } },
    update: async (id: string, patch: Partial<FuzzRow>) => {
      write("update")
      const current = rows.get(id)
      if (!current) throw new Error("missing row")
      const updated = { ...current, ...patch, version: current.version + 1 }
      rows.set(id, updated)
      return { ...updated }
    },
    delete: async (id: string) => { write("delete"); rows.delete(id) },
    updateOneWhereReturning: async (filter: PredicateNode, patch: Partial<FuzzRow>) => {
      write("update")
      const current = select(filter)[0]
      if (!current) return null
      const updated = { ...current, ...patch, version: current.version + 1 }
      rows.set(updated.id, updated)
      return { ...updated }
    },
    deleteWhere: async (filter: PredicateNode) => {
      write("delete")
      const matches = select(filter)
      for (const row of matches) rows.delete(row.id)
      return { deletedCount: matches.length }
    },
  }
  const persistence = {
    dialect: "test",
    capabilities: { interactiveTransactions: true, atomicBatch: false, returningInsert: true, readSessions: false, jsonQueries: false, exactDecimal: false, persistentConnection: false, maxPageSize: 100 },
    repository: () => repository,
    // A failed transaction rolls back, like a real database; writes outside one stay committed.
    runInTransaction: async (work: (provider: PersistenceProvider) => Promise<unknown>) => {
      const before = new Map(Array.from(rows, ([id, row]) => [id, { ...row }]))
      try {
        return await work(persistence)
      } catch (error) {
        rows.clear()
        for (const [id, row] of before) rows.set(id, row)
        throw error
      }
    },
  } as unknown as PersistenceProvider

  const createBody = z.object({ name: z.string().min(1).max(500), status: z.enum(["active", "archived"]).optional() })
  const updateBody = z.object({ name: z.string().min(1).max(500).optional(), status: z.enum(["active", "archived"]).optional() })
  const compiled = defineEntity<FuzzRow, z.infer<typeof createBody>, z.infer<typeof updateBody>>({
    moduleKey: MODULE_KEY,
    entity: { name: "person", primaryKey: "id", tenantField: "tenantId", versionField: "version", fields: { id: { type: "string" }, tenantId: { type: "string" }, name: { type: "string" }, status: { type: "string" }, version: { type: "number" } } },
    entityScope: { kind: "tenant" }, policy: { skipCapabilityCheck: true },
    cache: false, audit: false,
    searchableColumns: ["name"],
    filterableColumns: ["name", "status"],
    sortableColumns: ["id", "name", "status"],
    listDefaults: { sortColumn: "id" },
    queryLimits: { maxCount: 1000 },
    validation: {
      createBody,
      updateBody,
      idParams: z.object({ id: z.string().min(1).max(300) }),
    },
    optimisticConcurrency: { versionField: "version" },
  })
  const handlers = createCrudHandlersInternal({
    adapterDeps: {
      assertValidCsrf: () => undefined,
      resolveModuleAuthorizationFacts: allowAllModuleFacts,
      resolveAbacBundle: async ({ moduleKey }) => allowAllAbacBundle(moduleKey),
      createIdempotencyPort: <T>() => idempotency as unknown as import("@xonava/core/events").IdempotencyPort<T>,
    },
    requestNormalization: canonicalRequestNormalization(trustedSession({ kind: "tenant", tenantId: OWN_TENANT }), MODULE_KEY),
    scope: { scope: "tenant", idempotency: { required: false } },
    moduleKey: compiled.moduleKey,
    entity: compiled.entity,
    entityScope: compiled.entityScope,
    policy: compiled.policy,
    cache: { enabled: false, tag: compiled.entity.name, keyPrefix: compiled.entity.name },
    getCacheAdapter: async () => { throw new Error("cache is disabled") },
    createPersistence: () => persistence,
    runtimeCapabilities: { deferredExecution: false, cache: false },
    validation: compiled.validation,
    rateLimit: compiled.rateLimit,
    audit: { enabled: false, resource: compiled.entity.name },
    searchableColumns: [...compiled.compiledQuery.searchableFields],
    filterableColumns: [...compiled.compiledQuery.filterableFields],
    sortableColumns: [...compiled.compiledQuery.sortableFields],
    queryLimits: compiled.queryLimits!,
    listDefaults: compiled.listDefaults!,
    optimisticConcurrency: { versionField: "version" },
    pagination: { strategy: "cursor", integrity: cursorIntegrity, uniqueFields: ["id"] },
  })

  const seed = () => {
    rows.clear()
    idempotency.clear()
    writes.count = 0
    fault.operation = null
    for (const row of SEED_ROWS) rows.set(row.id, { ...row })
  }
  const seeded = new Set(SEED_ROWS.map((row) => row.id))
  const snapshot = () => JSON.stringify([...rows.values()].map((row) => (seeded.has(row.id) ? row : { ...row, id: "<generated>" })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
  seed()
  return { handlers: handlers as unknown as HttpCrudHandlers, rows, writes, fault, seed, snapshot }
}
