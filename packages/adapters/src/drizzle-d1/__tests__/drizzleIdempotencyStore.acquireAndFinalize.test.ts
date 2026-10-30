import { describe, expect, it } from "vitest"
import { drizzle } from "drizzle-orm/d1"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ConflictError } from "@xonava/core/domain"
import { createDrizzleD1Adapter, createDrizzleD1IdempotencyStore, DrizzleD1IdempotencyStore } from "@xonava/adapters/drizzle-d1"
import { createScriptedDb, type ScriptedHandler, type ScriptedOp } from "../../__tests__/support/scriptedDb"
import { setup } from "./sqliteFixture"

const records = sqliteTable("idem_full", {
  id: text("id").primaryKey(), scope: text("scope").notNull(), key: text("key").notNull(), fingerprint: text("fingerprint").notNull(), token: text("token").notNull(), status: text("status").notNull(), result: text("result"),
  resourceEntity: text("resource_entity"), resourceId: text("resource_id"), resourceVersion: text("resource_version"), pendingInvalidations: text("pending_invalidations"),
  finalizerClaimOwner: text("finalizer_claim_owner"), finalizerClaimToken: text("finalizer_claim_token"), finalizerClaimExpiresAt: integer("finalizer_claim_expires_at"), createdAt: integer("created_at").notNull(), completedAt: integer("completed_at"),
})
const SCHEMA = ["CREATE TABLE idem_full (id TEXT PRIMARY KEY, scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, token TEXT NOT NULL, status TEXT NOT NULL, result TEXT, resource_entity TEXT, resource_id TEXT, resource_version TEXT, pending_invalidations TEXT, finalizer_claim_owner TEXT, finalizer_claim_token TEXT, finalizer_claim_expires_at INTEGER, created_at INTEGER NOT NULL, completed_at INTEGER, UNIQUE (scope, key))"]
const request = { scope: "tenant:t1", key: "k1", fingerprint: "fp", leaseDurationMs: 30_000 }
const norm = (sql: string | undefined) => (sql ?? "").replace(/\s+/g, " ")
const T = '"idem_full".'

const existingRow = (overrides: Record<string, unknown> = {}) => ({
  id: "i1", scope: "tenant:t1", key: "k1", fingerprint: "fp", token: "tok", status: "in-progress", result: null, resourceEntity: null, resourceId: null, resourceVersion: null,
  pendingInvalidations: null, createdAt: 1, ...overrides,
})
const changes = (n: number) => ({ meta: { changes: n } })
function scripted(handler: ScriptedHandler) {
  const s = createScriptedDb("sqlite", handler)
  return { store: new DrizzleD1IdempotencyStore<{ ok: number }>(s.db as never, records), ops: s.ops }
}
const kinds = (ops: readonly ScriptedOp[]) => ops.map((op) => op.kind)

