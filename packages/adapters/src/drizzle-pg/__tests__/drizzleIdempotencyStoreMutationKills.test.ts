import { describe, expect, it } from "vitest"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import { createDrizzlePgIdempotencyStore } from "../drizzleIdempotencyStore"
import { createDrizzlePersistenceProvider, DrizzleEntityRegistry } from "../drizzlePersistenceProvider"
import { createScriptedDb, renderSql, type ScriptedHandler, type ScriptedOp } from "../../__tests__/support/scriptedDb"

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
const nowSql = (value: unknown) => renderSql("pg", value)
const norm = (sql: string | undefined) => sql?.replace(/\s+/g, " ")
const wheres = (ops: ScriptedOp[]) => ops.map((op) => [op.kind, norm(op.where?.sql), op.where?.params])

describe("idempotency store: unique violation detection", () => {
  it("finds the code up to five causes deep and no deeper", async () => {
    const chain = (depth: number): unknown => {
      let error: unknown = duplicate()
      for (let i = 0; i < depth; i++) error = new Error(`wrap${i}`, { cause: error })
      return error
    }
    const found = build((op) => { if (op.kind === "insert") throw chain(4); return [stored({ status: "completed", result: JSON.stringify({ ok: 1 }) })] })
    expect(await found.store.acquire(request)).toEqual({ outcome: "replay", result: { ok: 1 } })
    const tooDeep = chain(5)
    const deep = build((op) => { if (op.kind === "insert") throw tooDeep; return [stored({ status: "completed", result: JSON.stringify({ ok: 9 }) })] })
    await expect(deep.store.acquire(request)).rejects.toBe(tooDeep)
    expect(deep.ops.map((op) => op.kind)).toEqual(["insert"])
  })

  it("rethrows other database errors without looking the key up", async () => {
    const boom = Object.assign(new Error("boom"), { code: "XX000" })
    const f = build((op) => { if (op.kind === "insert") throw boom; return [stored()] })
    await expect(f.store.acquire(request)).rejects.toBe(boom)
    expect(f.ops.map((op) => op.kind)).toEqual(["insert"])
  })

  it("ignores a non-string code and keeps walking the cause chain", async () => {
    const error = Object.assign(new Error("outer"), { code: 23505, cause: duplicate() })
    const found = build((op) => { if (op.kind === "insert") throw error; return [stored({ status: "completed", result: JSON.stringify({ ok: 2 }) })] })
    expect(await found.store.acquire(request)).toEqual({ outcome: "replay", result: { ok: 2 } })
    const numeric = Object.assign(new Error("numeric"), { code: 23505 })
    await expect(build((op) => { if (op.kind === "insert") throw numeric; return [] }).store.acquire(request)).rejects.toBe(numeric)
  })

  it("rethrows thrown primitives and causes that are not objects unchanged", async () => {
    for (const thrown of ["plain string", 42, null, undefined]) {
      await expect(build((op) => { if (op.kind === "insert") throw thrown; return [] }).store.acquire(request)).rejects.toBe(thrown)
    }
    const stringCause = new Error("x", { cause: "text" })
    await expect(build((op) => { if (op.kind === "insert") throw stringCause; return [] }).store.acquire(request)).rejects.toBe(stringCause)
    const noCode = Object.create(null) as Record<string, unknown>
    await expect(build((op) => { if (op.kind === "insert") throw noCode; return [] }).store.acquire(request)).rejects.toBe(noCode)
  })
})

