import type { PersistenceProvider } from "core/persistence"
import { compileAggregate, runAggregateTransaction } from "core/aggregate"
import { describe, expect, it } from "vitest"
import { openPgFixture } from "./database.js"
type State = { order: { total: number }; payments: { amount: number }[] }
const aggregate = compileAggregate<State>({ key: "order.payment", version: 1, members: ["order", "payments"], invariants: [{ key: "within-total", phase: "after", check: state => state.payments.reduce((sum, item) => sum + item.amount, 0) <= state.order.total }] })
describe("aggregate PostgreSQL integration", () => {
  it("rolls back a real serializable transaction when the authoritative post-state violates an invariant", async () => {
    const root = await openPgFixture()
    try {
      await root.query("INSERT INTO framework_test.records(id,tenant_id,value) VALUES('aggregate','tenant-a',$1)", [{ order: { total: 100 }, payments: [] }])
      const provider = { dialect: "postgresql", capabilities: { interactiveTransactions: true }, repository: () => { throw new Error("unused") }, runInTransaction: async (work: (provider: PersistenceProvider) => Promise<unknown>) => { await root.query("BEGIN ISOLATION LEVEL SERIALIZABLE"); try { const scoped = { dialect: "postgresql-tx", capabilities: { interactiveTransactions: true }, repository: () => { throw new Error("unused") } } as unknown as PersistenceProvider; const result = await work(scoped); await root.query("COMMIT"); return result } catch (error) { await root.query("ROLLBACK"); throw error } } } as unknown as PersistenceProvider
      const load = async () => (await root.query("SELECT value FROM framework_test.records WHERE id='aggregate'")).rows[0]!.value as State
      await expect(runAggregateTransaction({ definition: aggregate, persistence: provider, load, mutate: async () => { await root.query("UPDATE framework_test.records SET value=$1 WHERE id='aggregate'", [{ order: { total: 100 }, payments: [{ amount: 101 }] }]) } })).rejects.toThrow(/invariant/i)
      expect(await load()).toEqual({ order: { total: 100 }, payments: [] })
    } finally { await root.end() }
  })
})
