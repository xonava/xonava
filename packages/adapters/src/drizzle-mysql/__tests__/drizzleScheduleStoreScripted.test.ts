import { describe, expect, it } from "vitest"
import { DrizzleMySqlScheduleStore, MYSQL_SCHEDULE_STORE_TABLES } from "../drizzleScheduleStore"
import { createScriptedMySqlPool, type PoolCall, type PoolResponder } from "../../__tests__/support/scriptedPool"

const NOW = new Date("2026-03-01T10:00:00.000Z")
const row = (overrides: Record<string, unknown> = {}) => ({
  id: "s1", scope: "system", scope_key: null, tenant_id: null, job_type: "report", job_version: 1, payload: { a: 1 }, cron_expression: "0 * * * *", timezone: "Europe/Berlin",
  overlap_policy: "skip", misfire_policy: "fire_now", next_run_at: NOW, last_run_at: null, last_status: "idle", paused: 0, effective_from: null, effective_until: null,
  remaining_occurrences: null, calendar_exclusion_key: null, owner: null, description: null, ...overrides,
})
const header = (affectedRows: number) => ({ affectedRows })
const build = (respond: PoolResponder, options: Record<string, unknown> = {}) => {
  const scripted = createScriptedMySqlPool(respond)
  return { store: new DrizzleMySqlScheduleStore(scripted.pool as never, options), ...scripted }
}
const claimArgs = { workerId: "w1", limit: 5, leaseDurationMs: 60_000, now: NOW }
const isSelect = (call: PoolCall) => call.sql.startsWith("SELECT")

