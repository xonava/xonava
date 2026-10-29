import { describe, expect, it } from "vitest"
import { ConflictError, StaleClaimError } from "@xonava/core/domain"
import { DrizzleD1JobProgressStore, DrizzleD1SequenceStore, DrizzleD1TemporalHistoryStore } from "@xonava/adapters/drizzle-d1"

interface Prepared { readonly sql: string; binds: unknown[]; ran: number }
interface Script {
  first?: (sql: string, binds: readonly unknown[]) => unknown
  all?: (sql: string, binds: readonly unknown[]) => unknown
  batch?: (statements: readonly Prepared[]) => unknown[]
}
function stub(script: Script = {}) {
  const prepared: Prepared[] = []
  const batches: (readonly Prepared[])[] = []
  const db = {
    prepare(sql: string) {
      const statement: Prepared & Record<string, unknown> = {
        sql, binds: [], ran: 0,
        bind(...values: unknown[]) { statement.binds = values; return statement },
        first: async () => (script.first ? script.first(sql, statement.binds) : null),
        all: async () => (script.all ? script.all(sql, statement.binds) : { results: [] }),
        run: async () => { statement.ran += 1; return { meta: { changes: 1 } } },
      }
      prepared.push(statement)
      return statement
    },
    batch: async (statements: readonly Prepared[]) => { batches.push(statements); return script.batch ? script.batch(statements) : [] },
  }
  return { db: db as never, raw: db, prepared, batches }
}

describe("d1 sequence store", () => {
  const scope = "fscope:v1:a" as never

  it("allocates the next value atomically and rejects anything that is not a positive safe integer", async () => {
    const ok = stub({ first: () => ({ value: 7 }) })
    expect(await new DrizzleD1SequenceStore(ok.db).next(scope, "invoice", "2026")).toBe(7)
    expect(ok.prepared[0]!.sql).toBe("INSERT INTO framework_sequences(scope_id,name,period,value) VALUES(?,?,?,1) ON CONFLICT(scope_id,name,period) DO UPDATE SET value=value+1 RETURNING value")
    expect(ok.prepared[0]!.binds).toEqual([scope, "invoice", "2026"])
    expect(await new DrizzleD1SequenceStore(stub({ first: () => ({ value: "12" }) }).db).next(scope, "n", "p")).toBe(12)
    expect(await new DrizzleD1SequenceStore(stub({ first: () => ({ value: 1 }) }).db).next(scope, "n", "p")).toBe(1)
    for (const row of [null, {}, { value: 0 }, { value: -1 }, { value: 1.5 }, { value: "x" }, { value: Number.MAX_SAFE_INTEGER + 2 }]) {
      await expect(new DrizzleD1SequenceStore(stub({ first: () => row }).db).next(scope, "n", "p")).rejects.toThrow(new Error("D1 sequence allocation failed"))
    }
  })

  it("allocates together with consumer statements in one batch and reads the allocated value back", async () => {
    const f = stub({ first: () => ({ value: 3 }) })
    const consumer = f.raw.prepare("UPDATE consumer SET n = 1") as never
    const store = new DrizzleD1SequenceStore(f.db)
    expect(await store.nextWithStatements(scope, "invoice", "2026", [consumer])).toBe(3)
    expect(f.batches).toHaveLength(1)
    expect(f.batches[0]).toHaveLength(2)
    expect(f.batches[0]![0]!.sql).toBe("INSERT INTO framework_sequences(scope_id,name,period,value) VALUES(?,?,?,1) ON CONFLICT(scope_id,name,period) DO UPDATE SET value=value+1 RETURNING value")
    expect(f.batches[0]![0]!.binds).toEqual([scope, "invoice", "2026"])
    expect(f.batches[0]![1]).toBe(consumer)
    const read = f.prepared[f.prepared.length - 1]!
    expect(read.sql).toBe("SELECT value FROM framework_sequences WHERE scope_id=? AND name=? AND period=?")
    expect(read.binds).toEqual([scope, "invoice", "2026"])
  })

  it("refuses batch allocation without batch support or consumers, and rejects an unreadable value", async () => {
    const noBatch = { prepare: () => ({ bind: () => ({}), first: async () => ({ value: 1 }) }) }
    await expect(new DrizzleD1SequenceStore(noBatch as never).nextWithStatements(scope, "n", "p", [{} as never])).rejects.toThrow(new Error("D1 sequence batch allocation is unavailable"))
    const f = stub({ first: () => ({ value: 1 }) })
    await expect(new DrizzleD1SequenceStore(f.db).nextWithStatements(scope, "n", "p", [])).rejects.toThrow(new Error("D1 sequence batch allocation requires a consumer statement"))
    expect(f.batches).toHaveLength(0)
    for (const row of [null, {}, { value: 0 }, { value: 2.5 }, { value: "x" }]) {
      const bad = stub({ first: () => row })
      await expect(new DrizzleD1SequenceStore(bad.db).nextWithStatements(scope, "n", "p", [{} as never])).rejects.toThrow(new Error("D1 sequence batch allocation failed"))
    }
    expect(await new DrizzleD1SequenceStore(stub({ first: () => ({ value: 1 }) }).db).nextWithStatements(scope, "n", "p", [{} as never])).toBe(1)
  })
})

