import { afterAll, describe, expect, it } from "vitest"
import { connectPg, openPgFixture } from "../../integration/pg/database.js"
import { writeGuaranteeEvidence } from "../../src/conformance/guaranteeEvidence.js"

const guarantees = [
  "transaction.interactive",
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

describe("PostgreSQL required guarantee conformance", () => {
  it("proves authorized OCC and all durability participants commit atomically", async () => {
    const db = await openPgFixture()
    try {
      await db.query("INSERT INTO framework_test.records(id,tenant_id,value) VALUES('r','tenant-a','{}')")
      await db.query("BEGIN")
      expect((await db.query("UPDATE framework_test.records SET version=version+1 WHERE id='r' AND tenant_id='tenant-a' AND version=1")).rowCount).toBe(1)
      await db.query("INSERT INTO framework_test.audit(id,tenant_id,record_id,payload) VALUES('a','tenant-a','r','{}')")
      await db.query("INSERT INTO framework_test.outbox(id,tenant_id,payload) VALUES('o','tenant-a','{}')")
      await db.query("INSERT INTO framework_test.cache_generations(scope,generation) VALUES('tenant-a',1)")
      await db.query("INSERT INTO framework_test.idempotency(scope,key,fingerprint,status,response) VALUES('tenant-a','k','fp','committed','{}')")
      await db.query("COMMIT")
      expect((await db.query("UPDATE framework_test.records SET version=version+1 WHERE id='r' AND tenant_id='tenant-b' AND version=2")).rowCount).toBe(0)
      expect((await db.query("UPDATE framework_test.records SET version=version+1 WHERE id='r' AND tenant_id='tenant-a' AND version=1")).rowCount).toBe(0)
    } finally { await db.end() }
    const verifier = await connectPg()
    try {
      expect((await verifier.query("SELECT version FROM framework_test.records WHERE id='r'")).rows).toEqual([{ version: 2 }])
      for (const table of ["audit", "outbox", "cache_generations", "idempotency"])
        expect(Number((await verifier.query(`SELECT count(*) n FROM framework_test.${table}`)).rows[0].n)).toBe(1)
    } finally { await verifier.end() }
  })

  it("rolls back every participant when an interactive transaction fails", async () => {
    const db = await openPgFixture()
    try {
      await db.query("BEGIN")
      await db.query("INSERT INTO framework_test.records(id,tenant_id,value) VALUES('rollback','tenant-a','{}')")
      await db.query("INSERT INTO framework_test.audit(id,tenant_id,record_id,payload) VALUES('rollback','tenant-a','rollback','{}')")
      await db.query("INSERT INTO framework_test.outbox(id,tenant_id,payload) VALUES('duplicate','tenant-a','{}')")
      await expect(db.query("INSERT INTO framework_test.outbox(id,tenant_id,payload) VALUES('duplicate','tenant-a','{}')")).rejects.toThrow()
      await db.query("ROLLBACK")
      for (const table of ["records", "audit", "outbox"])
        expect(Number((await db.query(`SELECT count(*) n FROM framework_test.${table}`)).rows[0].n)).toBe(0)
    } finally { await db.end() }
  })
  it("proves temporal and sequence allocation share the consumer transaction", async () => {
    const db = await openPgFixture()
    try {
      await db.query("BEGIN")
      await db.query("INSERT INTO framework_test.sequences VALUES('tenant-a','invoice','all',1)")
      await db.query("INSERT INTO framework_test.temporal_heads VALUES('tenant-a','record','numbered',1,'2026-01-01','created')")
      await db.query("INSERT INTO framework_test.temporal_revisions(scope_id,entity_type,entity_id,revision,occurred_at,kind,state) VALUES('tenant-a','record','numbered',1,'2026-01-01','created','{}')")
      await db.query("INSERT INTO framework_test.records(id,tenant_id,value) VALUES('numbered','tenant-a','{}')")
      await db.query("COMMIT")
      await db.query("BEGIN")
      await db.query("UPDATE framework_test.sequences SET value=2 WHERE scope_id='tenant-a'")
      await expect(db.query("INSERT INTO framework_test.records(id,tenant_id,value) VALUES('numbered','tenant-a','{}')")).rejects.toThrow()
      await db.query("ROLLBACK")
      expect(Number((await db.query("SELECT value FROM framework_test.sequences WHERE scope_id='tenant-a'")).rows[0].value)).toBe(1)
      expect(Number((await db.query("SELECT revision FROM framework_test.temporal_heads WHERE scope_id='tenant-a'")).rows[0].revision)).toBe(1)
    } finally { await db.end() }
  })
})
afterAll(async () => { await writeGuaranteeEvidence("pg", "f2-pg-conformance", guarantees, 17) })