describe("idempotency store: exact statements", () => {
  it("acquire inserts the reservation, then reads the existing row by scope and key", async () => {
    const fresh = build(() => affected(1))
    const result = await fresh.store.acquire(request)
    expect(result).toEqual({ outcome: "acquired", token: (fresh.ops[0]!.values as { token: string }).token })
    expect(fresh.ops[0]!.values).toMatchObject({ scope: "tenant:t1", key: "k1", fingerprint: "fp", status: "in-progress", result: null })
    const dup = build((op) => { if (op.kind === "insert") throw duplicate(); if (op.kind === "select") return [stored({ fingerprint: "other" })]; return affected(1) })
    expect(await dup.store.acquire(request)).toEqual({ outcome: "conflict" })
    expect(wheres(dup.ops).slice(1)).toEqual([["select", "scope = $1 AND key = $2", ["tenant:t1", "k1"]]])
    expect(dup.ops[1]).toMatchObject({ limit: 1 })
  })

  it("takeover updates with a lease-age fence and re-reads by scope and key", async () => {
    const taken = build((op) => { if (op.kind === "insert") throw duplicate(); if (op.kind === "select") return [stored()]; return affected(1) })
    const result = await taken.store.acquire(request)
    const takeover = taken.ops.find((op) => op.kind === "update")!
    expect(result).toEqual({ outcome: "acquired", token: (takeover.set as { token: string }).token })
    expect(norm(takeover.where!.sql)).toBe("scope = $1 AND key = $2 AND fingerprint = $3 AND status = 'in-progress' AND created_at < now() - ($4 * interval '1 millisecond')")
    expect(takeover.where!.params).toEqual(["tenant:t1", "k1", "fp", 30_000])
    expect(Object.keys(takeover.set as object).sort()).toEqual(["createdAt", "token"])
    const held = build((op) => { if (op.kind === "insert") throw duplicate(); if (op.kind === "select") return [stored()]; return affected(2) })
    expect(await held.store.acquire(request)).toEqual({ outcome: "in-progress" })
    expect(wheres(held.ops).slice(-1)).toEqual([["select", "scope = $1 AND key = $2", ["tenant:t1", "k1"]]])
    expect(held.ops.at(-1)).toMatchObject({ limit: 1 })
  })

  it("poisons only the exact business-committed receipt it failed to interpret", async () => {
    const corrupt = stored({ status: "business-committed", token: "tk", pendingInvalidations: "{broken" })
    const first = build((op) => { if (op.kind === "insert") throw duplicate(); if (op.kind === "select") return [corrupt]; return affected(1) })
    await expect(first.store.acquire(request)).rejects.toThrow("malformed JSON")
    const poison = first.ops.find((op) => op.kind === "update")!
    expect(norm(poison.where!.sql)).toBe("scope = $1 AND key = $2 AND token = $3 AND status = 'business-committed'")
    expect(poison.where!.params).toEqual(["tenant:t1", "k1", "tk"])

    let reads = 0
    const second = build((op) => { if (op.kind === "insert") throw duplicate(); if (op.kind === "select") return reads++ === 0 ? [stored()] : [corrupt]; return affected(0) })
    await expect(second.store.acquire(request)).rejects.toThrow("malformed JSON")
    const recheck = second.ops.filter((op) => op.kind === "update").at(-1)!
    expect(norm(recheck.where!.sql)).toBe("scope = $1 AND key = $2 AND token = $3 AND status = 'business-committed'")
    expect(recheck.where!.params).toEqual(["tenant:t1", "k1", "tk"])
    expect(recheck.set).toEqual({ status: "poisoned" })
  })

  it("renew, abandon, complete and the commit receipt are fenced by owner token and status", async () => {
    const lease = { scope: "tenant:t1", key: "k1", fingerprint: "fp", token: "tok" }
    const { store, ops } = build(() => affected(1))
    await store.renew({ ...lease, leaseDurationMs: 1_000 })
    await store.abandon!(lease)
    await store.complete({ ...lease, result: { ok: 1 } })
    expect(wheres(ops)).toEqual([
      ["update", "scope = $1 AND key = $2 AND fingerprint = $3 AND token = $4 AND status = 'in-progress'", ["tenant:t1", "k1", "fp", "tok"]],
      ["delete", "scope = $1 AND key = $2 AND fingerprint = $3 AND token = $4 AND status = 'in-progress'", ["tenant:t1", "k1", "fp", "tok"]],
      ["update", "scope = $1 AND key = $2 AND fingerprint = $3 AND token = $4 AND status = 'business-committed'", ["tenant:t1", "k1", "fp", "tok"]],
    ])
    expect(Object.keys(ops[0]!.set as object)).toEqual(["createdAt"])
    expect(ops[2]!.set).toMatchObject({ status: "completed", result: '{"ok":1}', pendingInvalidations: null, finalizerClaimOwner: null, finalizerClaimToken: null, finalizerClaimExpiresAt: null })
    expect(Object.keys(ops[2]!.set as object).sort()).toEqual(["completedAt", "finalizerClaimExpiresAt", "finalizerClaimOwner", "finalizerClaimToken", "pendingInvalidations", "result", "status"])

    const scripted = createScriptedDb("pg", () => affected(1))
    const provider = createDrizzlePersistenceProvider({ db: scripted.db as never, registry: new DrizzleEntityRegistry() })
    await createDrizzlePgIdempotencyStore<unknown>(scripted.db as never, table).markCommittedInTransaction({ ...lease, resource: { entity: "Order", id: "o1", version: 2 }, invalidations: ["x"] } as never, provider)
    const receipt = scripted.ops[0]!
    expect(norm(receipt.where!.sql)).toBe("scope = $1 AND key = $2 AND fingerprint = $3 AND token = $4 AND status = 'in-progress'")
    expect(receipt.where!.params).toEqual(["tenant:t1", "k1", "fp", "tok"])
    expect(receipt.set).toMatchObject({ status: "business-committed", result: null, resourceEntity: "Order", resourceId: "o1", pendingInvalidations: '["x"]' })
    expect(Object.keys(receipt.set as object).sort()).toEqual(["completedAt", "pendingInvalidations", "resourceEntity", "resourceId", "resourceVersion", "result", "status"])
    const scriptedBare = createScriptedDb("pg", () => affected(1))
    const bareProvider = createDrizzlePersistenceProvider({ db: scriptedBare.db as never, registry: new DrizzleEntityRegistry() })
    await createDrizzlePgIdempotencyStore<unknown>(scriptedBare.db as never, table).markCommittedInTransaction({ ...lease, resource: { entity: "Order", id: "o1", version: null } } as never, bareProvider)
    expect(scriptedBare.ops[0]!.set).toMatchObject({ resourceId: "o1", resourceVersion: null })
    const zero = createScriptedDb("pg", () => affected(1))
    const zeroProvider = createDrizzlePersistenceProvider({ db: zero.db as never, registry: new DrizzleEntityRegistry() })
    await createDrizzlePgIdempotencyStore<unknown>(zero.db as never, table).markCommittedInTransaction({ ...lease, resource: { entity: "Order", id: "o1", version: 0 } } as never, zeroProvider)
    expect(zero.ops[0]!.set).toMatchObject({ resourceVersion: JSON.stringify({ type: "number", value: 0 }) })
  })

  it("reports the exact messages when ownership is lost", async () => {
    const lease = { scope: "tenant:t1", key: "k1", fingerprint: "fp", token: "tok" }
    const lost = build(() => affected(0))
    await expect(lost.store.renew(lease)).rejects.toThrow("Idempotency lease renewal lost ownership")
    await expect(lost.store.complete({ ...lease, result: 1 as never })).rejects.toThrow("Idempotency completion lost ownership of the reservation")
    await expect(lost.store.ackClaimedInvalidation({ ...lease, claimToken: "c" })).rejects.toThrow("Idempotency ack claimed invalidations lost ownership or lease expired")
    await expect(lost.store.completeClaimedInvalidation({ ...lease, claimToken: "c", result: { ok: 1 } })).rejects.toThrow("Idempotency complete claimed invalidations lost ownership or lease expired")
    const scripted = createScriptedDb("pg", () => affected(0))
    const provider = createDrizzlePersistenceProvider({ db: scripted.db as never, registry: new DrizzleEntityRegistry() })
    await expect(createDrizzlePgIdempotencyStore<unknown>(scripted.db as never, table).markCommittedInTransaction(lease as never, provider))
      .rejects.toThrow("Idempotency ownership was lost before the mutation committed")
    const two = build(() => affected(2))
    await expect(two.store.renew(lease)).rejects.toThrow("lost ownership")
  })
})

