import { describe, expect, it } from "vitest"
import { connectPg, openPgFixture } from "./database.js"

describe("PostgreSQL real two-connection races", () => {
  it("allows only one stale OCC writer", async () => {
    const a = await openPgFixture(); const b = await connectPg(); const verifier = await connectPg()
    try {
      await a.query("INSERT INTO framework_test.records(id,tenant_id,value) VALUES('r','t','{}')")
      const [x, y] = await Promise.all([
        a.query("UPDATE framework_test.records SET version=version+1 WHERE id='r' AND tenant_id='t' AND version=1"),
        b.query("UPDATE framework_test.records SET version=version+1 WHERE id='r' AND tenant_id='t' AND version=1"),
      ])
      expect((x.rowCount ?? 0) + (y.rowCount ?? 0)).toBe(1)
      const row = await verifier.query("SELECT version FROM framework_test.records WHERE id='r' AND tenant_id='t'")
      expect(row.rows).toEqual([{ version: 2 }])
    } finally { await a.end(); await b.end(); await verifier.end() }
  })
  it("allows only one finalizer claim", async () => {
    const a = await openPgFixture(); const b = await connectPg(); const verifier = await connectPg()
    try {
      const sql = "INSERT INTO framework_test.finalizers(finalizer_key,owner,fence,state) VALUES('x',$1,$2,'claimed') ON CONFLICT DO NOTHING RETURNING owner, fence"
      const [x, y] = await Promise.all([a.query(sql, ["a", 1]), b.query(sql, ["b", 2])])
      expect(x.rows.length + y.rows.length).toBe(1)
      const rows = (await verifier.query("SELECT owner, fence FROM framework_test.finalizers WHERE finalizer_key='x'")).rows
      expect(rows).toHaveLength(1)
      expect(rows[0]).toEqual((x.rows[0] ?? y.rows[0]))
      const loser = rows[0].owner === "a" ? { owner: "b", fence: 2 } : { owner: "a", fence: 1 }
      expect((await verifier.query("UPDATE framework_test.finalizers SET state='done' WHERE finalizer_key='x' AND owner=$1 AND fence=$2", [loser.owner, loser.fence])).rowCount).toBe(0)
      expect((await verifier.query("UPDATE framework_test.finalizers SET state='done' WHERE finalizer_key='x' AND owner=$1 AND fence=$2", [rows[0].owner, rows[0].fence])).rowCount).toBe(1)
    } finally { await a.end(); await b.end(); await verifier.end() }
  })
})
