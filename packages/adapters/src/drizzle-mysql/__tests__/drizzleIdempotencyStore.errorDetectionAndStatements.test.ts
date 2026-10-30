import { describe, expect, it } from "vitest"
import { int, mysqlTable, text, varchar } from "drizzle-orm/mysql-core"
import { createDrizzleMySqlIdempotencyStore } from "../drizzleIdempotencyStore"
import { createDrizzleMySqlPersistenceProvider, DrizzleMySqlEntityRegistry } from "../drizzlePersistenceProvider"
import { createScriptedDb, renderSql, type ScriptedHandler, type ScriptedOp } from "../../__tests__/support/scriptedDb"

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
const render = (value: unknown) => renderSql("mysql", value)

function build(handler: ScriptedHandler) {
  const scripted = createScriptedDb("mysql", handler)
  return { store: createDrizzleMySqlIdempotencyStore<{ ok: number }>(scripted.db as never, table as never), ops: scripted.ops, db: scripted.db }
}
const wheres = (ops: ScriptedOp[]) => ops.map((op) => [op.kind, op.where?.sql, op.where?.params])
const wrap = (inner: unknown, depth: number): unknown => { let error = inner; for (let i = 0; i < depth; i++) error = new Error(`wrap${i}`, { cause: error }); return error }

describe("MySQL idempotency store: error detection", () => {
  it("finds a duplicate key by errno or by code, up to five causes deep and no deeper", async () => {
    const replay = (op: ScriptedOp) => [stored({ status: "completed", result: { ok: 1 } })].filter(() => op.kind === "select")
    for (const inner of [{ errno: 1062 }, { code: "ER_DUP_ENTRY" }]) {
      const found = build((op) => { if (op.kind === "insert") throw wrap(Object.assign(new Error("d"), inner), 4); return replay(op) })
      expect(await found.store.acquire(request)).toEqual({ outcome: "replay", result: { ok: 1 } })
    }
    const tooDeep = wrap(duplicate(), 5)
    const deep = build((op) => { if (op.kind === "insert") throw tooDeep; return replay(op) })
    await expect(deep.store.acquire(request)).rejects.toBe(tooDeep)
    expect(deep.ops.map((op) => op.kind)).toEqual(["insert"])
  })

  it("does not mistake other errors, functions, primitives or odd causes for a duplicate", async () => {
    const other = Object.assign(new Error("x"), { errno: 1, code: "ER_OTHER" })
    const fn = Object.assign(() => undefined, { errno: 1062 })
    const fnCode = Object.assign(() => undefined, { code: "ER_DUP_ENTRY" })
    const noProto = Object.create(null) as Record<string, unknown>
    const nullCause = new Error("x", { cause: null })
    const stringCause = new Error("x", { cause: "text" })
    for (const thrown of [other, fn, fnCode, noProto, nullCause, stringCause, "text", 42, null, undefined]) {
      const f = build((op) => { if (op.kind === "insert") throw thrown; return [stored({ status: "completed", result: { ok: 1 } })] })
      await expect(f.store.acquire(request)).rejects.toBe(thrown)
      expect(f.ops.map((op) => op.kind)).toEqual(["insert"])
    }
  })

  it("retries a deadlock by errno or code, found up to five causes deep", async () => {
    for (const inner of [{ errno: 1213 }, { code: "ER_LOCK_DEADLOCK" }]) {
      let failures = 2
      const f = build(() => { if (failures-- > 0) throw wrap(Object.assign(new Error("d"), inner), 4); return header(1) })
      expect((await f.store.acquire(request)).outcome).toBe("acquired")
      expect(f.ops.filter((op) => op.kind === "insert")).toHaveLength(3)
    }
    const tooDeep = wrap(deadlock(), 5)
    const deep = build(() => { throw tooDeep })
    await expect(deep.store.acquire(request)).rejects.toBe(tooDeep)
    expect(deep.ops).toHaveLength(1)
  })

  it("does not retry other errors, functions, primitives or odd causes as deadlocks", async () => {
    const other = Object.assign(new Error("x"), { errno: 1, code: "ER_OTHER" })
    const fn = Object.assign(() => undefined, { errno: 1213 })
    const fnCode = Object.assign(() => undefined, { code: "ER_LOCK_DEADLOCK" })
    const nullCause = new Error("x", { cause: null })
    const stringCause = new Error("x", { cause: "text" })
    for (const thrown of [other, fn, fnCode, nullCause, stringCause, "text", 42, null, undefined]) {
      const f = build(() => { throw thrown })
      await expect(f.store.acquire(request)).rejects.toBe(thrown)
      expect(f.ops).toHaveLength(1)
    }
  })
})

