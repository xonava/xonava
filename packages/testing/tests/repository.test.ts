import { evaluatePredicate, OptimisticConcurrencyError, type PredicateNode } from "core/domain"
import { createTenantScopedPersistenceProvider } from "core/persistence"
import type { PersistenceProvider, EntityDescriptor, UnversionedRepository, DeleteOptions, UpdateWhereOptions } from "core/persistence"
import type { QueryOptions, ListResult } from "core/query"
import { runRepositoryContractTests } from "../src/repository-contracts"
import { runTenantAbacConformanceTests } from "../src/tenant-abac-contracts"

function createInMemoryPersistenceProvider(): PersistenceProvider {
  let nextId = 1
  const store = new Map<string, Record<string, unknown>>()

  function allRows<T>(): T[] {
    return Array.from(store.values()).map(r => ({ ...r } as T))
  }

  const provider: PersistenceProvider = {
    dialect: "memory",
    capabilities: {
      interactiveTransactions: false,
      atomicBatch: false,
      returningInsert: false,
      readSessions: false,
      jsonQueries: false,
      exactDecimal: false,
      persistentConnection: false,
    },
    repository<T, TId = string>(_entity: EntityDescriptor<T>): UnversionedRepository<T, TId> {
      const pk = (_entity.primaryKey ?? "id")

      return {
        async findById(id: TId): Promise<T | null> {
          const row = store.get(String(id))
          return row ? ({ ...row } as T) : null
        },

        async findOneWhere(filter: PredicateNode): Promise<T | null> {
          for (const row of store.values()) {
            if (evaluatePredicate(row, filter)) {
              return { ...row } as T
            }
          }
          return null
        },

        async findMany(options?: QueryOptions): Promise<ListResult<T>> {
          let all = allRows<T>()
          if (options?.filter) {
            all = all.filter(r => evaluatePredicate(r as Record<string, unknown>, options.filter!))
          }
          const total = all.length
          const offset = options?.pagination?.kind === "offset" ? options.pagination : undefined
          const page = offset?.page ?? 1
          const pageSize = offset?.pageSize ?? 100
          const paged = all.slice((page - 1) * pageSize, page * pageSize)
          return { rows: paged, rowCount: total, page, pageSize }
        },

        async insert(data: Partial<T>): Promise<T> {
          const id = String(nextId++)
          const row = { ...data, [pk]: id } as Record<string, unknown>
          store.set(id, row)
          return { ...row } as T
        },

        async update(id: TId, data: Partial<T>, options?: UpdateWhereOptions): Promise<T> {
          const key = String(id)
          const existing = store.get(key)
          if (!existing) throw new Error("Not found")
          if (Object.prototype.hasOwnProperty.call(data, "version")) throw new Error("version is framework-owned")
          if (options?.optimisticConcurrency && existing.version !== options.optimisticConcurrency.expectedVersion) {
            throw new OptimisticConcurrencyError("stale version")
          }
          const updated = { ...existing, ...data, ...(typeof existing.version === "number" ? { version: existing.version + 1 } : {}) }
          store.set(key, updated)
          return { ...updated } as T
        },

        async updateOneWhere(filter: PredicateNode, data: Partial<T>, options?: UpdateWhereOptions): Promise<{ updatedCount: number }> {
          if (Object.prototype.hasOwnProperty.call(data, "version")) throw new Error("version is framework-owned")
          for (const [key, row] of store.entries()) {
            if (evaluatePredicate(row, filter) && (!options?.optimisticConcurrency || row.version === options.optimisticConcurrency.expectedVersion)) {
              store.set(key, { ...row, ...data, ...(typeof row.version === "number" ? { version: row.version + 1 } : {}) })
              return { updatedCount: 1 }
            }
          }
          if (options?.optimisticConcurrency) throw new OptimisticConcurrencyError("stale version")
          return { updatedCount: 0 }
        },

        async updateOneWhereReturning(filter: PredicateNode, data: Partial<T>, options?: UpdateWhereOptions): Promise<T | null> {
          if (Object.prototype.hasOwnProperty.call(data, "version")) throw new Error("version is framework-owned")
          for (const [key, row] of store.entries()) {
            if (evaluatePredicate(row, filter) && (!options?.optimisticConcurrency || row.version === options.optimisticConcurrency.expectedVersion)) {
              const updated = { ...row, ...data, ...(typeof row.version === "number" ? { version: row.version + 1 } : {}) }
              store.set(key, updated)
              return { ...updated } as T
            }
          }
          if (options?.optimisticConcurrency) throw new OptimisticConcurrencyError("stale version")
          return null
        },

        async updateManyWhere(filter: PredicateNode, data: Partial<T>, options?: UpdateWhereOptions): Promise<number> {
          if (filter.kind === "and" && filter.filters.length === 0) throw new Error("all-row predicate rejected")
          if (Object.prototype.hasOwnProperty.call(data, "version")) throw new Error("version is framework-owned")
          let count = 0
          for (const [key, row] of store.entries()) {
            if (evaluatePredicate(row, filter) && (!options?.optimisticConcurrency || row.version === options.optimisticConcurrency.expectedVersion)) {
              store.set(key, { ...row, ...data, ...(typeof row.version === "number" ? { version: row.version + 1 } : {}) })
              count++
            }
          }
          if (options?.optimisticConcurrency && count === 0) throw new OptimisticConcurrencyError("stale version")
          return count
        },

        async delete(id: TId, _options?: DeleteOptions): Promise<void> {
          const row = store.get(String(id))
          const expected = _options?.optimisticConcurrency?.expectedVersion
          if (expected !== undefined && row?.version !== expected) throw new OptimisticConcurrencyError("stale version")
          store.delete(String(id))
        },

        async deleteWhere(filter: PredicateNode, _options?: DeleteOptions): Promise<{ deletedCount: number }> {
          if (filter.kind === "and" && filter.filters.length === 0) throw new Error("all-row predicate rejected")
          let count = 0
          for (const [key, row] of store.entries()) {
            if (evaluatePredicate(row, filter)) {
              store.delete(key)
              count++
            }
          }
          return { deletedCount: count }
        },
      }
    },
  }
  return provider
}

runRepositoryContractTests("in-memory", createInMemoryPersistenceProvider)

runTenantAbacConformanceTests("in-memory", {
  createProvider: createInMemoryPersistenceProvider,
  createTenantProvider: (provider, tenantId) => createTenantScopedPersistenceProvider(provider, tenantId),
})
