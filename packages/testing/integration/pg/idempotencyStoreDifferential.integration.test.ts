import pg from "pg"
import { afterAll, beforeAll, describe } from "vitest"
import { drizzle } from "drizzle-orm/node-postgres"
import { pgSchema, text, timestamp } from "drizzle-orm/pg-core"
import { createDrizzlePersistenceProvider, createDrizzlePgIdempotencyStore } from "@xonava/adapters/drizzle-pg"
import { pgCertificationUrl } from "./database.js"
import { defineConcurrentAcquireRaces, defineConcurrentFinalizerClaims, defineConcurrentOwnershipRaces } from "../shared/idempotencyStoreDifferentialConcurrency.js"
import { canonicalJson } from "../shared/idempotencyStoreDifferentialModel.js"
import { defineIdempotencyDifferential, defineIdempotencyRegressions, printCoverage, type IdempotencyDifferentialDriver, type RawIdempotencyRow } from "../shared/idempotencyStoreDifferential.js"

const SCHEMA = "df_idempotency"
const table = pgSchema(SCHEMA).table("idempotency", {
  id: text("id").notNull(), scope: text("scope").notNull(), key: text("key").notNull(), fingerprint: text("fingerprint").notNull(),
  token: text("token").notNull(), status: text("status").notNull(), result: text("result"), resourceEntity: text("resource_entity"),
  resourceId: text("resource_id"), resourceVersion: text("resource_version"), pendingInvalidations: text("pending_invalidations"),
  finalizerClaimOwner: text("finalizer_claim_owner"), finalizerClaimToken: text("finalizer_claim_token"),
  finalizerClaimExpiresAt: timestamp("finalizer_claim_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(), completedAt: timestamp("completed_at", { withTimezone: true }),
})

const DDL = `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};
CREATE TABLE ${SCHEMA}.idempotency (id text NOT NULL, scope text NOT NULL, key text NOT NULL, fingerprint text NOT NULL, token text NOT NULL, status text NOT NULL, result text, resource_entity text, resource_id text, resource_version text, pending_invalidations text, finalizer_claim_owner text, finalizer_claim_token text, finalizer_claim_expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, PRIMARY KEY (scope, key));`

/** The adapter stores JSON text in text columns, so a string holds the logical JSON document. */
function canonicalOf(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== "string") return canonicalJson(raw)
  try { return canonicalJson(JSON.parse(raw)) } catch { return canonicalJson(raw) }
}

describe("PostgreSQL idempotency store differential", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 12 })
  const db = drizzle(pool)
  const store = createDrizzlePgIdempotencyStore<unknown>(db as never, table as never)
  const provider = createDrizzlePersistenceProvider({ db, registry: { get: () => undefined } as never })
  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as Record<string, unknown>[]
  const driver: IdempotencyDifferentialDriver = {
    label: "postgres",
    store,
    commit: (item) => provider.runInTransaction((transaction) => store.markCommittedInTransaction(item, transaction)),
    reset: async () => { await pool.query(`TRUNCATE ${SCHEMA}.idempotency`) },
    expireLease: async (scope, key) => { await pool.query(`UPDATE ${SCHEMA}.idempotency SET created_at = now() - interval '2 hours' WHERE scope = $1 AND key = $2`, [scope, key]) },
    expireClaim: async (scope, key) => { await pool.query(`UPDATE ${SCHEMA}.idempotency SET finalizer_claim_expires_at = now() - interval '1 hour' WHERE scope = $1 AND key = $2 AND finalizer_claim_token IS NOT NULL`, [scope, key]) },
    corruptInvalidations: async (scope, key) => { await pool.query(`UPDATE ${SCHEMA}.idempotency SET pending_invalidations = 'not json' WHERE scope = $1 AND key = $2`, [scope, key]) },
    dump: async (): Promise<RawIdempotencyRow[]> => (await q(`SELECT * FROM ${SCHEMA}.idempotency`)).map((r) => ({
      scope: r.scope as string, key: r.key as string, fingerprint: r.fingerprint as string, token: r.token as string, status: r.status as string,
      result: canonicalOf(r.result), resourceEntity: r.resource_entity as string | null, resourceId: r.resource_id as string | null,
      resourceVersion: r.resource_version === null ? null : (JSON.parse(r.resource_version as string) as { value: number }).value,
      pendingInvalidations: canonicalOf(r.pending_invalidations), finalizerClaimOwner: r.finalizer_claim_owner as string | null,
      finalizerClaimToken: r.finalizer_claim_token as string | null, hasClaimExpiry: r.finalizer_claim_expires_at !== null, hasCompletedAt: r.completed_at !== null,
    })),
  }

  beforeAll(async () => { await pool.query(DDL) })
  afterAll(async () => { printCoverage("pg"); await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await pool.end() })

  defineIdempotencyRegressions(driver)
  defineIdempotencyDifferential(driver)
  defineConcurrentAcquireRaces(driver)
  defineConcurrentOwnershipRaces(driver)
  defineConcurrentFinalizerClaims(driver)
})
