import { describe, expect, it } from "vitest"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ConflictError } from "@xonava/core/domain"
import { drizzle } from "drizzle-orm/d1"
import { createDrizzleD1Adapter, createDrizzleD1IdempotencyStore } from "@xonava/adapters/drizzle-d1"
import { setup } from "./sqliteFixture"

const records = sqliteTable("idem_full", {
  id: text("id").primaryKey(), scope: text("scope").notNull(), key: text("key").notNull(), fingerprint: text("fingerprint").notNull(), token: text("token").notNull(), status: text("status").notNull(), result: text("result"),
  resourceEntity: text("resource_entity"), resourceId: text("resource_id"), resourceVersion: text("resource_version"), pendingInvalidations: text("pending_invalidations"),
  finalizerClaimOwner: text("finalizer_claim_owner"), finalizerClaimToken: text("finalizer_claim_token"), finalizerClaimExpiresAt: integer("finalizer_claim_expires_at"), createdAt: integer("created_at").notNull(), completedAt: integer("completed_at"),
})
const SCHEMA = ["CREATE TABLE idem_full (id TEXT PRIMARY KEY, scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, token TEXT NOT NULL, status TEXT NOT NULL, result TEXT, resource_entity TEXT, resource_id TEXT, resource_version TEXT, pending_invalidations TEXT, finalizer_claim_owner TEXT, finalizer_claim_token TEXT, finalizer_claim_expires_at INTEGER, created_at INTEGER NOT NULL, completed_at INTEGER, UNIQUE (scope, key))"]

const request = { scope: "tenant:t1", key: "k1", fingerprint: "fp", leaseDurationMs: 30_000 }
const lease = { scope: "tenant:t1", key: "k1", fingerprint: "fp", token: "tok" }

async function build() {
  const fixture = await setup({ extraSchema: SCHEMA })
  const store = createDrizzleD1IdempotencyStore<{ ok: number }>(createDrizzleD1Adapter(drizzle(fixture.d1 as never) as never).repository, records)
  const state = () => fixture.row("SELECT status, token, result, pending_invalidations AS invalidations, finalizer_claim_token AS claim FROM idem_full") as Record<string, unknown>
  return { ...fixture, store, state }
}

