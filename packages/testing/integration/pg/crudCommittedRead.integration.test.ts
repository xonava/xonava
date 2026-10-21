import pg from "pg"
import { afterAll, beforeAll } from "vitest"
import { drizzle } from "drizzle-orm/node-postgres"
import { integer, pgSchema, text } from "drizzle-orm/pg-core"
import { createDrizzlePersistenceProvider } from "@xonava/adapters/drizzle-pg"
import { defineCrudCommittedReadSuite, CRUD_COMMITTED_READ_PLATFORM_ENTITY, CRUD_COMMITTED_READ_TENANT_ENTITY } from "../shared/crudCommittedRead.js"
import { pgCertificationUrl } from "./database.js"

const SCHEMA = "crud_committed_read_it"
const schema = pgSchema(SCHEMA)
const tenantItems = schema.table("tenant_items", { id: text("id").primaryKey(), tenantId: text("tenant_id").notNull(), name: text("name").notNull(), version: integer("version").notNull() })
const platformItems = schema.table("platform_items", { id: text("id").primaryKey(), name: text("name").notNull(), version: integer("version").notNull() })
const registry = {
  get: (name: string) => name === CRUD_COMMITTED_READ_TENANT_ENTITY
    ? { table: tenantItems, columnMap: { id: tenantItems.id, tenantId: tenantItems.tenantId, name: tenantItems.name, version: tenantItems.version } }
    : name === CRUD_COMMITTED_READ_PLATFORM_ENTITY
      ? { table: platformItems, columnMap: { id: platformItems.id, name: platformItems.name, version: platformItems.version } }
      : undefined,
}

const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 6 })
const provider = createDrizzlePersistenceProvider({ db: drizzle(pool), registry: registry as never })

beforeAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}; CREATE TABLE ${SCHEMA}.tenant_items(id text primary key, tenant_id text not null, name text not null, version int not null); CREATE TABLE ${SCHEMA}.platform_items(id text primary key, name text not null, version int not null)`)
})
afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await pool.end() })

defineCrudCommittedReadSuite("PostgreSQL", { provider: () => provider })
