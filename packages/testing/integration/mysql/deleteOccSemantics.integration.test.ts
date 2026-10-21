import mysql from "mysql2/promise"
import { drizzle } from "drizzle-orm/mysql2"
import { int, mysqlTable, varchar } from "drizzle-orm/mysql-core"
import { afterAll, beforeAll, describe } from "vitest"
import { createDrizzleMySqlRepository } from "@xonava/adapters/drizzle-mysql"
import type { VersionedEntityDescriptor } from "@xonava/core/persistence"
import { mysqlCertificationUrl } from "./database.js"
import { defineDeleteOccSemantics, type OccItem, type OccRepository } from "../shared/deleteOccSemantics.js"

const DATABASE = "framework_df_delete_occ"
const items = mysqlTable("items", { id: varchar("id", { length: 100 }).primaryKey(), name: varchar("name", { length: 100 }).notNull(), version: int("version").notNull() })
const entity: VersionedEntityDescriptor<OccItem> = { name: "items", primaryKey: "id", versionField: "version", fields: { id: { type: "string" }, name: { type: "string" }, version: { type: "number" } } }

function databaseUrl(): string {
  const url = new URL(mysqlCertificationUrl())
  url.pathname = `/${DATABASE}`
  return url.toString()
}

describe("MySQL delete with optimistic concurrency", () => {
  const pool = mysql.createPool({ uri: databaseUrl(), connectionLimit: 4 })
  const repo = createDrizzleMySqlRepository<OccItem>({ db: drizzle(pool) as never, table: items, entity, columnMap: { id: items.id, name: items.name, version: items.version } as never }) as unknown as OccRepository
  beforeAll(async () => {
    const admin = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``)
    await admin.query(`CREATE DATABASE \`${DATABASE}\``)
    await admin.end()
    await pool.query("CREATE TABLE items (id VARCHAR(100) PRIMARY KEY, name VARCHAR(100) NOT NULL, version INT NOT NULL) ENGINE=InnoDB")
  })
  afterAll(async () => {
    await pool.end()
    const admin = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``)
    await admin.end()
  })
  defineDeleteOccSemantics({ label: "mysql", repo: () => repo, reset: async () => { await pool.query("DELETE FROM items") }, bump: async (id) => { await pool.query("UPDATE items SET version = version + 1 WHERE id = ?", [id]) } })
})