describe("D1 idempotency store on a real SQLite engine", () => {
  it("reserves a key once and reports in-progress to a second caller", async () => {
    const { store, state, count } = await build()
    const first = await store.acquire(request)
    expect(first.outcome).toBe("acquired")
    expect(state()).toMatchObject({ status: "in-progress", token: (first as { token: string }).token })
    expect(await store.acquire(request)).toEqual({ outcome: "in-progress" })
    expect(await store.acquire({ ...request, fingerprint: "other" })).toEqual({ outcome: "conflict" })
    expect(count("idem_full")).toBe(1)
    await expect(store.acquire({ ...request, leaseDurationMs: 0 })).rejects.toThrow("lease duration")
  })

  it("takes over a reservation whose lease expired and leaves live ones alone", async () => {
    const { store, state, d1 } = await build()
    const first = (await store.acquire(request)) as { token: string }
    d1.sqlite.exec("UPDATE idem_full SET created_at = 1")
    const taken = await store.acquire(request)
    expect(taken.outcome).toBe("acquired")
    expect((taken as { token: string }).token).not.toBe(first.token)
    expect(state().token).toBe((taken as { token: string }).token)
    expect(await store.acquire(request)).toEqual({ outcome: "in-progress" })
  })

  it("renews and abandons only the owner's in-progress reservation", async () => {
    const { store, d1, count } = await build()
    const { token } = (await store.acquire(request)) as { token: string }
    d1.sqlite.exec("UPDATE idem_full SET created_at = 1")
    await store.renew({ ...lease, token, leaseDurationMs: 1_000 })
    expect(Number((d1.sqlite.prepare("SELECT created_at AS c FROM idem_full").get() as { c: number }).c)).toBeGreaterThan(1_000_000)
    await expect(store.renew({ ...lease, token: "stale" })).rejects.toBeInstanceOf(ConflictError)
    await expect(store.renew({ ...lease, token, leaseDurationMs: -1 })).rejects.toThrow("lease duration")
    await store.abandon!({ ...lease, token: "stale" })
    expect(count("idem_full")).toBe(1)
    await store.abandon!({ ...lease, token })
    expect(count("idem_full")).toBe(0)
  })

  it("builds a commit batch item with de-duplicated invalidations and optional resource", async () => {
    const { store } = await build()
    expect(store.createCommitBatchItem({ ...lease, resource: { entity: "Order", id: "o1", version: 2 }, invalidations: ["a", "a", "b"] } as never)).toEqual({
      kind: "idempotency", commit: { ...lease, resource: { entity: "Order", id: "o1", version: 2 }, invalidations: ["a", "b"] },
    })
    expect(store.createCommitBatchItem({ ...lease, invalidations: [] } as never)).toEqual({ kind: "idempotency", commit: lease })
  })

  it("replays completed results and exposes business-committed receipts", async () => {
    const { store, state, d1 } = await build()
    d1.sqlite.exec(`INSERT INTO idem_full (id, scope, key, fingerprint, token, status, created_at, resource_entity, resource_id, resource_version, pending_invalidations) VALUES ('i1','tenant:t1','k1','fp','tok','business-committed',100,'Order','o1','{"type":"number","value":5}','["x","x","y"]')`)
    expect(await store.acquire(request)).toEqual({ outcome: "business-committed", token: "tok", resource: { entity: "Order", id: "o1", version: 5 }, invalidations: ["x", "y"] })
    await store.complete({ ...lease, result: { ok: 9 } })
    expect(state()).toMatchObject({ status: "completed", result: '{"ok":9}', invalidations: null })
    expect(await store.acquire(request)).toEqual({ outcome: "replay", result: { ok: 9 } })
    await expect(store.complete({ ...lease, result: { ok: 9 } })).rejects.toBeInstanceOf(ConflictError)
    d1.sqlite.exec("DELETE FROM idem_full")
  })

  it("poisons a corrupt business-committed receipt instead of serving it", async () => {
    const { store, state, d1 } = await build()
    d1.sqlite.exec("INSERT INTO idem_full (id, scope, key, fingerprint, token, status, created_at, resource_version) VALUES ('i1','tenant:t1','k1','fp','tok','business-committed',100,'garbage')")
    await expect(store.acquire(request)).rejects.toThrow("Corrupted idempotency resource version")
    expect(state().status).toBe("poisoned")
    d1.sqlite.exec("UPDATE idem_full SET status = 'in-progress', created_at = 1")
    d1.sqlite.exec("UPDATE idem_full SET status = 'business-committed', resource_version = NULL, pending_invalidations = '{\"bad\":1}'")
    await expect(store.acquire(request)).rejects.toThrow("expected array")
    expect(state().status).toBe("poisoned")
  })

  it("claims pending invalidations with a database-time lease, then acks or completes under that claim", async () => {
    const { store, state, d1 } = await build()
    d1.sqlite.exec("INSERT INTO idem_full (id, scope, key, fingerprint, token, status, created_at, pending_invalidations, result) VALUES ('i1','tenant:t1','k1','fp','tok','business-committed',100,'[\"t1\"]','{\"ok\":1}')")
    d1.sqlite.exec("INSERT INTO idem_full (id, scope, key, fingerprint, token, status, created_at, pending_invalidations, result) VALUES ('i2','tenant:t1','k2','fp','tok2','business-committed',100,'[broken','{broken')")
    d1.sqlite.exec("INSERT INTO idem_full (id, scope, key, fingerprint, token, status, created_at) VALUES ('i3','tenant:t1','k3','fp','tok3','in-progress',100)")
    const claimed = await store.claimPendingInvalidations({ limit: 10, claimOwner: "fin", leaseMs: 60_000, claimToken: "c1" })
    expect(claimed).toEqual([{ scope: "tenant:t1", key: "k1", fingerprint: "fp", token: "tok", invalidations: ["t1"], result: { ok: 1 }, claimToken: "c1", claimOwner: "fin" }])
    expect(d1.sqlite.prepare("SELECT status FROM idem_full WHERE id = 'i2'").get()).toEqual({ status: "poisoned" })
    expect(await store.claimPendingInvalidations({ claimOwner: "fin2", leaseMs: 60_000 })).toEqual([])
    await expect(store.ackClaimedInvalidation({ ...lease, claimToken: "other" })).rejects.toBeInstanceOf(ConflictError)
    await store.ackClaimedInvalidation({ ...lease, claimToken: "c1" })
    expect(d1.sqlite.prepare("SELECT pending_invalidations AS p, finalizer_claim_token AS c FROM idem_full WHERE id = 'i1'").get()).toEqual({ p: null, c: null })
    d1.sqlite.exec("UPDATE idem_full SET pending_invalidations = '[\"t1\"]' WHERE id = 'i1'")
    const second = await store.claimPendingInvalidations({ claimOwner: "fin", leaseMs: 60_000, claimToken: "c2" })
    expect(second).toHaveLength(1)
    await expect(store.completeClaimedInvalidation({ ...lease, claimToken: "other", result: { ok: 2 } })).rejects.toBeInstanceOf(ConflictError)
    await store.completeClaimedInvalidation({ ...lease, claimToken: "c2", result: { ok: 2 } })
    expect(d1.sqlite.prepare("SELECT status, result FROM idem_full WHERE id = 'i1'").get()).toEqual({ status: "completed", result: '{"ok":2}' })
    expect(state()).toBeDefined()
  })

  it("validates claim arguments and expired claims can be taken again", async () => {
    const { store, d1 } = await build()
    await expect(store.claimPendingInvalidations({ limit: 0, claimOwner: "fin", leaseMs: 1_000 })).rejects.toThrow("limit")
    await expect(store.claimPendingInvalidations({ claimOwner: "", leaseMs: 1_000 })).rejects.toThrow("claimOwner is required")
    await expect(store.claimPendingInvalidations({ claimOwner: "fin", leaseMs: 0 })).rejects.toThrow("lease duration")
    d1.sqlite.exec("INSERT INTO idem_full (id, scope, key, fingerprint, token, status, created_at, pending_invalidations, finalizer_claim_token, finalizer_claim_expires_at) VALUES ('i1','tenant:t1','k1','fp','tok','business-committed',100,'[\"t\"]','old',1)")
    const claimed = await store.claimPendingInvalidations({ claimOwner: "fin", leaseMs: 60_000, claimToken: "new" })
    expect(claimed.map((claim) => claim.claimToken)).toEqual(["new"])
    expect(claimed[0]!.result).toBeNull()
  })
})
