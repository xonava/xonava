import { describe, expect, it, vi } from "vitest"
import { DrizzleMySqlJobStore } from "../drizzleJobStore"

type Query = { sql: string; params: unknown[] }

function createPool(affectedRows = 1) {
  const queries: Query[] = []
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params })
    return [{ affectedRows }, undefined]
  })
  const getConnection = vi.fn()
  return { pool: { query, getConnection } as never, queries, getConnection }
}

describe("MySQL job store guards found by the real-database differential", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("claimDue with limit %s claims nothing and opens no transaction (LIMIT -1 is a syntax error)", async (limit) => {
    const { pool, queries, getConnection } = createPool()
    const store = new DrizzleMySqlJobStore(pool, { executionHistory: "best_effort" })
    await expect(store.claimDue({ requester: { scope: "system" }, workerId: "w", leaseDurationMs: 1_000, limit })).resolves.toEqual([])
    expect(getConnection).not.toHaveBeenCalled()
    expect(queries).toEqual([])
  })

  it("renewLease keeps the later of the current and the renewed expiry, so a renewal never shortens a lease", async () => {
    const { pool, queries } = createPool()
    const store = new DrizzleMySqlJobStore(pool, { executionHistory: "best_effort" })
    await store.renewLease({ jobId: "j", workerId: "w", claimToken: "t", extendByMs: 1_000 })
    expect(queries[0]!.sql).toContain("GREATEST(lease_expires_at,")
  })

  it("cancel only touches jobs that are not already terminal (succeeded, failed, cancelled, dead_letter)", async () => {
    const { pool, queries } = createPool(0)
    const store = new DrizzleMySqlJobStore(pool, { executionHistory: "best_effort" })
    await expect(store.cancel({ jobId: "j", requester: { scope: "system" } })).resolves.toEqual({ applied: false, reason: "INVALID_STATE" })
    expect(queries[0]!.sql).toContain("status NOT IN ('succeeded','failed','cancelled','dead_letter')")
  })
})
