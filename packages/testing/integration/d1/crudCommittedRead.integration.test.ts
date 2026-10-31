import { afterAll, beforeAll } from "vitest"
import { drizzle } from "drizzle-orm/d1"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { createDrizzlePersistenceProvider, DrizzleEntityRegistry } from "@xonava/adapters/drizzle-d1"
import { crudCommittedReadPlatformDescriptor, crudCommittedReadTenantDescriptor, defineCrudCommittedReadSuite } from "../shared/crudCommittedRead.js"
import { openD1Fixture, type D1Fixture } from "./database.js"

const tenantItems = sqliteTable("ccr_tenant_items", { id: text("id").primaryKey(), tenantId: text("tenant_id").notNull(), name: text("name").notNull(), version: integer("version").notNull() })
const platformItems = sqliteTable("ccr_platform_items", { id: text("id").primaryKey(), name: text("name").notNull(), version: integer("version").notNull() })

// D1 applies a conditional update as an atomic batch and fences it with this assertion table.
const assertions = sqliteTable("ccr_assertions", { expectedAffectedRows: integer("expected_affected_rows"), actualAffectedRows: integer("actual_affected_rows") })

let fixture: D1Fixture
let provider: ReturnType<typeof createDrizzlePersistenceProvider>

beforeAll(async () => {
  fixture = await openD1Fixture()
  await fixture.db.exec("CREATE TABLE ccr_tenant_items (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL)")
  await fixture.db.exec("CREATE TABLE ccr_platform_items (id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL)")
  await fixture.db.exec("CREATE TABLE ccr_assertions (expected_affected_rows INTEGER, actual_affected_rows INTEGER, CHECK (expected_affected_rows IS NULL OR expected_affected_rows = actual_affected_rows))")
  const registry = new DrizzleEntityRegistry()
    .register(crudCommittedReadTenantDescriptor, tenantItems, { id: tenantItems.id, tenantId: tenantItems.tenantId, name: tenantItems.name, version: tenantItems.version })
    .register(crudCommittedReadPlatformDescriptor, platformItems, { id: platformItems.id, name: platformItems.name, version: platformItems.version })
  provider = createDrizzlePersistenceProvider({ db: drizzle(fixture.db as never), registry, mutationAssertionTable: assertions } as never)
})
afterAll(async () => { await fixture.close() })

defineCrudCommittedReadSuite("D1", { provider: () => provider })