describe("d1 idempotency acquire edge paths", () => {
  it("requires a conflict primitive on the session's insert builder", async () => {
    const expected = new Error("D1 idempotency requires an insert conflict primitive")
    const missing = new DrizzleD1IdempotencyStore({ insert: () => ({ values: () => ({}) }) } as never, records)
    await expect(missing.acquire(request)).rejects.toThrow(expected)
    const notAFunction = new DrizzleD1IdempotencyStore({ insert: () => ({ values: () => ({ onConflictDoNothing: "no" }) }) } as never, records)
    await expect(notAFunction.acquire(request)).rejects.toThrow(expected)
  })

  it("inserts the in-progress reservation targeting scope and key, and returns its token", async () => {
    const calls: { values: Record<string, unknown>; target: unknown }[] = []
    const db = { insert: () => ({ values: (values: Record<string, unknown>) => ({ onConflictDoNothing: async (config: { target: unknown }) => { calls.push({ values, target: config.target }); return changes(1) } }) }) }
    const result = await new DrizzleD1IdempotencyStore(db as never, records).acquire(request)
    expect(result).toEqual({ outcome: "acquired", token: calls[0]!.values.token })
    expect(calls[0]!.target).toEqual([records.scope, records.key])
    expect(calls[0]!.values).toMatchObject({ scope: "tenant:t1", key: "k1", fingerprint: "fp", status: "in-progress", result: null, id: expect.any(String) })
  })

  it("reports a reservation that vanished after the insert conflicted", async () => {
    for (const rows of [[], [null], ["row"], [7]]) {
      const f = scripted((op) => (op.kind === "insert" ? changes(0) : rows))
      await expect(f.store.acquire(request)).rejects.toThrow(new Error("Idempotency reservation disappeared after conflict"))
    }
  })

  it("serves completed and committed rows without attempting a takeover", async () => {
    const completed = scripted((op) => (op.kind === "insert" ? changes(0) : [existingRow({ status: "completed", result: '{"ok":1}' })]))
    expect(await completed.store.acquire(request)).toEqual({ outcome: "replay", result: { ok: 1 } })
    expect(kinds(completed.ops)).toEqual(["insert", "select"])
    const other = scripted((op) => (op.kind === "insert" ? changes(0) : [existingRow({ fingerprint: "other" })]))
    expect(await other.store.acquire(request)).toEqual({ outcome: "conflict" })
    expect(kinds(other.ops)).toEqual(["insert", "select"])
    expect(norm(completed.ops[1]!.where!.sql)).toBe(`(${T}"scope" = ? and ${T}"key" = ?)`)
    expect(completed.ops[1]!.where!.params).toEqual(["tenant:t1", "k1"])
    expect(completed.ops[1]).toMatchObject({ limit: 1 })
  })

  it("poisons a corrupt committed receipt found before or during the takeover and rethrows", async () => {
    const corrupt = existingRow({ status: "business-committed", pendingInvalidations: "[broken" })
    const before = scripted((op) => (op.kind === "insert" ? changes(0) : [corrupt]))
    await expect(before.store.acquire(request)).rejects.toThrow("Corrupted idempotency invalidation data")
    expect(kinds(before.ops)).toEqual(["insert", "select", "update"])
    expect(before.ops[2]!.set).toEqual({ status: "poisoned" })
    expect(norm(before.ops[2]!.where!.sql)).toBe(`(${T}"scope" = ? and ${T}"key" = ? and ${T}"token" = ? and ${T}"status" = ?)`)
    expect(before.ops[2]!.where!.params).toEqual(["tenant:t1", "k1", "tok", "business-committed"])
    let selects = 0
    const during = scripted((op) => (op.kind === "insert" ? changes(0) : op.kind === "update" ? changes(0) : ++selects === 1 ? [existingRow()] : [corrupt]))
    await expect(during.store.acquire(request)).rejects.toThrow("Corrupted idempotency invalidation data")
    expect(kinds(during.ops)).toEqual(["insert", "select", "update", "select", "update"])
    expect(during.ops[4]!.set).toEqual({ status: "poisoned" })
  })

  it("takes over an expired in-progress reservation with a fresh token, fenced on fingerprint and status", async () => {
    const f = scripted((op) => (op.kind === "insert" ? changes(0) : op.kind === "update" ? changes(1) : [existingRow()]))
    const result = await f.store.acquire(request)
    const takeover = f.ops[2]!
    expect(result).toEqual({ outcome: "acquired", token: (takeover.set as { token: string }).token })
    expect(norm(takeover.where!.sql)).toContain(`${T}"fingerprint" = ? and ${T}"status" = ?`)
    expect(takeover.where!.params).toEqual(["tenant:t1", "k1", "fp", "in-progress", -30_000])
  })

  it("reports a live reservation as in-progress and a vanished one after a lost takeover", async () => {
    const live = scripted((op) => (op.kind === "select" ? [existingRow()] : changes(0)))
    expect(await live.store.acquire(request)).toEqual({ outcome: "in-progress" })
    for (const rows of [[], [null], ["row"], [3]]) {
      let calls = 0
      const f = scripted((op) => (op.kind === "insert" ? changes(0) : op.kind === "update" ? changes(0) : ++calls === 1 ? [existingRow()] : rows))
      await expect(f.store.acquire(request)).rejects.toThrow(new Error("Idempotency reservation disappeared during takeover"))
    }
    let calls = 0
    const committed = scripted((op) => (op.kind === "insert" ? changes(0) : op.kind === "update" ? changes(0) : ++calls === 1 ? [existingRow()] : [existingRow({ status: "completed", result: '{"ok":5}' })]))
    expect(await committed.store.acquire(request)).toEqual({ outcome: "replay", result: { ok: 5 } })
  })
})

