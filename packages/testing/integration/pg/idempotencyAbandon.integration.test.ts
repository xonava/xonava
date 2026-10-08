import pg from "pg"
import { describe, it } from "vitest"
import { drizzle } from "drizzle-orm/node-postgres"
import { jsonb, pgSchema, text, timestamp } from "drizzle-orm/pg-core"
import { createDrizzlePgIdempotencyStore } from "adapters/drizzle-pg"
import { pgCertificationUrl } from "./database.js"
import { assertIdempotencyAbandonContract } from "../shared/idempotencyAbandon.js"

const schemaName = `idem_abandon_${process.pid}`
const table = pgSchema(schemaName).table("idempotency", {
  id: text("id").notNull(), scope: text("scope").notNull(), key: text("key").notNull(), fingerprint: text("fingerprint").notNull(),
  token: text("token").notNull(), status: text("status").notNull(), result: jsonb("result"), resourceEntity: text("resource_entity"),
  resourceId: text("resource_id"), resourceVersion: text("resource_version"), pendingInvalidations: jsonb("pending_invalidations"),
  finalizerClaimOwner: text("finalizer_claim_owner"), finalizerClaimToken: text("finalizer_claim_token"),
  finalizerClaimExpiresAt: timestamp("finalizer_claim_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(), completedAt: timestamp("completed_at", { withTimezone: true }),
})

describe("PostgreSQL idempotency abandon", () => {
  it("releases only an uncommitted reservation owned by the caller", async () => {
    const pool = new pg.Pool({ connectionString: pgCertificationUrl() })
    try {
      await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`)
      await pool.query(`CREATE TABLE ${schemaName}.idempotency (id text NOT NULL, scope text NOT NULL, key text NOT NULL, fingerprint text NOT NULL, token text NOT NULL, status text NOT NULL, result jsonb, resource_entity text, resource_id text, resource_version text, pending_invalidations jsonb, finalizer_claim_owner text, finalizer_claim_token text, finalizer_claim_expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, PRIMARY KEY (scope, key))`)
      const store = createDrizzlePgIdempotencyStore<unknown>(drizzle(pool) as never, table as never)
      // The receipt state a committed business transaction leaves behind.
      const markCommitted = async (lease: { scope: string; key: string; token: string }) => {
        await pool.query(`UPDATE ${schemaName}.idempotency SET status='business-committed' WHERE scope=$1 AND key=$2 AND token=$3`, [lease.scope, lease.key, lease.token])
      }
      await assertIdempotencyAbandonContract(store as never, markCommitted, "pg")
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
      await pool.end()
    }
  })
})
