import { describe, expect, it } from "vitest"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import { ConfigurationError, ConflictError } from "@xonava/core/domain"
import { createDrizzlePgIdempotencyStore } from "../drizzleIdempotencyStore"
import { createDrizzlePersistenceProvider, DrizzleEntityRegistry } from "../drizzlePersistenceProvider"
import { createScriptedDb, type ScriptedHandler, type ScriptedOp } from "../../__tests__/support/scriptedDb"

const table = pgTable("idempotency_records", {
  id: text("id").primaryKey(), scope: text("scope"), key: text("key"), fingerprint: text("fingerprint"), token: text("token"), status: text("status"), result: text("result"),
  resourceEntity: text("resource_entity"), resourceId: text("resource_id"), resourceVersion: text("resource_version"), pendingInvalidations: text("pending_invalidations"),
  finalizerClaimOwner: text("finalizer_claim_owner"), finalizerClaimToken: text("finalizer_claim_token"), finalizerClaimExpiresAt: integer("finalizer_claim_expires_at"), createdAt: integer("created_at"), completedAt: integer("completed_at"),
})

const request = { scope: "tenant:t1", key: "k1", fingerprint: "fp", leaseDurationMs: 30_000 }
const affected = (rowCount: number) => ({ rowCount })
const duplicate = () => Object.assign(new Error("dup"), { code: "23505" })
const stored = (overrides: Record<string, unknown> = {}) => ({ id: "i1", scope: "tenant:t1", key: "k1", fingerprint: "fp", token: "tok", status: "in-progress", result: null, resourceEntity: null, resourceId: null, resourceVersion: null, pendingInvalidations: null, ...overrides })

function build(handler: ScriptedHandler) {
  const scripted = createScriptedDb("pg", handler)
  return { store: createDrizzlePgIdempotencyStore<{ ok: number }>(scripted.db as never, table), ops: scripted.ops, db: scripted.db }
}
const updates = (ops: ScriptedOp[]) => ops.filter((op) => op.kind === "update")

