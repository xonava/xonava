import { describe, expect, it } from "vitest"
import { int, mysqlTable, text, varchar } from "drizzle-orm/mysql-core"
import { ConfigurationError, ConflictError } from "@xonava/core/domain"
import { createDrizzleMySqlIdempotencyStore } from "../drizzleIdempotencyStore"
import { createDrizzleMySqlPersistenceProvider, DrizzleMySqlEntityRegistry } from "../drizzlePersistenceProvider"
import { createScriptedDb, type ScriptedHandler, type ScriptedOp } from "../../__tests__/support/scriptedDb"

const table = mysqlTable("idempotency_records", {
  id: varchar("id", { length: 36 }).primaryKey(), scope: varchar("scope", { length: 64 }), key: varchar("key", { length: 64 }), fingerprint: varchar("fingerprint", { length: 64 }), token: varchar("token", { length: 64 }),
  status: varchar("status", { length: 32 }), result: text("result"), resourceEntity: varchar("resource_entity", { length: 64 }), resourceId: varchar("resource_id", { length: 64 }), resourceVersion: varchar("resource_version", { length: 64 }),
  pendingInvalidations: text("pending_invalidations"), finalizerClaimOwner: varchar("finalizer_claim_owner", { length: 64 }), finalizerClaimToken: varchar("finalizer_claim_token", { length: 64 }),
  finalizerClaimExpiresAt: int("finalizer_claim_expires_at"), createdAt: int("created_at"), completedAt: int("completed_at"),
})

const request = { scope: "tenant:t1", key: "k1", fingerprint: "fp", leaseDurationMs: 30_000 }
const header = (affectedRows: number) => [{ affectedRows }, undefined]
const duplicate = () => Object.assign(new Error("dup"), { errno: 1062 })
const deadlock = () => Object.assign(new Error("deadlock"), { errno: 1213 })
const stored = (overrides: Record<string, unknown> = {}) => ({ id: "i1", scope: "tenant:t1", key: "k1", fingerprint: "fp", token: "tok", status: "in-progress", result: null, resourceEntity: null, resourceId: null, resourceVersion: null, pendingInvalidations: null, ...overrides })

function build(handler: ScriptedHandler) {
  const scripted = createScriptedDb("mysql", handler)
  return { store: createDrizzleMySqlIdempotencyStore<{ ok: number }>(scripted.db as never, table as never), ops: scripted.ops, db: scripted.db }
}
const updates = (ops: ScriptedOp[]) => ops.filter((op) => op.kind === "update")

