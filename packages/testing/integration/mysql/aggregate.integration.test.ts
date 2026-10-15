import type { PersistenceProvider } from "@xonava/core/persistence"
import { compileAggregate, runAggregateTransaction } from "@xonava/core/aggregate"
import { describe, expect, it } from "vitest"
import { openMySqlFixture } from "./database.js"
type State = { order: { total: number }; payments: { amount: number }[] }
const aggregate = compileAggregate<State>({ key: "order.payment", version: 1, members: ["order", "payments"], invariants: [{ key: "within-total", phase: "after", check: state => state.payments.reduce((sum, item) => sum + item.amount, 0) <= state.order.total }] })
describe("aggregate MySQL integration", () => {
  it("rolls back a real serializable transaction when the authoritative post-state violates an invariant", async () => {
    const { pool } = await openMySqlFixture()
    try {
      await pool.query("INSERT INTO records(id,tenant_id,name,version,value) VALUES('aggregate','tenant-a','aggregate',1,?)", [JSON.stringify({ order: { total: 100 }, payments: [] })])
      const connection = await pool.getConnection()
      const provider = { dialect: "mysql", capabilities: { interactiveTransactions: true }, repository: () => { throw new Error("unused") }, runInTransaction: async (work: (provider: PersistenceProvider) => Promise<unknown>) => { await connection.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"); await connection.beginTransaction(); try { const scoped = { dialect: "mysql-tx", capabilities: { interactiveTransactions: true }, repository: () => { throw new Error("unused") } } as unknown as PersistenceProvider; const result = await work(scoped); await connection.commit(); return result } catch (error) { await connection.rollback(); throw error } } } as unknown as PersistenceProvider
      const load = async () => { const [rows] = await connection.query("SELECT value FROM records WHERE id='aggregate'"); const value = (rows as { value: State | string }[])[0]!.value; return typeof value === "string" ? JSON.parse(value) as State : value }
      await expect(runAggregateTransaction({ definition: aggregate, persistence: provider, load, mutate: async () => { await connection.query("UPDATE records SET value=? WHERE id='aggregate'", [JSON.stringify({ order: { total: 100 }, payments: [{ amount: 101 }] })]) } })).rejects.toThrow(/invariant/i)
      const [rows] = await pool.query("SELECT value FROM records WHERE id='aggregate'"); const value = (rows as { value: State | string }[])[0]!.value; expect(typeof value === "string" ? JSON.parse(value) : value).toEqual({ order: { total: 100 }, payments: [] })
      connection.release()
    } finally { await pool.end() }
  })
})