describe("MySQL schedule store", () => {
  it("claims due schedules in one transaction, preserving the status observed before the claim", async () => {
    const { store, calls, events } = build((call) => (isSelect(call) ? [row({ id: "a", last_status: "fired" }), row({ id: "b", timezone: "", last_status: null })] : header(1)))
    const claims = await store.claimDueSchedules(claimArgs)
    expect(claims.map((claim) => claim.scheduleId)).toEqual(["a", "b"])
    expect(claims[0]).toMatchObject({ lastStatus: "fired", payload: '{"a":1}', timezone: "Europe/Berlin", overlapPolicy: { type: "skip" }, misfirePolicy: { type: "fire_now" }, executionScope: { kind: "system", systemKey: "framework" } })
    expect(claims[1]).toMatchObject({ timezone: "UTC", lastStatus: null })
    expect(claims[0]!.claimToken).not.toBe(claims[1]!.claimToken)
    expect(events).toEqual(["begin", "commit", "release"])
    expect(calls[0]!.sql).toContain("FOR UPDATE SKIP LOCKED")
    expect(calls[0]!.params).toEqual([NOW, NOW, NOW, NOW, 5])
    expect(calls[1]!.params.slice(0, 1)).toEqual(["w1"])
  })

  it("decodes lifecycle columns, tenant scope and string payloads", async () => {
    const { store } = build((call) => (isSelect(call) ? [row({
      scope: "tenant", tenant_id: "t1", payload: '{"s":1}', paused: 1, effective_from: "2026-01-01T00:00:00.000Z", effective_until: "2027-01-01T00:00:00.000Z", remaining_occurrences: 0,
      calendar_exclusion_key: "cal", owner: "ops", description: "d", last_run_at: NOW, last_status: "failed",
    })] : header(1)))
    const [claim] = await store.claimDueSchedules(claimArgs)
    expect(claim).toMatchObject({ scope: "tenant", tenantId: "t1", payload: '{"s":1}', lastRunAt: NOW, lastStatus: "failed", executionScope: { kind: "tenant", tenantId: "t1" } })
    expect(claim!.lifecycle).toEqual({ paused: true, effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveUntil: "2027-01-01T00:00:00.000Z", remainingOccurrences: 0, calendarExclusionKey: "cal", owner: "ops", description: "d" })
    const platform = build((call) => (isSelect(call) ? [row({ scope: "platform", scope_key: "ops" })] : header(1)))
    expect((await platform.store.claimDueSchedules({ ...claimArgs, now: undefined }))[0]!.executionScope).toEqual({ kind: "platform", platformKey: "ops" })
  })

  it("rolls back on failures and ignores invalid claim arguments", async () => {
    const boom = new Error("select failed")
    const failing = build((call) => { if (isSelect(call)) throw boom; return header(1) })
    await expect(failing.store.claimDueSchedules(claimArgs)).rejects.toBe(boom)
    expect(failing.events).toEqual(["begin", "rollback", "release"])
    const { store, calls } = build(() => [])
    await expect(store.claimDueSchedules({ ...claimArgs, workerId: "w".repeat(101) })).rejects.toThrow("workerId exceeds")
    for (const patch of [{ limit: 0 }, { limit: 1.5 }, { leaseDurationMs: -1 }, { leaseDurationMs: Number.NaN }]) expect(await store.claimDueSchedules({ ...claimArgs, ...patch })).toEqual([])
    expect(calls).toEqual([])
  })

  it("advances, releases and renews under the claim fence", async () => {
    const { store, calls } = build(() => header(1))
    const advance = { scheduleId: "s1", workerId: "w1", claimToken: "ct", nextRunAt: new Date(NOW.getTime() + 1_000), lastRunAt: NOW, lastStatus: "idle" }
    expect(await store.advanceSchedule(advance as never)).toBe(true)
    expect(calls[0]!.params).toEqual([advance.nextRunAt, NOW, "idle", null, 0, null, "s1", "w1", "ct"])
    await store.advanceSchedule({ ...advance, lastStatus: "fired", occurrencesFired: 2 } as never)
    expect(calls[1]!.params[4]).toBe(2)
    const retryAt = new Date(NOW.getTime() + 60_000)
    await store.advanceSchedule({ ...advance, lastStatus: "failed", lastError: "boom", retryAt } as never)
    expect(calls[2]!.params.slice(3, 6)).toEqual(["boom", 0, retryAt])
    await store.advanceSchedule({ ...advance, lastStatus: "idle", retryAt } as never)
    expect(calls[3]!.params[5]).toBeNull()
    expect(await store.advanceSchedule({ ...advance, claimToken: "" } as never)).toBe(false)
    expect(await build(() => header(0)).store.advanceSchedule(advance as never)).toBe(false)
    expect(await store.releaseSchedule({ scheduleId: "s1", workerId: "w1", claimToken: "ct" })).toBe(true)
    expect(await store.releaseSchedule({ scheduleId: "s1", workerId: "w1", claimToken: "" })).toBe(false)
    expect(await build(() => header(0)).store.releaseSchedule({ scheduleId: "s1", workerId: "w1", claimToken: "ct" })).toBe(false)
    expect(await store.renewScheduleLease({ scheduleId: "s1", workerId: "w1", claimToken: "ct", extendByMs: 500 })).toBe(true)
    expect(await store.renewScheduleLease({ scheduleId: "s1", workerId: "w1", claimToken: "ct", extendByMs: 0 })).toBe(false)
    expect(await store.renewScheduleLease({ scheduleId: "s1", workerId: "w1", claimToken: "ct", extendByMs: Number.POSITIVE_INFINITY })).toBe(false)
    await expect(store.renewScheduleLease({ scheduleId: "s1", workerId: "w".repeat(101), claimToken: "ct", extendByMs: 1 })).rejects.toThrow("workerId exceeds")
    expect(await build(() => header(0)).store.renewScheduleLease({ scheduleId: "s1", workerId: "w1", claimToken: "ct", extendByMs: 500 })).toBe(false)
  })

  it("honours table overrides", async () => {
    const { store, calls } = build(() => header(1), { database: "app", tables: { schedules: "app_schedules" } })
    await store.releaseSchedule({ scheduleId: "s1", workerId: "w1", claimToken: "ct" })
    expect(calls[0]!.sql).toContain("`app`.`app_schedules`")
    expect(MYSQL_SCHEDULE_STORE_TABLES).toEqual({ schedules: "schedules" })
  })
})
