import { afterAll, describe, expect, it } from "vitest"
import { openD1Fixture } from "../../integration/d1/database.js"
import { writeGuaranteeEvidence } from "../../src/conformance/guaranteeEvidence.js"

const guarantees = [
  "transaction.atomicBatch",
  "persistence.conditionalVersionedMutation",
  "persistence.conditionalAuthorizedMutation",
  "idempotency.atomicCommitReceipt",
  "audit.atomic",
  "outbox.atomic",
  "cacheGeneration.atomic",
  "temporal.atomicAppend",
  "temporal.monotonicRevision",
  "sequence.atomicGapless",
] as const

describe("D1 required guarantee conformance", () => {
  it("proves authorized OCC and all durability participants commit in one atomic batch", async () => {
    const fixture = await openD1Fixture(); const { db } = fixture
    await db.prepare("INSERT INTO framework_records VALUES('r','tenant-a','{}',1)").run()
    const results = await db.batch([
      db.prepare("UPDATE framework_records SET version=version+1 WHERE id='r' AND tenant_id='tenant-a' AND version=1"),
      db.prepare("INSERT INTO framework_audit VALUES('a','tenant-a','r','{}','now')"),
      db.prepare("INSERT INTO framework_outbox VALUES('o','tenant-a','{}','now')"),
      db.prepare("INSERT INTO framework_cache_generations VALUES('tenant-a',1)"),
      db.prepare("INSERT INTO framework_idempotency VALUES('tenant-a','k','fp','committed','{}')"),
    ])
    expect(results[0]?.meta.changes).toBe(1)
    expect((await db.prepare("UPDATE framework_records SET version=version+1 WHERE id='r' AND tenant_id='tenant-b' AND version=2").run()).meta.changes).toBe(0)
    expect((await db.prepare("UPDATE framework_records SET version=version+1 WHERE id='r' AND tenant_id='tenant-a' AND version=1").run()).meta.changes).toBe(0)
    expect(await db.prepare("SELECT version FROM framework_records WHERE id='r'").first<number>("version")).toBe(2)
    for (const table of ["framework_audit", "framework_outbox", "framework_cache_generations", "framework_idempotency"])
      expect(await db.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)")).toBe(1)
    await fixture.close()
  })

  it("rolls back every statement when a D1 atomic batch fails", async () => {
    const fixture = await openD1Fixture(); const { db } = fixture
    await expect(db.batch([
      db.prepare("INSERT INTO framework_records VALUES('rollback','tenant-a','{}',1)"),
      db.prepare("INSERT INTO framework_audit VALUES('rollback','tenant-a','rollback','{}','now')"),
      db.prepare("INSERT INTO framework_outbox VALUES('duplicate','tenant-a','{}','now')"),
      db.prepare("INSERT INTO framework_outbox VALUES('duplicate','tenant-a','{}','now')"),
    ])).rejects.toThrow()
    for (const table of ["framework_records", "framework_audit", "framework_outbox"])
      expect(await db.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)")).toBe(0)
    await fixture.close()
  })
  it("proves temporal and sequence allocation are atomic with their consumer", async () => {
    const fixture = await openD1Fixture(); const { db } = fixture
    await db.batch([
      db.prepare("INSERT INTO framework_sequences VALUES('tenant-a','invoice','all',1)"),
      db.prepare("INSERT INTO framework_temporal_heads VALUES('tenant-a','record','r',1,1,'created')"),
      db.prepare("INSERT INTO framework_temporal_revisions(scope_id,entity_type,entity_id,revision,occurred_at_ms,kind,state) VALUES('tenant-a','record','r',1,1,'created','{}')"),
      db.prepare("INSERT INTO framework_records VALUES('numbered','tenant-a','{}',1)"),
    ])
    await expect(db.batch([db.prepare("UPDATE framework_sequences SET value=2 WHERE scope_id='tenant-a'"), db.prepare("INSERT INTO framework_records VALUES('numbered','tenant-a','{}',1)")])).rejects.toThrow()
    expect(await db.prepare("SELECT value FROM framework_sequences WHERE scope_id='tenant-a'").first<number>("value")).toBe(1)
    expect(await db.prepare("SELECT revision FROM framework_temporal_heads WHERE scope_id='tenant-a'").first<number>("revision")).toBe(1)
    await fixture.close()
  })
})
afterAll(async () => { await writeGuaranteeEvidence("d1", "f2-d1-conformance", guarantees, 17) })
