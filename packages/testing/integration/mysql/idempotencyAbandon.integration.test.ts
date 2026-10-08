import { describe, it } from "vitest"
import type { VersionedEntityDescriptor } from "core/persistence"
import { createDrizzleMySqlIdempotencyStore, createDrizzleMySqlPersistenceProvider, DrizzleMySqlEntityRegistry } from "adapters/drizzle-mysql"
import { mysqlIdempotency, mysqlRecords } from "../../fixtures/mysql/schema.js"
import { openMySqlFixture } from "./database.js"
import { assertIdempotencyAbandonContract } from "../shared/idempotencyAbandon.js"

interface RecordRow { id: string; tenantId: string; name: string; version: number; value: unknown }
const entity: VersionedEntityDescriptor<RecordRow> = { name: "records", primaryKey: "id", versionField: "version", tenantField: "tenantId", fields: { id: { type: "string" }, tenantId: { type: "string" }, name: { type: "string" }, version: { type: "number" }, value: { type: "json" } } }

describe("MySQL idempotency abandon", () => {
  it("releases only an uncommitted reservation owned by the caller", async () => {
    const fixture = await openMySqlFixture()
    try {
      const registry = new DrizzleMySqlEntityRegistry().register(entity, mysqlRecords, { id: mysqlRecords.id, tenantId: mysqlRecords.tenantId, name: mysqlRecords.name, version: mysqlRecords.version, value: mysqlRecords.value })
      const provider = createDrizzleMySqlPersistenceProvider({ db: fixture.db, registry })
      const store = createDrizzleMySqlIdempotencyStore<unknown>(fixture.db, mysqlIdempotency)
      await assertIdempotencyAbandonContract(store as never, (lease) => provider.runInTransaction((transaction) => store.markCommittedInTransaction(lease, transaction)), `abandon-${Date.now()}`)
    } finally {
      await fixture.pool.end()
    }
  })
})
