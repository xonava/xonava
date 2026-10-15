import { describe, expect, it } from "vitest"
import type { VersionedEntityDescriptor } from "@xonava/core/persistence"
import { createOperationContext, runOperation } from "@xonava/core/operation"
import { PersistenceError } from "@xonava/core/domain"
import { createDrizzleMySqlPersistenceProvider, DrizzleMySqlEntityRegistry } from "@xonava/adapters/drizzle-mysql"
import { mysqlRecords } from "../../fixtures/mysql/schema.js"
import { openMySqlFixture } from "./database.js"

interface RecordRow { id: string; tenantId: string; name: string; version: number; value: unknown }
const entity: VersionedEntityDescriptor<RecordRow> = { name: "records", primaryKey: "id", versionField: "version", tenantField: "tenantId", fields: { id: { type: "string" }, tenantId: { type: "string" }, name: { type: "string" }, version: { type: "number" }, value: { type: "json" } } }

describe("MYSQL1 transaction outcome classification", () => {
  it("runs read operations in read-only transactions (previously rejected by the adapter)", async () => {
    const fixture = await openMySqlFixture()
    try {
      const registry = new DrizzleMySqlEntityRegistry().register(entity, mysqlRecords, { id: mysqlRecords.id, tenantId: mysqlRecords.tenantId, name: mysqlRecords.name, version: mysqlRecords.version, value: mysqlRecords.value })
      const provider = createDrizzleMySqlPersistenceProvider({ db: fixture.db, registry })
      const result = await runOperation({
        operation: createOperationContext({ persistence: provider, runtimeCapabilities: {} as never }),
        definition: { key: "read-records", kind: "read", atomicity: { kind: "standard", mode: "required" }, execute: async ({ operation }) => (await operation.persistence.repository(entity).findMany({})).rows.length },
        input: {},
      })
      expect(result).toBe(0)
      // A write inside a read-only transaction is refused by the server and normalized, never leaked raw.
      await expect(provider.runInTransaction(async (tx) => tx.repository(entity).insert({ id: "x", tenantId: "t", name: "n", value: {} }), { accessMode: "read only" })).rejects.toBeInstanceOf(PersistenceError)
    } finally {
      await fixture.pool.end()
    }
  }, 30_000)
})
