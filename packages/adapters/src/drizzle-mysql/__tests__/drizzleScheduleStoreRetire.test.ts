import { describe, expect, it } from "vitest"
import type { Pool } from "mysql2/promise"
import { DrizzleMySqlScheduleStore } from "../drizzleScheduleStore"

describe("MySQL schedule store retirement", () => {
  it("advances a schedule with no next occurrence by writing next_run_at NULL (the column is nullable since fixture migration 0003)", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const pool = { query: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return [{ affectedRows: 1 }] } } as unknown as Pool
    const store = new DrizzleMySqlScheduleStore(pool)
    await expect(store.advanceSchedule({ scheduleId: "s", workerId: "w", claimToken: "t", nextRunAt: null, lastRunAt: new Date(0), lastStatus: "skipped" })).resolves.toBe(true)
    expect(calls[0]!.sql).toMatch(/SET next_run_at=\?,/)
    expect(calls[0]!.params[0]).toBeNull()
  })

  it("never selects a retired schedule as due: the due predicate compares next_run_at, which is false for NULL", async () => {
    const statements: string[] = []
    const connection = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, query: async (sql: string) => { statements.push(sql); return [[]] } }
    const store = new DrizzleMySqlScheduleStore({ query: async () => [[]], getConnection: async () => connection } as unknown as Pool)
    await store.claimDueSchedules({ workerId: "w", limit: 1, leaseDurationMs: 1_000, now: new Date(0) })
    expect(statements[0]).toMatch(/AND next_run_at<=\?/)
  })
})