describe("MySQL idempotency store: stored row decoding", () => {
  const dup = (row: Record<string, unknown>) => build((op) => { if (op.kind === "insert") throw duplicate(); return [row] })

  it("replays a completed row with a missing result as null", async () => {
    expect(await dup(stored({ status: "completed", result: null })).store.acquire(request)).toEqual({ outcome: "replay", result: null })
    expect(await dup(stored({ status: "completed", result: undefined })).store.acquire(request)).toEqual({ outcome: "replay", result: null })
    expect(await dup(stored({ status: "completed", result: "text" })).store.acquire(request)).toEqual({ outcome: "replay", result: "text" })
  })

  it("accepts business-committed receipts without invalidations, with array or string invalidations", async () => {
    const committed = { outcome: "business-committed", token: "tok", invalidations: [] }
    expect(await dup(stored({ status: "business-committed", pendingInvalidations: null })).store.acquire(request)).toEqual(committed)
    expect(await dup(stored({ status: "business-committed", pendingInvalidations: undefined })).store.acquire(request)).toEqual(committed)
    expect(await dup(stored({ status: "business-committed", pendingInvalidations: ["a", "b"] })).store.acquire(request)).toEqual({ ...committed, invalidations: ["a", "b"] })
    expect(await dup(stored({ status: "business-committed", pendingInvalidations: '["a"]' })).store.acquire(request)).toEqual({ ...committed, invalidations: ["a"] })
    expect(await dup(stored({ status: "business-committed", pendingInvalidations: 5 })).store.acquire(request).catch((e: Error) => e.message)).toContain("expected array")
  })

  it("does not poison a receipt it can read, and never poisons rows that are not business-committed", async () => {
    const f = dup(stored({ status: "business-committed", pendingInvalidations: ["a"] }))
    await f.store.acquire(request)
    expect(f.ops.filter((op) => op.kind === "update")).toEqual([])
    const open = build((op) => { if (op.kind === "insert") throw duplicate(); if (op.kind === "select") return [stored()]; return header(0) })
    await open.store.acquire(request)
    expect(open.ops.filter((op) => op.set !== undefined && "status" in (op.set as object))).toEqual([])
  })
})