describe("MySQL idempotency store: acquire", () => {
  it("reserves a fresh key with an in-progress row", async () => {
    const { store, ops } = build(() => header(1))
    const result = await store.acquire(request)
    expect(result.outcome).toBe("acquired")
    expect(ops[0]).toMatchObject({ kind: "insert" })
    expect(ops[0]!.values).toMatchObject({ scope: "tenant:t1", key: "k1", fingerprint: "fp", status: "in-progress", result: null, token: (result as { token: string }).token })
  })

  it("retries deadlocks up to five times and then surfaces the failure", async () => {
    let failures = 3
    const flaky = build(() => { if (failures-- > 0) throw deadlock(); return header(1) })
    expect((await flaky.store.acquire(request)).outcome).toBe("acquired")
    expect(flaky.ops.filter((op) => op.kind === "insert")).toHaveLength(4)
    const hopeless = build(() => { throw deadlock() })
    await expect(hopeless.store.acquire(request)).rejects.toMatchObject({ errno: 1213 })
    expect(hopeless.ops.filter((op) => op.kind === "insert")).toHaveLength(6)
    const other = build(() => { throw Object.assign(new Error("boom"), { errno: 1 }) })
    await expect(other.store.acquire(request)).rejects.toThrow("boom")
  })

  it("recognizes duplicate-key errors wrapped in a cause chain", async () => {
    const wrapped = build((op) => { if (op.kind === "insert") throw Object.assign(new Error("wrapper"), { cause: { code: "ER_DUP_ENTRY" } }); return [stored({ status: "completed", result: { ok: 1 } })] })
    expect(await wrapped.store.acquire(request)).toEqual({ outcome: "replay", result: { ok: 1 } })
    const deadlockCause = build((op) => { if (op.kind === "insert" && wrapped.ops.length === 0) throw Object.assign(new Error("w"), { cause: { code: "ER_LOCK_DEADLOCK" } }); return header(1) })
    expect((await deadlockCause.store.acquire(request)).outcome).toBe("acquired")
  })

  it("replays a completed duplicate, reports conflicts and exposes business-committed receipts", async () => {
    const duplicateWith = (row: Record<string, unknown> | undefined): ScriptedHandler => (op) => { if (op.kind === "insert") throw duplicate(); return row ? [row] : [] }
    expect(await build(duplicateWith(stored({ status: "completed", result: { ok: 7 } }))).store.acquire(request)).toEqual({ outcome: "replay", result: { ok: 7 } })
    expect(await build(duplicateWith(stored({ fingerprint: "other" }))).store.acquire(request)).toEqual({ outcome: "conflict" })
    const committed = await build(duplicateWith(stored({ status: "business-committed", resourceEntity: "Order", resourceId: "o1", resourceVersion: JSON.stringify({ type: "number", value: 2 }), pendingInvalidations: ["tag:a", "tag:a", "tag:b"] }))).store.acquire(request)
    expect(committed).toEqual({ outcome: "business-committed", token: "tok", resource: { entity: "Order", id: "o1", version: 2 }, invalidations: ["tag:a", "tag:b"] })
    await expect(build(duplicateWith(undefined)).store.acquire(request)).rejects.toMatchObject({ errno: 1062 })
  })

  it("poisons a business-committed receipt whose stored data is corrupt", async () => {
    const corrupt = build((op) => { if (op.kind === "insert") throw duplicate(); if (op.kind === "select") return [stored({ status: "business-committed", resourceVersion: "not json" })]; return header(1) })
    await expect(corrupt.store.acquire(request)).rejects.toThrow("Corrupted idempotency resource version")
    const poison = updates(corrupt.ops)[0]!
    expect(poison.set).toEqual({ status: "poisoned" })
    expect(poison.where!.sql).toContain("status='business-committed'")
    const badInvalidations = build((op) => { if (op.kind === "insert") throw duplicate(); if (op.kind === "select") return [stored({ status: "business-committed", pendingInvalidations: '{"x":1}' })]; return header(1) })
    await expect(badInvalidations.store.acquire(request)).rejects.toThrow("expected array")
    expect(updates(badInvalidations.ops)).toHaveLength(1)
  })

  it("takes over an expired in-progress reservation, or reports in-progress", async () => {
    const takeover = build((op) => { if (op.kind === "insert") throw duplicate(); if (op.kind === "select") return [stored()]; return header(1) })
    const result = await takeover.store.acquire(request)
    expect(result.outcome).toBe("acquired")
    expect((updates(takeover.ops)[0]!.set as { token: string }).token).toBe((result as { token: string }).token)
    expect(updates(takeover.ops)[0]!.where!.sql).toContain("TIMESTAMPADD(MICROSECOND")
    const stillHeld = build((op) => { if (op.kind === "insert") throw duplicate(); if (op.kind === "select") return [stored()]; return header(0) })
    expect(await stillHeld.store.acquire(request)).toEqual({ outcome: "in-progress" })
    let reads = 0
    const racedToCompleted = build((op) => { if (op.kind === "insert") throw duplicate(); if (op.kind === "select") return reads++ === 0 ? [stored()] : [stored({ status: "completed", result: { ok: 2 } })]; return header(0) })
    expect(await racedToCompleted.store.acquire(request)).toEqual({ outcome: "replay", result: { ok: 2 } })
    let gone = 0
    const racedAway = build((op) => { if (op.kind === "insert") throw duplicate(); if (op.kind === "select") return gone++ === 0 ? [stored()] : []; return header(0) })
    expect(await racedAway.store.acquire(request)).toEqual({ outcome: "in-progress" })
  })

  it("validates lease durations before touching the database", async () => {
    const { store, ops } = build(() => header(1))
    await expect(store.acquire({ ...request, leaseDurationMs: 0 })).rejects.toThrow("lease duration")
    expect(ops).toEqual([])
  })
})

describe("MySQL idempotency store: ownership transitions", () => {
  const lease = { scope: "tenant:t1", key: "k1", fingerprint: "fp", token: "tok" }

  it("renews only a live in-progress lease", async () => {
    const { store, ops } = build(() => header(1))
    await store.renew({ ...lease, leaseDurationMs: 1_000 })
    expect(ops[0]!.where!.params).toEqual(["tenant:t1", "k1", "fp", "tok"])
    await expect(build(() => header(0)).store.renew(lease)).rejects.toBeInstanceOf(ConflictError)
    await expect(store.renew({ ...lease, leaseDurationMs: -1 })).rejects.toThrow("lease duration")
  })

  it("records the commit receipt through the persistence session and rejects lost ownership", async () => {
    const scripted = createScriptedDb("mysql", () => header(1))
    const persistence = createDrizzleMySqlPersistenceProvider({ db: scripted.db as never, registry: new DrizzleMySqlEntityRegistry() })
    const store = createDrizzleMySqlIdempotencyStore<{ ok: number }>(scripted.db as never, table as never)
    await store.markCommittedInTransaction({ ...lease, resource: { entity: "Order", id: "o1", version: 3 }, invalidations: ["a", "a", "b"] } as never, persistence)
    expect(scripted.ops[0]!.set).toMatchObject({ status: "business-committed", resourceEntity: "Order", resourceId: "o1", resourceVersion: JSON.stringify({ type: "number", value: 3 }), pendingInvalidations: '["a","b"]' })
    await store.markCommittedInTransaction({ ...lease } as never, persistence)
    expect(scripted.ops[1]!.set).toMatchObject({ resourceEntity: null, resourceId: null, resourceVersion: null, pendingInvalidations: null })
    const lost = createScriptedDb("mysql", () => header(0))
    const lostPersistence = createDrizzleMySqlPersistenceProvider({ db: lost.db as never, registry: new DrizzleMySqlEntityRegistry() })
    await expect(store.markCommittedInTransaction(lease as never, lostPersistence)).rejects.toBeInstanceOf(ConflictError)
    await expect(store.markCommittedInTransaction(lease as never, {} as never)).rejects.toBeInstanceOf(ConfigurationError)
  })

  it("completes a business-committed receipt, abandons uncommitted reservations", async () => {
    const { store, ops } = build(() => header(1))
    await store.complete({ ...lease, result: { ok: 1 } })
    expect(ops[0]!.set).toMatchObject({ status: "completed", pendingInvalidations: null, finalizerClaimOwner: null })
    expect(ops[0]!.where!.sql).toContain("status='business-committed'")
    await expect(build(() => header(0)).store.complete({ ...lease, result: { ok: 1 } })).rejects.toBeInstanceOf(ConflictError)
    await store.abandon(lease)
    expect(ops[1]).toMatchObject({ kind: "delete" })
    expect(ops[1]!.where!.sql).toContain("status='in-progress'")
  })
})