describe("PostgreSQL idempotency store: acquire", () => {
  it("reserves a fresh key", async () => {
    const { store, ops } = build(() => affected(1))
    const result = await store.acquire(request)
    expect(result.outcome).toBe("acquired")
    expect(ops[0]!.values).toMatchObject({ scope: "tenant:t1", key: "k1", fingerprint: "fp", status: "in-progress", result: null })
  })

  it("rethrows errors other than unique violations", async () => {
    await expect(build(() => { throw Object.assign(new Error("boom"), { code: "XX000" }) }).store.acquire(request)).rejects.toThrow("boom")
    await expect(build(() => { throw new Error("no code") }).store.acquire(request)).rejects.toThrow("no code")
    await expect(build(() => affected(1)).store.acquire({ ...request, leaseDurationMs: Number.NaN })).rejects.toThrow("lease duration")
  })

  it("finds unique violations wrapped in a cause chain and rethrows when the key is not addressable", async () => {
    const wrapped = build((op) => { if (op.kind === "insert") throw new Error("wrapper", { cause: duplicate() }); return [stored({ status: "completed", result: JSON.stringify({ ok: 1 }) })] })
    expect(await wrapped.store.acquire(request)).toEqual({ outcome: "replay", result: { ok: 1 } })
    const other = build((op) => { if (op.kind === "insert") throw duplicate(); return [] })
    await expect(other.store.acquire(request)).rejects.toMatchObject({ code: "23505" })
  })

  it("resolves duplicates to replay, conflict or a business-committed receipt", async () => {
    const duplicateWith = (row: Record<string, unknown>): ScriptedHandler => (op) => { if (op.kind === "insert") throw duplicate(); return [row] }
    expect(await build(duplicateWith(stored({ fingerprint: "other" }))).store.acquire(request)).toEqual({ outcome: "conflict" })
    const committed = await build(duplicateWith(stored({ status: "business-committed", resourceEntity: "Order", resourceId: "o1", resourceVersion: JSON.stringify({ type: "number", value: 4 }), pendingInvalidations: '["a","a","b"]' }))).store.acquire(request)
    expect(committed).toEqual({ outcome: "business-committed", token: "tok", resource: { entity: "Order", id: "o1", version: 4 }, invalidations: ["a", "b"] })
    const bare = await build(duplicateWith(stored({ status: "business-committed" }))).store.acquire(request)
    expect(bare).toEqual({ outcome: "business-committed", token: "tok", invalidations: [] })
  })

  it("poisons corrupt business-committed receipts it cannot interpret", async () => {
    const corrupt = build((op) => { if (op.kind === "insert") throw duplicate(); if (op.kind === "select") return [stored({ status: "business-committed", pendingInvalidations: "{broken" })]; return affected(1) })
    await expect(corrupt.store.acquire(request)).rejects.toThrow("malformed JSON")
    expect(updates(corrupt.ops)[0]!.set).toEqual({ status: "poisoned" })
  })

  it("takes over an expired reservation, otherwise re-reads the current state", async () => {
    const takeover = build((op) => { if (op.kind === "insert") throw duplicate(); if (op.kind === "select") return [stored()]; return affected(1) })
    const result = await takeover.store.acquire(request)
    expect(result.outcome).toBe("acquired")
    expect(updates(takeover.ops)[0]!.where!.sql).toContain("interval '1 millisecond'")
    const held = build((op) => { if (op.kind === "insert") throw duplicate(); if (op.kind === "select") return [stored()]; return affected(0) })
    expect(await held.store.acquire(request)).toEqual({ outcome: "in-progress" })
    let reads = 0
    const completed = build((op) => { if (op.kind === "insert") throw duplicate(); if (op.kind === "select") return reads++ === 0 ? [stored()] : [stored({ status: "completed", result: JSON.stringify({ ok: 3 }) })]; return affected(0) })
    expect(await completed.store.acquire(request)).toEqual({ outcome: "replay", result: { ok: 3 } })
    let gone = 0
    const vanished = build((op) => { if (op.kind === "insert") throw duplicate(); if (op.kind === "select") return gone++ === 0 ? [stored()] : []; return affected(0) })
    expect(await vanished.store.acquire(request)).toEqual({ outcome: "in-progress" })
    let phase = 0
    const corruptOnRecheck = build((op) => { if (op.kind === "insert") throw duplicate(); if (op.kind === "select") return phase++ === 0 ? [stored()] : [stored({ status: "business-committed", resourceVersion: "bad" })]; return affected(0) })
    await expect(corruptOnRecheck.store.acquire(request)).rejects.toThrow("Corrupted idempotency resource version")
    expect(updates(corruptOnRecheck.ops).some((op) => (op.set as { status?: string }).status === "poisoned")).toBe(true)
  })
})