describe("MySQL idempotency store: exact statements", () => {
  it("acquire reads the existing row by scope and key, with limit 1", async () => {
    const f = build((op) => { if (op.kind === "insert") throw duplicate(); return [stored({ fingerprint: "other" })] })
    expect(await f.store.acquire(request)).toEqual({ outcome: "conflict" })
    expect(wheres(f.ops).slice(1)).toEqual([["select", "scope=? AND `key`=?", ["tenant:t1", "k1"]]])
    expect(f.ops[1]).toMatchObject({ limit: 1 })
  })

  it("takeover fences on fingerprint, status and lease age, then re-reads by scope and key", async () => {
    const taken = build((op) => { if (op.kind === "insert") throw duplicate(); if (op.kind === "select") return [stored()]; return header(1) })
    const result = await taken.store.acquire(request)
    const takeover = taken.ops.find((op) => op.kind === "update")!
    expect(result).toEqual({ outcome: "acquired", token: (takeover.set as { token: string }).token })
    expect(takeover.where).toEqual({ sql: "scope=? AND `key`=? AND fingerprint=? AND status='in-progress' AND created_at<TIMESTAMPADD(MICROSECOND,?*1000,CURRENT_TIMESTAMP(3))", params: ["tenant:t1", "k1", "fp", -30_000] })
    expect(Object.keys(takeover.set as object).sort()).toEqual(["createdAt", "token"])
    expect(render((takeover.set as { createdAt: unknown }).createdAt)).toEqual({ sql: "CURRENT_TIMESTAMP(3)", params: [] })
    const insert = taken.ops[0]!
    expect(render((insert.values as { createdAt: unknown }).createdAt)).toEqual({ sql: "CURRENT_TIMESTAMP(3)", params: [] })

    const held = build((op) => { if (op.kind === "insert") throw duplicate(); if (op.kind === "select") return [stored()]; return header(2) })
    expect(await held.store.acquire(request)).toEqual({ outcome: "in-progress" })
    expect(wheres(held.ops).slice(-1)).toEqual([["select", "scope=? AND `key`=?", ["tenant:t1", "k1"]]])
    expect(held.ops.at(-1)).toMatchObject({ limit: 1 })
  })

  it("poisons only the exact business-committed receipt it failed to interpret", async () => {
    const corrupt = stored({ status: "business-committed", token: "tk", pendingInvalidations: "{broken" })
    const first = build((op) => { if (op.kind === "insert") throw duplicate(); if (op.kind === "select") return [corrupt]; return header(1) })
    await expect(first.store.acquire(request)).rejects.toThrow("malformed JSON")
    const poison = first.ops.find((op) => op.kind === "update")!
    expect(poison.where).toEqual({ sql: "scope=? AND `key`=? AND token=? AND status='business-committed'", params: ["tenant:t1", "k1", "tk"] })
    expect(poison.set).toEqual({ status: "poisoned" })

    let reads = 0
    const second = build((op) => { if (op.kind === "insert") throw duplicate(); if (op.kind === "select") return reads++ === 0 ? [stored()] : [corrupt]; return header(0) })
    await expect(second.store.acquire(request)).rejects.toThrow("malformed JSON")
    const recheck = second.ops.filter((op) => op.kind === "update").at(-1)!
    expect(recheck.where).toEqual({ sql: "scope=? AND `key`=? AND token=? AND status='business-committed'", params: ["tenant:t1", "k1", "tk"] })
    expect(recheck.set).toEqual({ status: "poisoned" })
  })

  it("renew, abandon, complete and the commit receipt are fenced by owner token and status", async () => {
    const lease = { scope: "tenant:t1", key: "k1", fingerprint: "fp", token: "tok" }
    const { store, ops } = build(() => header(1))
    await store.renew({ ...lease, leaseDurationMs: 1_000 })
    await store.abandon(lease)
    await store.complete({ ...lease, result: { ok: 1 } })
    const params = ["tenant:t1", "k1", "fp", "tok"]
    expect(wheres(ops)).toEqual([
      ["update", "scope=? AND `key`=? AND fingerprint=? AND token=? AND status='in-progress'", params],
      ["delete", "scope=? AND `key`=? AND fingerprint=? AND token=? AND status='in-progress'", params],
      ["update", "scope=? AND `key`=? AND fingerprint=? AND token=? AND status='business-committed'", params],
    ])
    expect(Object.keys(ops[0]!.set as object)).toEqual(["createdAt"])
    expect(render((ops[0]!.set as { createdAt: unknown }).createdAt)).toEqual({ sql: "CURRENT_TIMESTAMP(3)", params: [] })
    expect(ops[2]!.set).toMatchObject({ status: "completed", pendingInvalidations: null, finalizerClaimOwner: null, finalizerClaimToken: null, finalizerClaimExpiresAt: null })
    expect(Object.keys(ops[2]!.set as object).sort()).toEqual(["completedAt", "finalizerClaimExpiresAt", "finalizerClaimOwner", "finalizerClaimToken", "pendingInvalidations", "result", "status"])
    expect(render((ops[2]!.set as { result: unknown }).result)).toEqual({ sql: "CAST(? AS JSON)", params: ['{"ok":1}'] })
    expect(render((ops[2]!.set as { completedAt: unknown }).completedAt)).toEqual({ sql: "CURRENT_TIMESTAMP(3)", params: [] })

    const scripted = createScriptedDb("mysql", () => header(1))
    const provider = createDrizzleMySqlPersistenceProvider({ db: scripted.db as never, registry: new DrizzleMySqlEntityRegistry() })
    await createDrizzleMySqlIdempotencyStore<unknown>(scripted.db as never, table as never).markCommittedInTransaction({ ...lease, resource: { entity: "Order", id: "o1", version: 0 }, invalidations: ["x"] } as never, provider)
    const receipt = scripted.ops[0]!
    expect(receipt.where).toEqual({ sql: "scope=? AND `key`=? AND fingerprint=? AND token=? AND status='in-progress'", params })
    expect(receipt.set).toMatchObject({ status: "business-committed", result: null, resourceEntity: "Order", resourceId: "o1", resourceVersion: JSON.stringify({ type: "number", value: 0 }), pendingInvalidations: '["x"]' })
    expect(Object.keys(receipt.set as object).sort()).toEqual(["completedAt", "pendingInvalidations", "resourceEntity", "resourceId", "resourceVersion", "result", "status"])
    expect(render((receipt.set as { completedAt: unknown }).completedAt)).toEqual({ sql: "CURRENT_TIMESTAMP(3)", params: [] })
  })

  it("reports the exact messages when ownership is lost, including a double match", async () => {
    const lease = { scope: "tenant:t1", key: "k1", fingerprint: "fp", token: "tok" }
    for (const affected of [0, 2]) {
      const lost = build(() => header(affected))
      await expect(lost.store.renew(lease)).rejects.toThrow("Idempotency lease renewal lost ownership")
      await expect(lost.store.complete({ ...lease, result: { ok: 1 } })).rejects.toThrow("Idempotency completion lost ownership")
      await expect(lost.store.ackClaimedInvalidation({ ...lease, claimToken: "c" })).rejects.toThrow("Idempotency invalidation claim was lost")
      await expect(lost.store.completeClaimedInvalidation({ ...lease, claimToken: "c", result: { ok: 1 } })).rejects.toThrow("Idempotency invalidation claim was lost")
      const scripted = createScriptedDb("mysql", () => header(affected))
      const provider = createDrizzleMySqlPersistenceProvider({ db: scripted.db as never, registry: new DrizzleMySqlEntityRegistry() })
      await expect(createDrizzleMySqlIdempotencyStore<unknown>(scripted.db as never, table as never).markCommittedInTransaction(lease as never, provider)).rejects.toThrow("Idempotency ownership was lost before the mutation committed")
    }
  })
})

