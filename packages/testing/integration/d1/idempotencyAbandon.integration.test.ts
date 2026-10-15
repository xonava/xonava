import { describe, it } from "vitest"
import { drizzle } from "drizzle-orm/d1"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { createDrizzleD1IdempotencyStore } from "@xonava/adapters/drizzle-d1"
import { temporaryD1Fixture } from "./database.js"
import { assertIdempotencyAbandonContract } from "../shared/idempotencyAbandon.js"

const table = sqliteTable("idem_abandon", {
  id: text("id").notNull(), scope: text("scope").notNull(), key: text("key").notNull(), fingerprint: text("fingerprint").notNull(),
  token: text("token").notNull(), status: text("status").notNull(), result: text("result"), resourceEntity: text("resource_entity"),
  resourceId: text("resource_id"), resourceVersion: text("resource_version"), pendingInvalidations: text("pending_invalidations"),
  finalizerClaimOwner: text("finalizer_claim_owner"), finalizerClaimToken: text("finalizer_claim_token"),
  finalizerClaimExpiresAt: integer("finalizer_claim_expires_at"), createdAt: integer("created_at").notNull(), completedAt: integer("completed_at"),
})

describe("D1 idempotency abandon", () => {
  it("releases only an uncommitted reservation owned by the caller", async () => {
    const fixture = await temporaryD1Fixture()
    try {
      await fixture.db.exec("CREATE TABLE idem_abandon (id TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, token TEXT NOT NULL, status TEXT NOT NULL, result TEXT, resource_entity TEXT, resource_id TEXT, resource_version TEXT, pending_invalidations TEXT, finalizer_claim_owner TEXT, finalizer_claim_token TEXT, finalizer_claim_expires_at INTEGER, created_at INTEGER NOT NULL, completed_at INTEGER, PRIMARY KEY (scope, key))")
      const store = createDrizzleD1IdempotencyStore<unknown>(drizzle(fixture.db as never) as never, table as never)
      const markCommitted = async (lease: { scope: string; key: string; token: string }) => {
        await fixture.db.prepare("UPDATE idem_abandon SET status='business-committed' WHERE scope=? AND key=? AND token=?").bind(lease.scope, lease.key, lease.token).run()
      }
      await assertIdempotencyAbandonContract(store as never, markCommitted, "d1")
    } finally {
      await fixture.close()
      await fixture.cleanup()
    }
  })
})
