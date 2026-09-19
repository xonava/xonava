import { describe, expect, it } from "vitest"
import { openPgFixture } from "./database.js"

describe("PostgreSQL transaction integration", () => {
  it("rolls back business, audit, outbox, cache and receipt together", async () => {
    const db = await openPgFixture()
    try {
      await db.query("BEGIN")
      await db.query("INSERT INTO framework_test.records(id,tenant_id,value) VALUES('r','t','{}')")
      await db.query("INSERT INTO framework_test.audit(id,tenant_id,record_id,payload) VALUES('a','t','r','{}')")
      await db.query("INSERT INTO framework_test.outbox(id,tenant_id,payload) VALUES('o','t','{}')")
      await db.query("INSERT INTO framework_test.cache_generations(scope,generation) VALUES('t',1)")
      await db.query("INSERT INTO framework_test.idempotency(scope,key,fingerprint,status) VALUES('t','k','fp','committed')")
      await db.query("ROLLBACK")
      for (const table of ["records", "audit", "outbox", "cache_generations", "idempotency"])
        expect(Number((await db.query(`SELECT count(*) n FROM framework_test.${table}`)).rows[0].n)).toBe(0)
    } finally { await db.end() }
  })
})
