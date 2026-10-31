import pg from "pg"
import { afterAll, beforeAll, describe } from "vitest"
import { drizzle } from "drizzle-orm/node-postgres"
import { integer, pgSchema, text } from "drizzle-orm/pg-core"
import { createDrizzleRepository } from "@xonava/adapters/drizzle-pg"
import type { VersionedEntityDescriptor } from "@xonava/core/persistence"
import { pgCertificationUrl } from "./database.js"
import { defineDeleteOccSemantics, type OccItem, type OccRepository } from "../shared/deleteOccSemantics.js"

const SCHEMA = "df_delete_occ"
const items = pgSchema(SCHEMA).table("items", { id: text("id").primaryKey(), name: text("name").notNull(), version: integer("version").notNull() })
const entity: VersionedEntityDescriptor<OccItem> = { name: "items", primaryKey: "id", versionField: "version", fields: { id: { type: "string" }, name: { type: "string" }, version: { type: "number" } } }

describe("PostgreSQL delete with optimistic concurrency", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 4 })
  const repo = createDrizzleRepository<OccItem>({ db: drizzle(pool) as never, table: items as never, entity, columnMap: { id: items.id, name: items.name, version: items.version } as never }) as unknown as OccRepository
  beforeAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}; CREATE TABLE ${SCHEMA}.items (id text PRIMARY KEY, name text NOT NULL, version integer NOT NULL)`) })
  afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await pool.end() })
  defineDeleteOccSemantics({ label: "postgres", repo: () => repo, reset: async () => { await pool.query(`DELETE FROM ${SCHEMA}.items`) }, bump: async (id) => { await pool.query(`UPDATE ${SCHEMA}.items SET version = version + 1 WHERE id = $1`, [id]) } })
})