describe("MySQL idempotency store: claiming pending invalidations", () => {
  const pending = (overrides: Record<string, unknown> = {}) => stored({ status: "business-committed", pendingInvalidations: '["tag:a"]', result: JSON.stringify({ ok: 1 }), ...overrides })
  const claimArgs = { limit: 5, claimOwner: "fin", leaseMs: 10_000, claimToken: "claim-1" }
  const unleased = "(finalizer_claim_expires_at IS NULL OR finalizer_claim_expires_at<CURRENT_TIMESTAMP(3))"

  it("selects unleased or expired committed rows and claims each under a fence", async () => {
    const { store, ops } = build((op) => (op.kind === "select" ? [pending()] : header(1)))
    const claimed = await store.claimPendingInvalidations(claimArgs)
    expect(claimed).toEqual([{ scope: "tenant:t1", key: "k1", fingerprint: "fp", token: "tok", invalidations: ["tag:a"], result: { ok: 1 }, claimToken: "claim-1", claimOwner: "fin" }])
    expect(ops[0]!.where).toEqual({ sql: `status='business-committed' AND pending_invalidations IS NOT NULL AND ${unleased}`, params: [] })
    expect(ops[0]).toMatchObject({ limit: 5 })
    const claim = ops[1]!
    expect(claim.where).toEqual({ sql: `scope=? AND \`key\`=? AND token=? AND status='business-committed' AND pending_invalidations IS NOT NULL AND ${unleased}`, params: ["tenant:t1", "k1", "tok"] })
    const set = claim.set as { finalizerClaimOwner: string; finalizerClaimToken: string; finalizerClaimExpiresAt: unknown }
    expect(set.finalizerClaimOwner).toBe("fin")
    expect(set.finalizerClaimToken).toBe("claim-1")
    expect(Object.keys(set).sort()).toEqual(["finalizerClaimExpiresAt", "finalizerClaimOwner", "finalizerClaimToken"])
    expect(render(set.finalizerClaimExpiresAt)).toEqual({ sql: "TIMESTAMPADD(MICROSECOND,?*1000,CURRENT_TIMESTAMP(3))", params: [10_000] })
  })

  it("poisons an unparsable row by its exact identity and moves on to the next row", async () => {
    const { store, ops } = build((op) => (op.kind === "select" ? [pending({ pendingInvalidations: "{x", token: "bad" }), pending({ key: "k2" })] : header(1)))
    const claimed = await store.claimPendingInvalidations(claimArgs)
    expect(claimed.map((c) => c.key)).toEqual(["k2"])
    const poison = ops.find((op) => op.kind === "update")!
    expect(poison.where).toEqual({ sql: "scope=? AND `key`=? AND token=? AND status='business-committed'", params: ["tenant:t1", "k1", "bad"] })
    expect(poison.set).toEqual({ status: "poisoned" })
  })

  it("only counts an update that affected exactly one row; ack/complete use the claim token fence", async () => {
    const two = build((op) => (op.kind === "select" ? [pending()] : header(2)))
    expect(await two.store.claimPendingInvalidations(claimArgs)).toEqual([])
    const lease = { scope: "tenant:t1", key: "k1", fingerprint: "fp", token: "tok", claimToken: "c1" }
    const { store, ops } = build(() => header(1))
    await store.ackClaimedInvalidation(lease)
    await store.completeClaimedInvalidation({ ...lease, result: { ok: 1 } })
    const fence = { sql: "scope=? AND `key`=? AND fingerprint=? AND token=? AND finalizer_claim_token=? AND status='business-committed' AND finalizer_claim_expires_at>CURRENT_TIMESTAMP(3)", params: ["tenant:t1", "k1", "fp", "tok", "c1"] }
    expect(ops.map((op) => op.where)).toEqual([fence, fence])
    expect(ops[0]!.set).toEqual({ pendingInvalidations: null, finalizerClaimOwner: null, finalizerClaimToken: null, finalizerClaimExpiresAt: null })
    expect(Object.keys(ops[1]!.set as object).sort()).toEqual(["completedAt", "finalizerClaimExpiresAt", "finalizerClaimOwner", "finalizerClaimToken", "pendingInvalidations", "result", "status"])
    expect(ops[1]!.set).toMatchObject({ status: "completed", pendingInvalidations: null })
    expect(render((ops[1]!.set as { result: unknown }).result)).toEqual({ sql: "CAST(? AS JSON)", params: ['{"ok":1}'] })
    expect(render((ops[1]!.set as { completedAt: unknown }).completedAt)).toEqual({ sql: "CURRENT_TIMESTAMP(3)", params: [] })
  })

  it("decodes string results and keeps other stored results as they are", async () => {
    const parsed = build((op) => (op.kind === "select" ? [pending({ result: '{"ok":4}' })] : header(1)))
    expect((await parsed.store.claimPendingInvalidations({ claimOwner: "fin", leaseMs: 1_000 }))[0]!.result).toEqual({ ok: 4 })
    const object = build((op) => (op.kind === "select" ? [pending({ result: { ok: 5 } })] : header(1)))
    expect((await object.store.claimPendingInvalidations({ claimOwner: "fin", leaseMs: 1_000 }))[0]!.result).toEqual({ ok: 5 })
  })
})
