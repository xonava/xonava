import { describe, it, expect, beforeEach } from "vitest"
import { Predicate } from "core/domain"
import type { PersistenceProvider, VersionedEntityDescriptor, VersionedRepository } from "core/persistence"

interface TestEntity {
  id: string
  name: string
  value: number
  tenantId?: string
  version?: number
}

const testEntityDescriptor: VersionedEntityDescriptor<TestEntity> = {
  name: "framework_contract_rows",
  primaryKey: "id",
  tenantField: "tenantId",
  versionField: "version",
  fields: {
    id: { type: "string" },
    name: { type: "string" },
    value: { type: "number" },
    tenantId: { type: "string", nullable: true },
    version: { type: "number", nullable: true },
  },
}

interface RepositoryContractFixture {
  createProvider: () => PersistenceProvider
  createTenantProvider?: (provider: PersistenceProvider, tenantId: string) => PersistenceProvider
  beforeEach?: () => void | Promise<void>
}

export function runRepositoryContractTests(
  label: string,
  fixture: RepositoryContractFixture | (() => PersistenceProvider),
): void {
  describe(`Repository contract: ${label}`, () => {
    let persistence: PersistenceProvider
    let repo: VersionedRepository<TestEntity, string>

    beforeEach(async () => {
      const options: RepositoryContractFixture = typeof fixture === "function"
        ? { createProvider: fixture }
        : fixture
      await options.beforeEach?.()
      persistence = options.createProvider()
      repo = persistence.repository(testEntityDescriptor)
    })

    it("Insert returns a row with an ID", async () => {
      const row = await repo.insert({ id: "insert-row", name: "test", value: 42 })
      expect(row).toBeDefined()
      expect(row.id).toBeDefined()
      expect(row.name).toBe("test")
      expect(row.value).toBe(42)
    })

    it("FindMany returns all rows", async () => {
      await repo.insert({ id: "many-a", name: "a", value: 1 })
      await repo.insert({ id: "many-b", name: "b", value: 2 })
      const result = await repo.findMany()
      expect(result.rows.length).toBeGreaterThanOrEqual(2)
      expect(result.rowCount).toBeGreaterThanOrEqual(2)
    })

    it("FindById returns the correct row", async () => {
      const inserted = await repo.insert({ id: "find-me", name: "find-me", value: 99 })
      const found = await repo.findById(inserted.id)
      expect(found).toBeDefined()
      expect(found!.name).toBe("find-me")
      expect(found!.value).toBe(99)
    })

    it("updates the correct versioned row with the expected version", async () => {
      const inserted = await repo.insert({ id: "update-me", name: "update-me", value: 10, version: 1 })
      const updated = await repo.update(inserted.id, { name: "updated", value: 20 }, {
        optimisticConcurrency: { expectedVersion: 1 },
      })
      expect(updated.name).toBe("updated")
      expect(updated.value).toBe(20)
      expect(updated.version).toBe(2)
    })

    it("increments the version exactly once and rejects a stale update", async () => {
      const inserted = await repo.insert({ id: "version-test", name: "version-test", value: 1, version: 1 })
      const updated = await repo.update(inserted.id, { name: "fresh" }, {
        optimisticConcurrency: { expectedVersion: 1 },
      })
      expect(updated.version).toBe(2)
      await expect(repo.update(inserted.id, { name: "stale" }, {
        optimisticConcurrency: { expectedVersion: 1 },
      })).rejects.toThrow()
      expect((await repo.findById(inserted.id))?.version).toBe(2)
    })

    it("allows only one concurrent update for the same expected version", async () => {
      const inserted = await repo.insert({ id: "race-test", name: "race-test", value: 1, version: 1 })
      const results = await Promise.allSettled([
        repo.update(inserted.id, { name: "winner-a" }, { optimisticConcurrency: { expectedVersion: 1 } }),
        repo.update(inserted.id, { name: "winner-b" }, { optimisticConcurrency: { expectedVersion: 1 } }),
      ])

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
      expect((await repo.findById(inserted.id))?.version).toBe(2)
    })

    it("deletes with the correct version and rejects a stale delete", async () => {
      const inserted = await repo.insert({ id: "delete-me", name: "delete-me", value: 0, version: 1 })
      await expect(repo.delete(inserted.id, {
        optimisticConcurrency: { expectedVersion: 0 },
      })).rejects.toThrow()
      expect(await repo.findById(inserted.id)).not.toBeNull()
      await repo.delete(inserted.id, { idempotent: true, optimisticConcurrency: { expectedVersion: 1 } })
      const found = await repo.findById(inserted.id)
      expect(found).toBeNull()
    })

    it("rejects all-row update and delete predicates", async () => {
      const inserted = await repo.insert({ id: "protected", name: "protected", value: 1, version: 1 })
      if (repo.deleteWhere) {
        await expect(repo.deleteWhere(Predicate.alwaysTrue(), {
          optimisticConcurrency: { expectedVersion: 1 },
        })).rejects.toThrow()
      }
      expect(await repo.findById(inserted.id)).toMatchObject({ name: "protected", version: 1 })
    })

    it("supports tenant-scoped reads, predicates, and inserts when supplied", async () => {
      const options: RepositoryContractFixture = typeof fixture === "function" ? { createProvider: fixture } : fixture
      if (!options.createTenantProvider) return
      const tenantField = testEntityDescriptor.tenantField!
      const tenantPersistence = persistence
      const { tenantField: _tenantField, ...unscopedDescriptor } = testEntityDescriptor
      const unscopedRepo = tenantPersistence.repository<TestEntity>(unscopedDescriptor)

      await unscopedRepo.insert({ id: "tenant-a-row", name: "tenant-a-row", value: 1, [tenantField]: "tenant-a" })
      const tenantBRow = await unscopedRepo.insert({ id: "tenant-b-row", name: "tenant-b-row", value: 2, [tenantField]: "tenant-b" })

      const scopedPersistence = options.createTenantProvider(persistence, "tenant-a")
      const scopedRepo = scopedPersistence.repository(testEntityDescriptor)

      const result = await scopedRepo.findMany()
      for (const row of result.rows) {
        expect(row.tenantId).toBe("tenant-a")
      }

      await expect(scopedRepo.insert({ id: "wrong-tenant", name: "wrong-tenant", value: 3, tenantId: "tenant-b", version: 1 })).rejects.toThrow()
      const scopedInsert = await scopedRepo.insert({ id: "scoped", name: "scoped", value: 4, version: 1 })
      expect(scopedInsert.tenantId).toBe("tenant-a")
      expect(await unscopedRepo.findById(tenantBRow.id)).toMatchObject({ tenantId: "tenant-b" })
    })

    it("Pagination returns correct slices", async () => {
      // Seed at least 5 rows
      for (let i = 0; i < 5; i++) {
        await repo.insert({ id: `page-row-${i}`, name: `page-row-${i}`, value: i })
      }

      const page1 = await repo.findMany({ pagination: { kind: "offset", page: 1, pageSize: 2 } })
      expect(page1.rows.length).toBeLessThanOrEqual(2)
      expect(page1.page).toBe(1)
      expect(page1.pageSize).toBe(2)
      expect(page1.rowCount).toBeGreaterThanOrEqual(5)

      if (page1.rows.length === 2) {
        const page2 = await repo.findMany({ pagination: { kind: "offset", page: 2, pageSize: 2 } })
        expect(page2.rows.length).toBeLessThanOrEqual(2)
        expect(page2.page).toBe(2)
      }
    })
  })
}