describe("PostgreSQL idempotency store: ownership and finalizer", () => {
  const lease = { scope: "tenant:t1", key: "k1", fingerprint: "fp", token: "tok" }

  it("renews, completes and abandons reservations under their fences", async () => {
    const { store, ops } = build(() => affected(1))
    await store.renew({ ...lease, leaseDurationMs: 1_000 })
    await store.complete({ ...lease, result: { ok: 1 } })
    await store.abandon!(lease)
    expect(ops.map((op) => op.kind)).toEqual(["update", "update", "delete"])
    expect(ops[1]!.set).toMatchObject({ status: "completed", result: '{"ok":1}', pendingInvalidations: null })
    expect(ops[2]!.where!.sql).toContain("status = 'in-progress'")
    const lost = build(() => affected(0))
    await expect(lost.store.renew(lease)).rejects.toBeInstanceOf(ConflictError)
    await expect(lost.store.complete({ ...lease, result: { ok: 1 } })).rejects.toBeInstanceOf(ConflictError)
    await expect(lost.store.renew({ ...lease, leaseDurationMs: 0 })).rejects.toThrow("lease duration")
  })

  it("records the commit receipt through the provider session and rejects lost ownership", async () => {
    const scripted = createScriptedDb("pg", () => affected(1))
    const provider = createDrizzlePersistenceProvider({ db: scripted.db as never, registry: new DrizzleEntityRegistry() })
    const store = createDrizzlePgIdempotencyStore<{ ok: number }>(scripted.db as never, table)
    await store.markCommittedInTransaction({ ...lease, resource: { entity: "Order", id: "o1", version: 2 }, invalidations: ["x", "x"] } as never, provider)
    expect(scripted.ops[0]!.set).toMatchObject({ status: "business-committed", resourceEntity: "Order", resourceVersion: JSON.stringify({ type: "number", value: 2 }), pendingInvalidations: '["x"]' })
    await store.markCommittedInTransaction(lease as never, provider)
    expect(scripted.ops[1]!.set).toMatchObject({ resourceEntity: null, resourceVersion: null, pendingInvalidations: null })
    const lost = createScriptedDb("pg", () => affected(0))
    const lostProvider = createDrizzlePersistenceProvider({ db: lost.db as never, registry: new DrizzleEntityRegistry() })
    await expect(store.markCommittedInTransaction(lease as never, lostProvider)).rejects.toBeInstanceOf(ConflictError)
    await expect(store.markCommittedInTransaction(lease as never, {} as never)).rejects.toBeInstanceOf(ConfigurationError)
  })

  const pending = (overrides: Record<string, unknown> = {}) => stored({ status: "business-committed", pendingInvalidations: '["tag:a","tag:a"]', result: JSON.stringify({ ok: 1 }), ...overrides })
  const claimArgs = { limit: 5, claimOwner: "fin", leaseMs: 10_000, claimToken: "claim-1" }

  it("claims pending invalidations row by row, skipping lost races and poisoning corrupt rows", async () => {
    const { store, ops } = build((op) => (op.kind === "select" ? [pending(), pending({ key: "k2" })] : affected(1)))
    const claimed = await store.claimPendingInvalidations(claimArgs)
    expect(claimed).toHaveLength(2)
    expect(claimed[0]).toMatchObject({ scope: "tenant:t1", key: "k1", invalidations: ["tag:a"], result: { ok: 1 }, claimToken: "claim-1", claimOwner: "fin" })
    expect(ops[0]).toMatchObject({ kind: "select", limit: 5 })
    expect(await build((op) => (op.kind === "select" ? [pending()] : affected(0))).store.claimPendingInvalidations(claimArgs)).toEqual([])
    const corrupt = build((op) => (op.kind === "select" ? [pending({ pendingInvalidations: "{x" })] : affected(1)))
    expect(await corrupt.store.claimPendingInvalidations(claimArgs)).toEqual([])
    expect(updates(corrupt.ops)[0]!.set).toEqual({ status: "poisoned" })
    const badResult = build((op) => (op.kind === "select" ? [pending({ result: "{x" }), pending({ result: null, key: "k3" })] : affected(1)))
    const results = await badResult.store.claimPendingInvalidations({ claimOwner: "fin", leaseMs: 1_000 })
    expect(results.map((claim) => claim.result)).toEqual([null, null])
    expect(results[0]!.claimToken).toMatch(/[0-9a-f-]{36}/)
    expect(badResult.ops[0]).toMatchObject({ limit: 100 })
  })

  it("validates claim arguments", async () => {
    const { store, ops } = build(() => [])
    await expect(store.claimPendingInvalidations({ ...claimArgs, limit: -1 })).rejects.toThrow("limit")
    await expect(store.claimPendingInvalidations({ ...claimArgs, claimOwner: "" })).rejects.toThrow("claimOwner is required")
    await expect(store.claimPendingInvalidations({ ...claimArgs, leaseMs: 0 })).rejects.toThrow("lease duration")
    expect(ops).toEqual([])
  })

  it("acks and completes claimed invalidations only for the live claim", async () => {
    const claim = { scope: "tenant:t1", key: "k1", fingerprint: "fp", token: "tok", claimToken: "claim-1" }
    const ok = build(() => affected(1))
    await ok.store.ackClaimedInvalidation(claim)
    await ok.store.completeClaimedInvalidation({ ...claim, result: { ok: 1 } })
    expect(ok.ops[0]!.set).toMatchObject({ pendingInvalidations: null, finalizerClaimToken: null })
    expect(ok.ops[1]!.set).toMatchObject({ status: "completed", result: '{"ok":1}' })
    const lost = build(() => affected(0))
    await expect(lost.store.ackClaimedInvalidation(claim)).rejects.toThrow("lost ownership or lease expired")
    await expect(lost.store.completeClaimedInvalidation({ ...claim, result: { ok: 1 } })).rejects.toThrow("lost ownership or lease expired")
  })
})
