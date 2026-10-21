import mysql from "mysql2/promise"
import type { Pool, RowDataPacket } from "mysql2/promise"
import { afterAll, beforeAll, describe } from "vitest"
import { DrizzleMySqlTemporalHistoryStore, mysqlTemporalSchemaSql } from "@xonava/adapters/drizzle-mysql"
import { mysqlCertificationUrl } from "./database.js"
import {
  defineConcurrentAppends, defineConcurrentLifecycle, defineSnapshotEquivalence, defineTemporalDifferential, type TemporalStoreDifferentialDriver,
} from "../shared/temporalStoreDifferential.js"
import type { Kind, State } from "../shared/temporalStoreDifferentialModel.js"

const DATABASE = "framework_df_temporal"

function databaseUrl(): string {
  const url = new URL(mysqlCertificationUrl())
  url.pathname = `/${DATABASE}`
  return url.toString()
}

describe("MySQL temporal store differential", () => {
  // The pool connects lazily; the database is created in beforeAll before the first query. The schema is the adapter's
  // exported DDL (scope_id utf8mb4_0900_bin with a stored generated scope_hash primary key), created in this isolated database.
  const pool: Pool = mysql.createPool({ uri: databaseUrl(), connectionLimit: 12, multipleStatements: true })
  const rows = async (sql: string): Promise<Record<string, unknown>[]> => (await pool.query<RowDataPacket[]>(sql))[0] as Record<string, unknown>[]
  const json = (value: unknown): State | null => (value == null ? null : typeof value === "string" ? (JSON.parse(value) as State) : (value as State))
  const num = (value: unknown): number | null => (value == null ? null : Number(value))
  const at = (value: unknown): number => new Date(value as string | Date).getTime()
  const id = (r: Record<string, unknown>) => ({ scopeId: r.scope_id as string, entityType: r.entity_type as string, entityId: r.entity_id as string })
  const driver: TemporalStoreDifferentialDriver = {
    label: "mysql",
    store: new DrizzleMySqlTemporalHistoryStore<State>(pool),
    conflictErrors: true,
    maxWorkers: 10,
    // Racing first creations (INSERT IGNORE gap locks) can deadlock (ER_LOCK_DEADLOCK 1213); InnoDB aborts one victim, which rolled back as a whole.
    retryable: (error) => (error as { errno?: number }).errno === 1213,
    reset: async () => { for (const table of ["temporal_snapshots", "temporal_revisions", "temporal_heads"]) await pool.query(`DELETE FROM ${table}`) },
    dump: async () => ({
      heads: (await rows("SELECT scope_id, entity_type, entity_id, revision, occurred_at, kind FROM temporal_heads")).map((r) => ({ ...id(r), revision: Number(r.revision), at: at(r.occurred_at), kind: r.kind as Kind })),
      revisions: (await rows("SELECT scope_id, entity_type, entity_id, revision, occurred_at, kind, state, entity_version, event_id, audit_id FROM temporal_revisions")).map((r) => ({ ...id(r), revision: Number(r.revision), at: at(r.occurred_at), kind: r.kind as Kind, state: json(r.state), version: num(r.entity_version), eventId: (r.event_id as string | null) ?? null, auditId: (r.audit_id as string | null) ?? null })),
      snapshots: (await rows("SELECT scope_id, entity_type, entity_id, revision, occurred_at, state FROM temporal_snapshots")).map((r) => ({ ...id(r), revision: Number(r.revision), at: at(r.occurred_at), state: json(r.state) })),
    }),
  }

  beforeAll(async () => {
    const admin = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``)
    await admin.query(`CREATE DATABASE \`${DATABASE}\``)
    await admin.end()
    await pool.query(mysqlTemporalSchemaSql())
  })
  afterAll(async () => {
    await pool.end()
    const admin = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``)
    await admin.end()
  })

  defineTemporalDifferential(driver)
  defineSnapshotEquivalence(driver)
  defineConcurrentAppends(driver)
  defineConcurrentLifecycle(driver)
})