describe("idempotency store: claiming pending invalidations", () => {
  const pending = (overrides: Record<string, unknown> = {}) => stored({ status: "business-committed", pendingInvalidations: '["tag:a"]', result: JSON.stringify({ ok: 1 }), ...overrides })
  const claimArgs = { limit: 5, claimOwner: "fin", leaseMs: 10_000, claimToken: "claim-1" }

  it("selects unleased or expired committed rows and claims each under a fence", async () => {
    const { store, ops } = build((op) => (op.kind === "select" ? [pending()] : affected(1)))
    const claimed = await store.claimPendingInvalidations(claimArgs)
    expect(claimed).toEqual([{ scope: "tenant:t1", key: "k1", fingerprint: "fp", token: "tok", invalidations: ["tag:a"], result: { ok: 1 }, claimToken: "claim-1", claimOwner: "fin" }])
    expect(norm(ops[0]!.where!.sql)).toBe("status = 'business-committed' AND pending_invalidations IS NOT NULL AND (finalizer_claim_expires_at IS NULL OR finalizer_claim_expires_at < now())")
    expect(ops[0]!.where!.params).toEqual([])
    const claim = ops[1]!
    expect(norm(claim.where!.sql)).toBe("scope = $1 AND key = $2 AND token = $3 AND status = 'business-committed' AND pending_invalidations IS NOT NULL AND (finalizer_claim_expires_at IS NULL OR finalizer_claim_expires_at < now())")
    expect(claim.where!.params).toEqual(["tenant:t1", "k1", "tok"])
    const set = claim.set as { finalizerClaimOwner: string; finalizerClaimToken: string }
    expect(set.finalizerClaimOwner).toBe("fin")
    expect(set.finalizerClaimToken).toBe("claim-1")
    expect(Object.keys(set).sort()).toEqual(["finalizerClaimExpiresAt", "finalizerClaimOwner", "finalizerClaimToken"])
  })

  it("poisons an unparsable row by its exact identity and moves on to the next row", async () => {
    const { store, ops } = build((op) => (op.kind === "select" ? [pending({ pendingInvalidations: "{x", token: "bad" }), pending({ key: "k2" })] : affected(1)))
    const claimed = await store.claimPendingInvalidations(claimArgs)
    expect(claimed.map((c) => c.key)).toEqual(["k2"])
    const poison = ops.find((op) => op.kind === "update")!
    expect(norm(poison.where!.sql)).toBe("scope = $1 AND key = $2 AND token = $3 AND status = 'business-committed'")
    expect(poison.where!.params).toEqual(["tenant:t1", "k1", "bad"])
    expect(poison.set).toEqual({ status: "poisoned" })
  })

  it("only counts an update that affected exactly one row, and ack/complete use the claim token fence", async () => {
    const two = build((op) => (op.kind === "select" ? [pending()] : affected(2)))
    expect(await two.store.claimPendingInvalidations(claimArgs)).toEqual([])
    const lease = { scope: "tenant:t1", key: "k1", fingerprint: "fp", token: "tok", claimToken: "c1" }
    const { store, ops } = build(() => affected(1))
    await store.ackClaimedInvalidation(lease)
    await store.completeClaimedInvalidation({ ...lease, result: { ok: 1 } })
    expect(wheres(ops)).toEqual([
      ["update", "scope = $1 AND key = $2 AND fingerprint = $3 AND token = $4 AND finalizer_claim_token = $5 AND status = 'business-committed' AND finalizer_claim_expires_at > now()", ["tenant:t1", "k1", "fp", "tok", "c1"]],
      ["update", "scope = $1 AND key = $2 AND fingerprint = $3 AND token = $4 AND finalizer_claim_token = $5 AND status = 'business-committed' AND finalizer_claim_expires_at > now()", ["tenant:t1", "k1", "fp", "tok", "c1"]],
    ])
    expect(Object.keys(ops[0]!.set as object).sort()).toEqual(["finalizerClaimExpiresAt", "finalizerClaimOwner", "finalizerClaimToken", "pendingInvalidations"])
    expect(ops[1]!.set).toMatchObject({ status: "completed", result: '{"ok":1}', pendingInvalidations: null })
    expect(Object.keys(ops[1]!.set as object).sort()).toEqual(["completedAt", "finalizerClaimExpiresAt", "finalizerClaimOwner", "finalizerClaimToken", "pendingInvalidations", "result", "status"])
  })
})

