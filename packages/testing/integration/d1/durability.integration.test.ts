import { describe, expect, it } from "vitest"
import { openD1Fixture, temporaryD1Fixture } from "./database.js"

describe("D1 durable reconstruction", () => {
  it("reconstructs committed receipt from a fresh database handle", async () => {
    const f = await temporaryD1Fixture()
    await f.db.prepare("INSERT INTO framework_idempotency VALUES(?,?,?,?,?)").bind("t", "k", "fp", "committed", "{\"id\":\"r\"}").run()
    await f.close()
    const verifier = await openD1Fixture(f.persistPath)
    expect(await verifier.db.prepare("SELECT response FROM framework_idempotency WHERE scope=? AND key=?").bind("t", "k").first()).toEqual({ response: "{\"id\":\"r\"}" })
    await verifier.close(); await f.cleanup()
  })
  it("rejects conflicting outbox replay", async () => {
    const fixture = await openD1Fixture(); const { db } = fixture
    await db.prepare("INSERT INTO framework_outbox VALUES(?,?,?,?)").bind("event", "t", "{\"x\":1}", "now").run()
    await expect(db.prepare("INSERT INTO framework_outbox VALUES(?,?,?,?)").bind("event", "t", "{\"x\":2}", "now").run()).rejects.toThrow()
    await fixture.close()
  })
})
