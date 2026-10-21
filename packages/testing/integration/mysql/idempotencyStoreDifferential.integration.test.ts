import mysql from "mysql2/promise"
import type { Pool, RowDataPacket } from "mysql2/promise"
import { drizzle } from "drizzle-orm/mysql2"
import { afterAll, beforeAll, describe } from "vitest"
import { createDrizzleMySqlIdempotencyStore, createDrizzleMySqlPersistenceProvider, DrizzleMySqlEntityRegistry } from "@xonava/adapters/drizzle-mysql"
import { mysqlIdempotency } from "../../fixtures/mysql/schema.js"
import { mysqlCertificationUrl } from "./database.js"
import { defineConcurrentAcquireRaces, defineConcurrentFinalizerClaims, defineConcurrentOwnershipRaces } from "../shared/idempotencyStoreDifferentialConcurrency.js"
import { canonicalJson } from "../shared/idempotencyStoreDifferentialModel.js"
import { defineIdempotencyDifferential, defineIdempotencyRegressions, printCoverage, type IdempotencyDifferentialDriver, type RawIdempotencyRow } from "../shared/idempotencyStoreDifferential.js"

const DATABASE = "framework_df_idempotency"
// The fixture table of 0001_framework.sql in an isolated database. scope and key use a binary collation: identities are
// case-sensitive, and the fixture's default case-insensitive collation makes `K` replay `k` (reported as a finding).
const DDL = `CREATE TABLE idempotency (
  id VARCHAR(100) NOT NULL, \`scope\` VARCHAR(255) COLLATE utf8mb4_bin NOT NULL, \`key\` VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
  fingerprint VARCHAR(128) NOT NULL, token VARCHAR(100) NOT NULL, status VARCHAR(30) NOT NULL,
  result JSON NULL, resource_entity VARCHAR(255) NULL, resource_id VARCHAR(255) NULL,
  resource_version VARCHAR(100) NULL, pending_invalidations JSON NULL,
  finalizer_claim_owner VARCHAR(100) NULL, finalizer_claim_token VARCHAR(100) NULL,
  finalizer_claim_expires_at DATETIME(3) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL, PRIMARY KEY (\`scope\`,\`key\`), UNIQUE KEY idempotency_id_uq(id)
) ENGINE=InnoDB`

function databaseUrl(): string {
  const url = new URL(mysqlCertificationUrl())
  url.pathname = `/${DATABASE}`
  return url.toString()
}

/** mysql2 parses JSON columns: a string holds a JSON string scalar (the adapter stores invalidations as JSON text). */
function canonicalOf(raw: unknown, textIsDocument: boolean): string | null {
  if (raw === null || raw === undefined) return null
  if (textIsDocument && typeof raw === "string") { try { return canonicalJson(JSON.parse(raw)) } catch { return canonicalJson(raw) } }
  return canonicalJson(raw)
}

describe("MySQL idempotency store differential", () => {
  // The pool connects lazily; the database is created in beforeAll before the first query.
  const pool: Pool = mysql.createPool({ uri: databaseUrl(), connectionLimit: 16 })
  const db = drizzle(pool)
  const provider = createDrizzleMySqlPersistenceProvider({ db: db as never, registry: new DrizzleMySqlEntityRegistry() })
  const store = createDrizzleMySqlIdempotencyStore<unknown>(db as never, mysqlIdempotency)
  const q = async (sql: string, params: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, params))[0] as Record<string, unknown>[]
  const driver: IdempotencyDifferentialDriver = {
    label: "mysql",
    store,
    commit: (item) => provider.runInTransaction((transaction) => store.markCommittedInTransaction(item, transaction)),
    reset: async () => { await pool.query("DELETE FROM idempotency") },
    expireLease: async (scope, key) => { await pool.query("UPDATE idempotency SET created_at = CURRENT_TIMESTAMP(3) - INTERVAL 2 HOUR WHERE `scope` = ? AND `key` = ?", [scope, key]) },
    expireClaim: async (scope, key) => { await pool.query("UPDATE idempotency SET finalizer_claim_expires_at = CURRENT_TIMESTAMP(3) - INTERVAL 1 HOUR WHERE `scope` = ? AND `key` = ? AND finalizer_claim_token IS NOT NULL", [scope, key]) },
    corruptInvalidations: async (scope, key) => { await pool.query("UPDATE idempotency SET pending_invalidations = CAST('\"not json\"' AS JSON) WHERE `scope` = ? AND `key` = ?", [scope, key]) },
    dump: async (): Promise<RawIdempotencyRow[]> => (await q("SELECT *, JSON_TYPE(result) AS result_type FROM idempotency")).map((r) => ({
      scope: r.scope as string, key: r.key as string, fingerprint: r.fingerprint as string, token: r.token as string, status: r.status as string,
      result: r.result_type === "NULL" ? "null" : canonicalOf(r.result, false), resourceEntity: r.resource_entity as string | null, resourceId: r.resource_id as string | null,
      resourceVersion: r.resource_version === null ? null : (JSON.parse(r.resource_version as string) as { value: number }).value,
      pendingInvalidations: canonicalOf(r.pending_invalidations, true), finalizerClaimOwner: r.finalizer_claim_owner as string | null,
      finalizerClaimToken: r.finalizer_claim_token as string | null, hasClaimExpiry: r.finalizer_claim_expires_at !== null, hasCompletedAt: r.completed_at !== null,
    })),
  }

  beforeAll(async () => {
    const admin = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``)
    await admin.query(`CREATE DATABASE \`${DATABASE}\``)
    await admin.end()
    await pool.query(DDL)
  })
  afterAll(async () => {
    printCoverage("mysql")
    await pool.end()
    const admin = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``)
    await admin.end()
  })

  defineIdempotencyRegressions(driver)
  defineIdempotencyDifferential(driver)
  defineConcurrentAcquireRaces(driver)
  defineConcurrentOwnershipRaces(driver)
  defineConcurrentFinalizerClaims(driver)
})
