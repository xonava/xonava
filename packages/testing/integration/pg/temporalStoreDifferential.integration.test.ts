import pg from "pg"
import { afterAll, beforeAll, describe } from "vitest"
import { DrizzlePgTemporalHistoryStore, postgresTemporalSchemaSql } from "@xonava/adapters/drizzle-pg"
import { pgCertificationUrl } from "./database.js"
import {
  defineConcurrentAppends, defineConcurrentLifecycle, defineSnapshotEquivalence, defineTemporalDifferential, type TemporalStoreDifferentialDriver,
} from "../shared/temporalStoreDifferential.js"
import type { Kind, State } from "../shared/temporalStoreDifferentialModel.js"

const SCHEMA = "df_temporal"

describe("PostgreSQL temporal store differential", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 12 })
  const json = (value: unknown): State | null => (value == null ? null : typeof value === "string" ? (JSON.parse(value) as State) : (value as State))
  const num = (value: unknown): number | null => (value == null ? null : Number(value))
  const driver: TemporalStoreDifferentialDriver = {
    label: "postgres",
    store: new DrizzlePgTemporalHistoryStore<State>(pool, SCHEMA),
    conflictErrors: true,
    maxWorkers: 10,
    reset: async () => { await pool.query(`TRUNCATE ${SCHEMA}.temporal_heads, ${SCHEMA}.temporal_revisions, ${SCHEMA}.temporal_snapshots`) },
    dump: async () => {
      const ms = "floor(extract(epoch from occurred_at)*1000)::bigint AS at"
      const heads = (await pool.query(`SELECT scope_id, entity_type, entity_id, revision, kind, ${ms} FROM ${SCHEMA}.temporal_heads`)).rows
      const revisions = (await pool.query(`SELECT scope_id, entity_type, entity_id, revision, kind, state, entity_version, event_id, audit_id, ${ms} FROM ${SCHEMA}.temporal_revisions`)).rows
      const snapshots = (await pool.query(`SELECT scope_id, entity_type, entity_id, revision, state, ${ms} FROM ${SCHEMA}.temporal_snapshots`)).rows
      const id = (r: Record<string, unknown>) => ({ scopeId: r.scope_id as string, entityType: r.entity_type as string, entityId: r.entity_id as string })
      return {
        heads: heads.map((r) => ({ ...id(r), revision: Number(r.revision), at: Number(r.at), kind: r.kind as Kind })),
        revisions: revisions.map((r) => ({ ...id(r), revision: Number(r.revision), at: Number(r.at), kind: r.kind as Kind, state: json(r.state), version: num(r.entity_version), eventId: (r.event_id as string | null) ?? null, auditId: (r.audit_id as string | null) ?? null })),
        snapshots: snapshots.map((r) => ({ ...id(r), revision: Number(r.revision), at: Number(r.at), state: json(r.state) })),
      }
    },
  }

  beforeAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}; ${postgresTemporalSchemaSql(SCHEMA)}`) })
  afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await pool.end() })

  defineTemporalDifferential(driver)
  defineSnapshotEquivalence(driver)
  defineConcurrentAppends(driver)
  defineConcurrentLifecycle(driver)
})