describe("idempotency store: database clock expressions and result decoding", () => {
  it("stamps timestamps and lease expiry with the database clock", async () => {
    const lease = { scope: "tenant:t1", key: "k1", fingerprint: "fp", token: "tok" }
    const taken = build((op) => { if (op.kind === "insert") throw duplicate(); if (op.kind === "select") return [stored()]; return affected(1) })
    await taken.store.acquire(request)
    const takeover = taken.ops.find((op) => op.kind === "update")!
    expect(nowSql((takeover.set as { createdAt: unknown }).createdAt)).toMatchObject({ sql: "now()", params: [] })

    const f = build(() => affected(1))
    await f.store.renew({ ...lease, leaseDurationMs: 1_000 })
    await f.store.complete({ ...lease, result: { ok: 1 } })
    await f.store.completeClaimedInvalidation({ ...lease, claimToken: "c", result: { ok: 1 } })
    expect(nowSql((f.ops[0]!.set as { createdAt: unknown }).createdAt)).toMatchObject({ sql: "now()", params: [] })
    expect(nowSql((f.ops[1]!.set as { completedAt: unknown }).completedAt)).toMatchObject({ sql: "now()", params: [] })
    expect(nowSql((f.ops[2]!.set as { completedAt: unknown }).completedAt)).toMatchObject({ sql: "now()", params: [] })

    const scripted = createScriptedDb("pg", () => affected(1))
    const provider = createDrizzlePersistenceProvider({ db: scripted.db as never, registry: new DrizzleEntityRegistry() })
    await createDrizzlePgIdempotencyStore<unknown>(scripted.db as never, table).markCommittedInTransaction(lease as never, provider)
    expect(nowSql((scripted.ops[0]!.set as { completedAt: unknown }).completedAt)).toMatchObject({ sql: "now()", params: [] })

    const claim = build((op) => (op.kind === "select" ? [stored({ status: "business-committed", pendingInvalidations: '["a"]' })] : affected(1)))
    await claim.store.claimPendingInvalidations({ claimOwner: "fin", leaseMs: 7_000 })
    expect(nowSql((claim.ops[1]!.set as { finalizerClaimExpiresAt: unknown }).finalizerClaimExpiresAt)).toEqual({ sql: "now() + ($1 * interval '1 millisecond')", params: [7_000] })
  })

  it("decodes only string results and treats any other stored result as absent", async () => {
    const pending = (result: unknown) => stored({ status: "business-committed", pendingInvalidations: '["a"]', result })
    for (const result of [5, true, { ok: 1 }, undefined]) {
      const f = build((op) => (op.kind === "select" ? [pending(result)] : affected(1)))
      const claimed = await f.store.claimPendingInvalidations({ claimOwner: "fin", leaseMs: 1_000 })
      expect(claimed.map((c) => c.result)).toEqual([null])
    }
    const parsed = build((op) => (op.kind === "select" ? [pending('{"ok":4}')] : affected(1)))
    expect((await parsed.store.claimPendingInvalidations({ claimOwner: "fin", leaseMs: 1_000 }))[0]!.result).toEqual({ ok: 4 })
  })
})
