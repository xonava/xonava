import { bigint, mysqlTable, varchar } from "drizzle-orm/mysql-core"
import { afterAll, beforeAll } from "vitest"
import mysql from "mysql2/promise"
import { drizzle } from "drizzle-orm/mysql2"
import { createDrizzleMySqlPersistenceProvider, DrizzleMySqlEntityRegistry, type MySqlDatabaseLike } from "@xonava/adapters/drizzle-mysql"
import { crudCommittedReadPlatformDescriptor, crudCommittedReadTenantDescriptor, defineCrudCommittedReadSuite } from "../shared/crudCommittedRead.js"
import { mysqlCertificationUrl } from "./database.js"

const tenantItems = mysqlTable("ccr_tenant_items", { id: varchar("id", { length: 100 }).primaryKey(), tenantId: varchar("tenant_id", { length: 100 }).notNull(), name: varchar("name", { length: 255 }).notNull(), version: bigint("version", { mode: "number" }).notNull() })
const platformItems = mysqlTable("ccr_platform_items", { id: varchar("id", { length: 100 }).primaryKey(), name: varchar("name", { length: 255 }).notNull(), version: bigint("version", { mode: "number" }).notNull() })

const pool = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 6 })
const registry = new DrizzleMySqlEntityRegistry()
  .register(crudCommittedReadTenantDescriptor, tenantItems, { id: tenantItems.id, tenantId: tenantItems.tenantId, name: tenantItems.name, version: tenantItems.version })
  .register(crudCommittedReadPlatformDescriptor, platformItems, { id: platformItems.id, name: platformItems.name, version: platformItems.version })
const provider = createDrizzleMySqlPersistenceProvider({ db: drizzle(pool) as unknown as MySqlDatabaseLike, registry })

beforeAll(async () => {
  await pool.query("DROP TABLE IF EXISTS ccr_tenant_items")
  await pool.query("DROP TABLE IF EXISTS ccr_platform_items")
  await pool.query("CREATE TABLE ccr_tenant_items (id VARCHAR(100) PRIMARY KEY, tenant_id VARCHAR(100) NOT NULL, name VARCHAR(255) NOT NULL, version BIGINT NOT NULL) ENGINE=InnoDB")
  await pool.query("CREATE TABLE ccr_platform_items (id VARCHAR(100) PRIMARY KEY, name VARCHAR(255) NOT NULL, version BIGINT NOT NULL) ENGINE=InnoDB")
})
afterAll(async () => {
  await pool.query("DROP TABLE IF EXISTS ccr_tenant_items")
  await pool.query("DROP TABLE IF EXISTS ccr_platform_items")
  await pool.end()
})

defineCrudCommittedReadSuite("MySQL", { provider: () => provider })