describe("d1 idempotency finalization on a real SQLite engine", () => {
  async function build() {
    const fixture = await setup({ extraSchema: SCHEMA })
    const store = createDrizzleD1IdempotencyStore<{ ok: number }>(createDrizzleD1Adapter(drizzle(fixture.d1 as never) as never).repository, records)
    const insert = (id: string, status: string, extra = "") =>
      fixture.d1.sqlite.exec(`INSERT INTO idem_full (id, scope, key, fingerprint, token, status, created_at${extra ? `, ${extra.split("=")[0]}` : ""}) VALUES ('${id}','s','k-${id}','fp','tok-${id}','${status}',100${extra ? `, ${extra.split("=")[1]}` : ""})`)
    const row = (id: string) => fixture.row(`SELECT status, result, pending_invalidations AS inv, finalizer_claim_token AS claim, finalizer_claim_owner AS owner, finalizer_claim_expires_at AS expires, typeof(completed_at) AS done FROM idem_full WHERE id = '${id}'`)
    return { ...fixture, store, insert, row }
  }
  const lease = (id: string) => ({ scope: "s", key: `k-${id}`, fingerprint: "fp", token: `tok-${id}` })

  it("complete() stores the result only for a business-committed receipt of the same owner", async () => {
    const { store, insert, row } = await build()
    insert("c1", "business-committed")
    await store.complete({ ...lease("c1"), result: { ok: 1 } })
    expect(row("c1")).toEqual({ status: "completed", result: '{"ok":1}', inv: null, claim: null, owner: null, expires: null, done: "integer" })
    for (const status of ["in-progress", "completed", "poisoned"]) {
      insert(`x-${status}`, status)
      await expect(store.complete({ ...lease(`x-${status}`), result: { ok: 2 } })).rejects.toThrow(new ConflictError("Idempotency completion lost ownership of the reservation"))
      expect(row(`x-${status}`)).toMatchObject({ status })
    }
    insert("c2", "business-committed")
    await expect(store.complete({ ...lease("c2"), token: "other", result: { ok: 3 } })).rejects.toBeInstanceOf(ConflictError)
    await expect(store.complete({ ...lease("c2"), fingerprint: "other", result: { ok: 3 } })).rejects.toBeInstanceOf(ConflictError)
    expect(row("c2")).toMatchObject({ status: "business-committed" })
  })

  it("claimed completion and acknowledgement need a live claim on a committed receipt", async () => {
    const { store, d1, insert, row } = await build()
    insert("a1", "business-committed", "pending_invalidations='[\"t\"]'")
    const [claim] = await store.claimPendingInvalidations({ claimOwner: "fin", leaseMs: 60_000, claimToken: "ct" })
    expect(claim).toMatchObject({ token: "tok-a1", claimToken: "ct", claimOwner: "fin" })
    expect(row("a1")).toMatchObject({ claim: "ct", owner: "fin" })
    await expect(store.ackClaimedInvalidation({ ...lease("a1"), claimToken: "wrong" })).rejects.toThrow(new ConflictError("Idempotency ack claimed invalidations lost ownership or lease expired"))
    await expect(store.completeClaimedInvalidation({ ...lease("a1"), claimToken: "wrong", result: { ok: 1 } })).rejects.toThrow(new ConflictError("Idempotency complete claimed invalidations lost ownership or lease expired"))
    d1.sqlite.exec("UPDATE idem_full SET finalizer_claim_expires_at = 1")
    await expect(store.ackClaimedInvalidation({ ...lease("a1"), claimToken: "ct" })).rejects.toBeInstanceOf(ConflictError)
    await expect(store.completeClaimedInvalidation({ ...lease("a1"), claimToken: "ct", result: { ok: 1 } })).rejects.toBeInstanceOf(ConflictError)
    d1.sqlite.exec("UPDATE idem_full SET finalizer_claim_expires_at = 9999999999999, status = 'in-progress'")
    await expect(store.completeClaimedInvalidation({ ...lease("a1"), claimToken: "ct", result: { ok: 1 } })).rejects.toBeInstanceOf(ConflictError)
    await expect(store.ackClaimedInvalidation({ ...lease("a1"), claimToken: "ct" })).rejects.toBeInstanceOf(ConflictError)
    expect(row("a1")).toMatchObject({ status: "in-progress" })
    d1.sqlite.exec("UPDATE idem_full SET status = 'business-committed'")
    await store.completeClaimedInvalidation({ ...lease("a1"), claimToken: "ct", result: { ok: 9 } })
    expect(row("a1")).toEqual({ status: "completed", result: '{"ok":9}', inv: null, claim: null, owner: null, expires: null, done: "integer" })
  })

  it("claims return an undecodable stored result as null and malformed invalidations are poisoned, not claimed", async () => {
    const { store, insert, row } = await build()
    insert("p1", "business-committed", "pending_invalidations='[\"t\"]'")
    const claimed = await store.claimPendingInvalidations({ claimOwner: "fin", leaseMs: 60_000, claimToken: "c" })
    expect(claimed.map((entry) => [entry.key, entry.result, entry.invalidations])).toEqual([["k-p1", null, ["t"]]])
    insert("p2", "business-committed", "pending_invalidations='[broken'")
    insert("p3", "business-committed", "pending_invalidations='[1]'")
    expect(await store.claimPendingInvalidations({ claimOwner: "fin", leaseMs: 60_000, claimToken: "c2" })).toEqual([])
    expect(row("p2")).toMatchObject({ status: "poisoned" })
    expect(row("p3")).toMatchObject({ status: "poisoned" })
  })

  it("does not report a row as claimed when another worker won the claim update", async () => {
    const rows = [existingRow({ status: "business-committed", pendingInvalidations: '["t"]', result: '{"ok":1}' }), existingRow({ key: "k2", token: "tok2", status: "business-committed", pendingInvalidations: '["u"]', result: 5 })]
    const f = scripted((op) => (op.kind === "select" ? rows : changes(op.where!.params.includes("k1") ? 0 : 1)))
    const claimed = await f.store.claimPendingInvalidations({ claimOwner: "fin", leaseMs: 1_000, claimToken: "c" })
    expect(claimed.map((entry) => entry.key)).toEqual(["k2"])
    expect(claimed[0]!.result).toBeNull()
    const none = scripted((op) => (op.kind === "select" ? rows : changes(0)))
    expect(await none.store.claimPendingInvalidations({ claimOwner: "fin", leaseMs: 1_000 })).toEqual([])
  })
})
