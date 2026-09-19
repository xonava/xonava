import { describe, expect, it } from "vitest"
import { openD1Fixture } from "./database.js"

describe("D1 certified atomic batch", () => {
  it("rolls back all durability participants on failure", async () => {
    const fixture = await openD1Fixture(); const { db } = fixture
    await expect(db.batch([
      db.prepare("INSERT INTO framework_records VALUES('r','t','{}',1)"),
      db.prepare("INSERT INTO framework_audit VALUES('a','t','r','{}','now')"),
      db.prepare("INSERT INTO framework_outbox VALUES('o','t','{}','now')"),
      db.prepare("INSERT INTO framework_idempotency VALUES('t','k','fp','committed','{}')"),
      db.prepare("INSERT INTO framework_outbox VALUES('o','t','{}','now')"),
    ])).rejects.toThrow()
    for (const table of ["framework_records", "framework_audit", "framework_outbox", "framework_idempotency"])
      expect(await db.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)")).toBe(0)
    await fixture.close()
  })

  it("commits business, audit, outbox, cache and receipt atomically", async () => {
    const fixture = await openD1Fixture(); const { db } = fixture
    await db.batch([
      db.prepare("INSERT INTO framework_records VALUES('r','t','{}',1)"),
      db.prepare("INSERT INTO framework_audit VALUES('a','t','r','{}','now')"),
      db.prepare("INSERT INTO framework_outbox VALUES('o','t','{}','now')"),
      db.prepare("INSERT INTO framework_cache_generations VALUES('t',1)"),
      db.prepare("INSERT INTO framework_idempotency VALUES('t','k','fp','committed','{\"ok\":true}')"),
    ])
    expect(await db.prepare("SELECT count(*) FROM framework_records").first<number>("count(*)")).toBe(1)
    expect(await db.prepare("SELECT generation FROM framework_cache_generations WHERE scope='t'").first<number>("generation")).toBe(1)
    await fixture.close()
  })
})