describe("MySQL idempotency store: finalizer claims", () => {
  const pending = (overrides: Record<string, unknown> = {}) => stored({ status: "business-committed", pendingInvalidations: '["tag:a","tag:a"]', result: JSON.stringify({ ok: 1 }), ...overrides })
  const claimArgs = { limit: 5, claimOwner: "fin", leaseMs: 10_000, claimToken: "claim-1" }

  it("claims pending invalidations with a fenced update per row", async () => {
    const { store, ops } = build((op) => (op.kind === "select" ? [pending(), pending({ key: "k2" })] : header(1)))
    const claimed = await store.claimPendingInvalidations(claimArgs)
    expect(claimed).toHaveLength(2)
    expect(claimed[0]).toMatchObject({ scope: "tenant:t1", key: "k1", invalidations: ["tag:a"], result: { ok: 1 }, claimToken: "claim-1", claimOwner: "fin" })
    expect(ops[0]).toMatchObject({ kind: "select", limit: 5 })
    expect(updates(ops)).toHaveLength(2)
  })

  it("skips rows another finalizer won, poisons corrupt ones and generates a claim token when absent", async () => {
    const lost = build((op) => (op.kind === "select" ? [pending()] : header(0)))
    expect(await lost.store.claimPendingInvalidations(claimArgs)).toEqual([])
    const corrupt = build((op) => (op.kind === "select" ? [pending({ pendingInvalidations: "{broken" })] : header(1)))
    expect(await corrupt.store.claimPendingInvalidations(claimArgs)).toEqual([])
    expect(updates(corrupt.ops)[0]!.set).toEqual({ status: "poisoned" })
    const corruptResult = build((op) => (op.kind === "select" ? [pending({ result: "{broken" })] : header(1)))
    expect(await corruptResult.store.claimPendingInvalidations(claimArgs)).toEqual([])
    const generated = build((op) => (op.kind === "select" ? [pending({ result: { ok: 2 } })] : header(1)))
    const [claim] = await generated.store.claimPendingInvalidations({ claimOwner: "fin", leaseMs: 1_000 })
    expect(claim!.claimToken).toMatch(/[0-9a-f-]{36}/)
    expect(claim!.result).toEqual({ ok: 2 })
    expect(generated.ops[0]).toMatchObject({ limit: 100 })
  })

  it("validates claim arguments", async () => {
    const { store, ops } = build(() => [])
    await expect(store.claimPendingInvalidations({ ...claimArgs, limit: 0 })).rejects.toThrow("limit")
    await expect(store.claimPendingInvalidations({ ...claimArgs, claimOwner: "" })).rejects.toThrow("claimOwner is required")
    await expect(store.claimPendingInvalidations({ ...claimArgs, leaseMs: 0 })).rejects.toThrow("lease duration")
    expect(ops).toEqual([])
  })

  it("acknowledges and completes claimed invalidations only for the current claim", async () => {
    const claim = { scope: "tenant:t1", key: "k1", fingerprint: "fp", token: "tok", claimToken: "claim-1" }
    const { store, ops } = build(() => header(1))
    await store.ackClaimedInvalidation(claim)
    expect(ops[0]!.set).toMatchObject({ pendingInvalidations: null, finalizerClaimToken: null })
    await store.completeClaimedInvalidation({ ...claim, result: { ok: 1 } })
    expect(ops[1]!.set).toMatchObject({ status: "completed" })
    const lost = build(() => header(0))
    await expect(lost.store.ackClaimedInvalidation(claim)).rejects.toThrow("invalidation claim was lost")
    await expect(lost.store.completeClaimedInvalidation({ ...claim, result: { ok: 1 } })).rejects.toThrow("invalidation claim was lost")
  })
})
