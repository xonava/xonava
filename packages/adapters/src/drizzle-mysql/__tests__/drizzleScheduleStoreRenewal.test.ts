import { describe, expect, it } from "vitest"
import type { Pool } from "mysql2/promise"
import { DrizzleMySqlScheduleStore } from "../drizzleScheduleStore"

describe("MySQL schedule store lease renewal", () => {
  it("renews to the later of the current and the requested expiry, so a smaller extension never shortens a lease", async () => {
    const statements: string[] = []
    const pool = { query: async (sql: string) => { statements.push(sql); return [{ affectedRows: 1 }] } } as unknown as Pool
    const store = new DrizzleMySqlScheduleStore(pool)
    await expect(store.renewScheduleLease({ scheduleId: "s", workerId: "w", claimToken: "t", now: new Date(), extendByMs: 1_000 })).resolves.toBe(true)
    expect(statements[0]).toMatch(/SET lease_expires_at=GREATEST\(lease_expires_at,TIMESTAMPADD\(MICROSECOND,\?\*1000,CURRENT_TIMESTAMP\(3\)\)\)/)
  })
})
