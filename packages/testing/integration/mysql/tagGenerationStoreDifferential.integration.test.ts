import mysql from "mysql2/promise"
import type { Pool, RowDataPacket } from "mysql2/promise"
import { afterAll, beforeAll, describe } from "vitest"
import { createMySqlTagGenerationStore } from "@xonava/adapters/drizzle-mysql"
import { readMySqlMigrationStatements } from "../../fixtures/mysql/bootstrap.js"
import { mysqlCertificationUrl } from "./database.js"
import {
  defineConcurrentInvalidation, defineKvConcurrentInvalidation, defineKvGenerationDifferential, defineTagGenerationDifferential, defineTagGenerationRegressions,
  type TagGenerationStoreDifferentialDriver,
} from "../shared/tagGenerationStoreDifferential.js"

const DATABASE = "framework_df_tag_generation"

// The shipped cache_generations DDL: the table of 0001_framework.sql with 0006_byte_exact_identifiers.sql, created in an isolated database.
async function generationsDdl(): Promise<string[]> {
  const statements = [...await readMySqlMigrationStatements("0001_framework.sql"), ...await readMySqlMigrationStatements("0006_byte_exact_identifiers.sql")]
  return statements.filter((statement) => /^(?:CREATE TABLE IF NOT EXISTS|ALTER TABLE) cache_generations\b/.test(statement))
}

function databaseUrl(): string {
  const url = new URL(mysqlCertificationUrl())
  url.pathname = `/${DATABASE}`
  return url.toString()
}

describe("MySQL tag generation store differential", () => {
  // The pool connects lazily; the database is created in beforeAll before the first query.
  const pool: Pool = mysql.createPool({ uri: databaseUrl(), connectionLimit: 12 })
  const driver: TagGenerationStoreDifferentialDriver = {
    label: "mysql",
    store: createMySqlTagGenerationStore(pool),
    maxWorkers: 10,
    // First advances of one tag waiting behind each other may deadlock (ER_LOCK_DEADLOCK 1213); InnoDB aborts one victim, which changed nothing.
    retryable: (error) => ((error as { cause?: { errno?: number } }).cause?.errno ?? (error as { errno?: number }).errno) === 1213,
    reset: async () => { await pool.query("DELETE FROM cache_generations") },
    dump: async () => ((await pool.query<RowDataPacket[]>("SELECT `scope`, generation FROM cache_generations"))[0] as Record<string, unknown>[]).map((r) => ({ tag: r.scope as string, generation: Number(r.generation) })),
    seed: async (tag, generation) => { await pool.query("INSERT INTO cache_generations(`scope`,generation) VALUES(?,?)", [tag, generation]) },
  }

  beforeAll(async () => {
    const admin = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``)
    await admin.query(`CREATE DATABASE \`${DATABASE}\``)
    await admin.end()
    for (const statement of await generationsDdl()) await pool.query(statement)
  })
  afterAll(async () => {
    await pool.end()
    const admin = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``)
    await admin.end()
  })

  defineTagGenerationRegressions(driver)
  defineTagGenerationDifferential(driver)
  defineConcurrentInvalidation(driver)
  defineKvGenerationDifferential("mysql")
  defineKvConcurrentInvalidation("mysql")
})