describe("d1 job progress store", () => {
  const fence = { jobId: "j1", workerId: "w1", claimToken: "tok", attempt: 2 }
  const stored = { job_id: "j1", attempt: 2, sequence: 4, percent: 50, checkpoint: '{"cursor":3}', updated_at_ms: 5_000 }

  it("reads and maps stored progress, omitting absent percent and checkpoint", async () => {
    const full = stub({ first: () => stored })
    expect(await new DrizzleD1JobProgressStore(full.db).read("j1")).toEqual({ jobId: "j1", attempt: 2, sequence: 4, percent: 50, checkpoint: { cursor: 3 }, updatedAt: new Date(5_000).toISOString() })
    expect(full.prepared[0]).toMatchObject({ sql: "SELECT job_id,attempt,sequence,percent,checkpoint,updated_at_ms FROM framework_job_progress WHERE job_id=?", binds: ["j1"] })
    const bare = await new DrizzleD1JobProgressStore(stub({ first: () => ({ ...stored, percent: null, checkpoint: null }) }).db).read("j1")
    expect(bare).toEqual({ jobId: "j1", attempt: 2, sequence: 4, updatedAt: new Date(5_000).toISOString() })
    expect(bare).not.toHaveProperty("percent")
    expect(bare).not.toHaveProperty("checkpoint")
    const zero = await new DrizzleD1JobProgressStore(stub({ first: () => ({ ...stored, percent: 0 }) }).db).read("j1")
    expect(zero).toHaveProperty("percent", 0)
    expect(await new DrizzleD1JobProgressStore(stub({ first: () => null }).db).read("j1")).toBeNull()
  })

  it("writes under the claim fence with the next sequence and returns the stored row", async () => {
    const f = stub({ first: () => stored })
    const result = await new DrizzleD1JobProgressStore(f.db).write(fence, 3, { percent: 50, checkpoint: { cursor: 3 } })
    expect(result).toMatchObject({ sequence: 4, percent: 50 })
    expect(f.prepared[0]!.binds).toEqual([4, 50, '{"cursor":3}', "j1", "w1", "tok", 2, 3, "j1", 3])
    const bare = stub({ first: () => stored })
    await new DrizzleD1JobProgressStore(bare.db).write(fence, 0, {})
    expect(bare.prepared[0]!.binds).toEqual([1, null, null, "j1", "w1", "tok", 2, 0, "j1", 0])
  })

  it("validates progress before touching the database", async () => {
    const f = stub({ first: () => stored })
    await expect(new DrizzleD1JobProgressStore(f.db).write(fence, 0, { percent: 101 })).rejects.toThrow()
    await expect(new DrizzleD1JobProgressStore(f.db).write(fence, 0, { percent: Number.NaN })).rejects.toThrow()
    expect(f.prepared).toHaveLength(0)
  })

  it("tells a lost claim from a sequence conflict when nothing was written", async () => {
    const lost = stub({ first: (sql) => (sql.startsWith("INSERT") ? null : null) })
    await expect(new DrizzleD1JobProgressStore(lost.db).write(fence, 1, {})).rejects.toThrow(new StaleClaimError("Job progress ownership was lost"))
    expect(lost.prepared[1]!.sql).toBe("SELECT 1 AS ok FROM framework_j1_jobs WHERE id=? AND worker_id=? AND claim_token=? AND attempt=? AND lease_expires_at_ms>CAST(unixepoch('subsec')*1000 AS INTEGER)")
    expect(lost.prepared[1]!.binds).toEqual(["j1", "w1", "tok", 2])
    const conflict = stub({ first: (sql) => (sql.startsWith("INSERT") ? null : { ok: 1 }) })
    const error = await new DrizzleD1JobProgressStore(conflict.db).write(fence, 1, {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConflictError)
    expect((error as Error).message).toBe("Job progress sequence conflict")
  })
})

describe("d1 temporal history store", () => {
  const scopeId = "fscope:v1:a"
  const resource = { scopeId, entityType: "order", entityId: "o1" } as never
  const revisionRow = { scope_id: scopeId, entity_type: "order", entity_id: "o1", revision: 3, occurred_at_ms: 9_000, kind: "updated", state: '{"n":1}', entity_version: 2, event_id: "e1", audit_id: "a1" }
  const input = { scopeId, entityType: "order", entityId: "o1", occurredAt: new Date(9_000), kind: "updated", state: { n: 1 }, entityVersion: 2, eventId: "e1", auditId: "a1" } as never

  it("decodes a stored revision, omitting absent optional fields", async () => {
    const store = (row: Record<string, unknown>) => new DrizzleD1TemporalHistoryStore(stub({ batch: () => [{}, { results: [row] }] }).db)
    expect(await store(revisionRow).append(input)).toEqual({
      scopeId, entityType: "order", entityId: "o1", revision: 3, occurredAt: new Date(9_000), kind: "updated", state: { n: 1 }, entityVersion: 2, eventId: "e1", auditId: "a1",
    })
    const bare = await store({ ...revisionRow, kind: "deleted", state: null, entity_version: null, event_id: null, audit_id: null }).append(input)
    expect(bare).toEqual({ scopeId, entityType: "order", entityId: "o1", revision: 3, occurredAt: new Date(9_000), kind: "deleted", state: null })
    const missing = await store({ scope_id: scopeId, entity_type: "order", entity_id: "o1", revision: 3, occurred_at_ms: 9_000, kind: "deleted" }).append(input)
    expect(missing).toEqual({ scopeId, entityType: "order", entityId: "o1", revision: 3, occurredAt: new Date(9_000), kind: "deleted", state: null })
  })

  it("appends participant statements, the head bump and the revision insert in one batch", async () => {
    const f = stub({ batch: () => [{}, {}, { results: [revisionRow] }] })
    const participant = f.raw.prepare("UPDATE participant SET n = 1") as never
    const store = new DrizzleD1TemporalHistoryStore(f.db)
    const result = await store.appendWithStatements(input, [participant])
    expect(result.revision).toBe(3)
    const statements = f.batches[0]!
    expect(statements).toHaveLength(3)
    expect(statements[0]).toBe(participant)
    expect(statements[1]!.binds).toEqual([scopeId, "order", "o1", 9_000, "updated"])
    expect(statements[2]!.binds).toEqual([scopeId, "order", "o1", 9_000, "updated", '{"n":1}', 2, "e1", "a1", scopeId, "order", "o1"])
    const plain = stub({ batch: () => [{}, { results: [revisionRow] }] })
    await new DrizzleD1TemporalHistoryStore(plain.db).append({ ...(input as object), kind: "deleted", state: null, entityVersion: undefined, eventId: undefined, auditId: undefined } as never)
    expect(plain.batches[0]).toHaveLength(2)
    expect(plain.batches[0]![1]!.binds).toEqual([scopeId, "order", "o1", 9_000, "deleted", null, null, null, null, scopeId, "order", "o1"])
  })

  it("fails when the batch returns no revision row", async () => {
    for (const results of [[{}, {}], [{}, { results: [] }], [{}], []]) {
      const store = new DrizzleD1TemporalHistoryStore(stub({ batch: () => results }).db)
      await expect(store.append(input)).rejects.toThrow(new Error("D1 temporal append returned no revision"))
    }
  })

  it("saves snapshots idempotently and reads the latest snapshot at or before a time", async () => {
    const f = stub({ first: () => ({ revision: 3, occurred_at_ms: 9_000, state: '{"n":1}' }) })
    const store = new DrizzleD1TemporalHistoryStore(f.db)
    await store.saveSnapshot({ ...(resource as object), revision: 3, occurredAt: new Date(9_000), state: { n: 1 } } as never)
    expect(f.prepared[0]!.sql).toBe("INSERT OR IGNORE INTO framework_temporal_snapshots(scope_id,entity_type,entity_id,revision,occurred_at_ms,state) VALUES(?,?,?,?,?,?)")
    expect(f.prepared[0]!.binds).toEqual([scopeId, "order", "o1", 3, 9_000, '{"n":1}'])
    expect(f.prepared[0]!.ran).toBe(1)
    await store.saveSnapshot({ ...(resource as object), revision: 4, occurredAt: new Date(10_000), state: null } as never)
    expect(f.prepared[1]!.binds).toEqual([scopeId, "order", "o1", 4, 10_000, null])
    expect(await store.latestSnapshot(resource, new Date(20_000))).toEqual({ scopeId, entityType: "order", entityId: "o1", revision: 3, occurredAt: new Date(9_000), state: { n: 1 } })
    expect(f.prepared[2]!.binds).toEqual([scopeId, "order", "o1", 20_000])
    expect(f.prepared[2]!.sql).toContain("occurred_at_ms<=? ORDER BY revision DESC LIMIT 1")
    const nullState = new DrizzleD1TemporalHistoryStore(stub({ first: () => ({ revision: 3, occurred_at_ms: 9_000, state: null }) }).db)
    expect((await nullState.latestSnapshot(resource, new Date(20_000)))!.state).toBeNull()
    const missingState = new DrizzleD1TemporalHistoryStore(stub({ first: () => ({ revision: 3, occurred_at_ms: 9_000 }) }).db)
    expect((await missingState.latestSnapshot(resource, new Date(20_000)))!.state).toBeNull()
    expect(await new DrizzleD1TemporalHistoryStore(stub({ first: () => null }).db).latestSnapshot(resource, new Date(20_000))).toBeNull()
  })

  it("pages revisions by reading one extra row to learn whether more exist", async () => {
    const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ ...revisionRow, revision: index + 1 }))
    const page = async (count: number | undefined, limit: number) => {
      const f = stub({ all: () => (count === undefined ? {} : { results: rows(count) }) })
      const result = await new DrizzleD1TemporalHistoryStore(f.db).revisions(resource, { afterRevision: 1, asOf: new Date(20_000), limit })
      return { result, f }
    }
    const exact = await page(2, 2)
    expect(exact.result.hasMore).toBe(false)
    expect(exact.result.items.map((item) => item.revision)).toEqual([1, 2])
    expect(exact.f.prepared[0]!.binds).toEqual([scopeId, "order", "o1", 1, 20_000, 3])
    const more = await page(3, 2)
    expect(more.result.hasMore).toBe(true)
    expect(more.result.items.map((item) => item.revision)).toEqual([1, 2])
    expect((await page(0, 2)).result).toEqual({ items: [], hasMore: false })
    expect((await page(undefined, 2)).result).toEqual({ items: [], hasMore: false })
    expect((await page(1, 2)).result.hasMore).toBe(false)
  })
})
