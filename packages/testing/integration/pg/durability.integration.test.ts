import { describe, expect, it } from "vitest"
import { connectPg, openPgFixture } from "./database.js"

describe("PostgreSQL durability integration", () => {
  it("reconstructs an idempotent outcome using an independent connection", async () => {
    const writer = await openPgFixture()
    try { await writer.query("INSERT INTO framework_test.idempotency(scope,key,fingerprint,status,response) VALUES('t','k','fp','committed',$1)", [{ id: "r" }]) }
    finally { await writer.end() }
    const verifier = await connectPg()
    try { expect((await verifier.query("SELECT response FROM framework_test.idempotency WHERE scope='t' AND key='k'")).rows[0].response).toEqual({ id: "r" }) }
    finally { await verifier.end() }
  })
})
