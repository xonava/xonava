import { afterEach, describe, expect, it } from "vitest"
import { temporaryD1Fixture } from "./database.js"

const fixtures: Awaited<ReturnType<typeof temporaryD1Fixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.close(); await f.cleanup() } })

describe("D1 repository integration", () => {
  it("physically isolates tenants and enforces OCC", async () => {
    const f = await temporaryD1Fixture(); fixtures.push(f)
    const insert = f.db.prepare("INSERT INTO framework_records(id,tenant_id,value,version) VALUES(?,?,?,1)")
    await insert.bind("same", "tenant-a", "{\"v\":1}").run()
    await expect(insert.bind("same", "tenant-b", "{\"v\":2}").run()).rejects.toThrow()
    const update = f.db.prepare("UPDATE framework_records SET value=?,version=version+1 WHERE id=? AND tenant_id=? AND version=?")
    expect((await update.bind("{\"v\":2}", "same", "tenant-a", 1).run()).meta.changes).toBe(1)
    expect((await update.bind("{\"v\":3}", "same", "tenant-a", 1).run()).meta.changes).toBe(0)
    expect((await f.db.prepare("SELECT value FROM framework_records WHERE tenant_id=?").bind("tenant-b").all()).results).toEqual([])
  })
})
