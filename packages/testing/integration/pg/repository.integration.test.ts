import { describe, expect, it } from "vitest"
import { openPgFixture } from "./database.js"

describe("PostgreSQL repository integration", () => {
  it("isolates tenant reads and enforces OCC", async () => {
    const db = await openPgFixture()
    try {
      await db.query("INSERT INTO framework_test.records(id,tenant_id,value) VALUES($1,$2,$3)", ["r", "tenant-a", { v: 1 }])
      const ok = await db.query("UPDATE framework_test.records SET value=$1,version=version+1 WHERE id=$2 AND tenant_id=$3 AND version=$4", [{ v: 2 }, "r", "tenant-a", 1])
      const stale = await db.query("UPDATE framework_test.records SET value=$1,version=version+1 WHERE id=$2 AND tenant_id=$3 AND version=$4", [{ v: 3 }, "r", "tenant-a", 1])
      expect(ok.rowCount).toBe(1); expect(stale.rowCount).toBe(0)
      expect((await db.query("SELECT * FROM framework_test.records WHERE tenant_id='tenant-b'")).rows).toEqual([])
    } finally { await db.end() }
  })
})
