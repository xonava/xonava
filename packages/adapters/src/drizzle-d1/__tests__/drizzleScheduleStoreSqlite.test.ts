import { describe, expect, it } from "vitest"
import { getTableColumns } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ConfigurationError, ValidationError } from "@xonava/core/domain"
import { createDrizzleD1Adapter, createDrizzleScheduleStore } from "@xonava/adapters/drizzle-d1"
import { setup } from "./sqliteFixture"

const ts = (name: string) => integer(name, { mode: "timestamp_ms" })
const schedules = sqliteTable("dx_schedules", {
  id: text("id").primaryKey(), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), scopeKey: text("scope_key"), payload: text("payload"),
  cronExpression: text("cron_expression"), timezone: text("timezone"), enabled: integer("enabled", { mode: "boolean" }), overlapPolicy: text("overlap_policy"), misfirePolicy: text("misfire_policy"),
  nextRunAt: ts("next_run_at"), lastRunAt: ts("last_run_at"), lastStatus: text("last_status"), lastError: text("last_error"), leaseOwner: text("lease_owner"), leaseExpiresAt: integer("lease_expires_at"),
  claimToken: text("claim_token"), paused: integer("paused", { mode: "boolean" }), effectiveFrom: ts("effective_from"), effectiveUntil: ts("effective_until"), remainingOccurrences: integer("remaining_occurrences"),
  calendarExclusionKey: text("calendar_exclusion_key"), owner: text("owner"), description: text("description"),
})
const SCHEMA = ["CREATE TABLE dx_schedules (id TEXT PRIMARY KEY, job_type TEXT, job_version INTEGER, tenant_id TEXT, scope TEXT, scope_key TEXT, payload TEXT, cron_expression TEXT, timezone TEXT, enabled INTEGER, overlap_policy TEXT, misfire_policy TEXT, next_run_at INTEGER, last_run_at INTEGER, last_status TEXT, last_error TEXT, lease_owner TEXT, lease_expires_at INTEGER, claim_token TEXT, paused INTEGER, effective_from INTEGER, effective_until INTEGER, remaining_occurrences INTEGER, calendar_exclusion_key TEXT, owner TEXT, description TEXT)"]

const PAST = Date.now() - 60_000
async function build(config: { resolveTenantTimezones?: never; platformTimezone?: string; columns?: Record<string, unknown> } = {}) {
  const fixture = await setup({ extraSchema: SCHEMA })
  const session = createDrizzleD1Adapter(drizzle(fixture.d1 as never) as never).repository
  const store = createDrizzleScheduleStore(session, { schedulesTable: schedules, columnMap: { schedules: (config.columns ?? getTableColumns(schedules)) as never }, ...(config.resolveTenantTimezones ? { resolveTenantTimezones: config.resolveTenantTimezones } : {}) }, config.platformTimezone)
  const insert = (id: string, values: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = { id, job_type: "report", job_version: 1, tenant_id: null, scope: "system", scope_key: null, payload: "{}", cron_expression: "0 * * * *", timezone: "Europe/Berlin", enabled: 1, overlap_policy: "skip", misfire_policy: "fire_now", next_run_at: PAST, last_status: "idle", paused: 0, ...values }
    fixture.d1.sqlite.prepare(`INSERT INTO dx_schedules (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...(Object.values(row) as never[]))
  }
  const state = (id: string) => fixture.d1.sqlite.prepare("SELECT * FROM dx_schedules WHERE id = ?").get(id) as Record<string, unknown>
  return { ...fixture, store, insert, state }
}
const claimArgs = { workerId: "w1", limit: 10, leaseDurationMs: 60_000 }

describe("D1 schedule store on a real SQLite engine", () => {
  it("requires every mandatory column", async () => {
    const { id: _id, ...withoutId } = getTableColumns(schedules)
    await expect(build({ columns: withoutId })).rejects.toThrow(ConfigurationError)
  })

  it("claims due, enabled, unpaused schedules oldest-first and leaves the rest", async () => {
    const { store, insert, state } = await build()
    insert("late", { next_run_at: PAST + 10 })
    insert("early", { next_run_at: PAST - 10, last_status: null })
    insert("future", { next_run_at: Date.now() + 3_600_000 })
    insert("disabled", { enabled: 0 })
    insert("paused", { paused: 1 })
    insert("exhausted", { remaining_occurrences: 0 })
    insert("not-yet", { effective_from: Date.now() + 3_600_000 })
    insert("expired", { effective_until: PAST })
    insert("tenant", { scope: "tenant", tenant_id: "t1" })
    const claims = await store.claimDueSchedules(claimArgs)
    expect(claims.map((claim) => claim.scheduleId)).toEqual(["early", "tenant", "late"])
    expect(claims[0]).toMatchObject({ scheduleId: "early", lastStatus: null, scope: "system", executionScope: { kind: "system", systemKey: "framework" }, timezone: "Europe/Berlin" })
    expect(claims.find((claim) => claim.scheduleId === "tenant")).toMatchObject({ tenantId: "t1", executionScope: { kind: "tenant", tenantId: "t1" } })
    expect(state("early")).toMatchObject({ last_status: "running", lease_owner: "w1" })
    expect(state("future").last_status).toBe("idle")
    expect(await store.claimDueSchedules(claimArgs)).toEqual([])
  })

  it("holds running schedules until their lease expires, and failed ones until their retry time", async () => {
    const { store, insert, d1 } = await build()
    insert("running", { last_status: "running", lease_owner: "w9", lease_expires_at: Date.now() + 600_000, claim_token: "x" })
    insert("backing-off", { last_status: "failed", lease_expires_at: Date.now() + 600_000 })
    insert("retry-due", { last_status: "failed", lease_expires_at: PAST })
    expect((await store.claimDueSchedules(claimArgs)).map((claim) => claim.scheduleId)).toEqual(["retry-due"])
    d1.sqlite.exec("UPDATE dx_schedules SET lease_expires_at = 1 WHERE id = 'running'")
    expect((await store.claimDueSchedules({ ...claimArgs, workerId: "w2" })).map((claim) => claim.scheduleId)).toEqual(["running"])
  })

  it("maps lifecycle columns and applies tenant timezones from the resolver", async () => {
    const seen: unknown[] = []
    const resolve = (async (_db: unknown, tenantIds: string[], platform: string) => { seen.push(tenantIds, platform); return new Map([["t1", "America/Chicago"]]) }) as never
    const { store, insert } = await build({ resolveTenantTimezones: resolve, platformTimezone: "Asia/Tokyo" })
    insert("a", { scope: "tenant", tenant_id: "t1", next_run_at: PAST - 5, effective_from: PAST, effective_until: Date.now() + 3_600_000, remaining_occurrences: 4, calendar_exclusion_key: "cal", owner: "ops", description: "d", last_run_at: PAST, overlap_policy: null, misfire_policy: null })
    insert("b", { scope: "tenant", tenant_id: "t2", timezone: "" })
    const claims = await store.claimDueSchedules(claimArgs)
    expect(claims.map((claim) => claim.timezone)).toEqual(["America/Chicago", "Asia/Tokyo"])
    expect(seen).toEqual([["t1", "t2"], "Asia/Tokyo"])
    expect(claims[0]).toMatchObject({ overlapPolicy: { type: "allow" }, misfirePolicy: { type: "fire_now" }, lastRunAt: new Date(PAST) })
    expect(claims[0]!.lifecycle).toMatchObject({ paused: false, remainingOccurrences: 4, calendarExclusionKey: "cal", owner: "ops", description: "d" })
    expect(claims[0]!.lifecycle!.effectiveFrom).toBe(new Date(PAST).toISOString())
  })

  it("skips lifecycle predicates for optional columns that are not mapped", async () => {
    const { paused: _p, effectiveFrom: _f, effectiveUntil: _u, remainingOccurrences: _r, calendarExclusionKey: _c, owner: _o, description: _d, ...required } = getTableColumns(schedules)
    const { store, insert } = await build({ columns: required })
    insert("paused-but-unmapped", { paused: 1, remaining_occurrences: 0, effective_until: PAST })
    const [claim] = await store.claimDueSchedules(claimArgs)
    expect(claim!.scheduleId).toBe("paused-but-unmapped")
  })

  it("claims at most the limit and rejects bad arguments", async () => {
    const { store, insert } = await build()
    insert("a")
    insert("b", { next_run_at: PAST + 1 })
    expect(await store.claimDueSchedules({ ...claimArgs, limit: 1 })).toHaveLength(1)
    await expect(store.claimDueSchedules({ ...claimArgs, workerId: "w".repeat(101) })).rejects.toThrow("workerId exceeds")
    for (const patch of [{ limit: 0 }, { limit: 1.5 }, { leaseDurationMs: -1 }, { leaseDurationMs: Number.NaN }]) expect(await store.claimDueSchedules({ ...claimArgs, ...patch })).toEqual([])
  })

  it("rejects stored rows with an invalid scope", async () => {
    const { store, insert } = await build()
    insert("bad", { scope: "bogus" })
    await expect(store.claimDueSchedules(claimArgs)).rejects.toBeInstanceOf(ValidationError)
  })

  it("advances under the fence, consuming occurrences and backing off failures", async () => {
    const { store, insert, state } = await build()
    insert("s1", { remaining_occurrences: 5 })
    const [claim] = await store.claimDueSchedules(claimArgs)
    const next = new Date(Date.now() + 3_600_000)
    const advance = { scheduleId: "s1", workerId: "w1", claimToken: claim!.claimToken, nextRunAt: next, lastRunAt: new Date(), lastStatus: "fired", occurrencesFired: 2 }
    expect(await store.advanceSchedule({ ...advance, claimToken: "stale" } as never)).toBe(false)
    expect(await store.advanceSchedule({ ...advance, claimToken: "" } as never)).toBe(false)
    expect(await store.advanceSchedule(advance as never)).toBe(true)
    expect(state("s1")).toMatchObject({ last_status: "fired", remaining_occurrences: 3, lease_owner: null, claim_token: null, lease_expires_at: null, next_run_at: next.getTime() })
    expect(await store.advanceSchedule(advance as never)).toBe(false)
  })

  it("records a failure with a retry time that holds the schedule until then", async () => {
    const { store, insert, state } = await build()
    insert("s1", { remaining_occurrences: 1 })
    const [claim] = await store.claimDueSchedules(claimArgs)
    const retryAt = new Date(Date.now() + 600_000)
    expect(await store.advanceSchedule({ scheduleId: "s1", workerId: "w1", claimToken: claim!.claimToken, nextRunAt: new Date(PAST), lastRunAt: new Date(), lastStatus: "failed", lastError: "boom", retryAt } as never)).toBe(true)
    expect(state("s1")).toMatchObject({ last_status: "failed", last_error: "boom", lease_expires_at: retryAt.getTime(), remaining_occurrences: 1 })
    expect(await store.claimDueSchedules(claimArgs)).toEqual([])
  })

  it("releases and renews leases only for the live owner", async () => {
    const { store, insert, state } = await build()
    insert("s1")
    const [claim] = await store.claimDueSchedules(claimArgs)
    const lease = { scheduleId: "s1", workerId: "w1", claimToken: claim!.claimToken }
    const before = Number(state("s1").lease_expires_at)
    expect(await store.renewScheduleLease({ now: new Date(), ...lease, extendByMs: 3_600_000 })).toBe(true)
    expect(Number(state("s1").lease_expires_at)).toBeGreaterThan(before + 3_000_000)
    const extended = Number(state("s1").lease_expires_at)
    expect(await store.renewScheduleLease({ now: new Date(), ...lease, extendByMs: 1 })).toBe(true)
    expect(Number(state("s1").lease_expires_at)).toBe(extended)
    expect(await store.renewScheduleLease({ now: new Date(), ...lease, extendByMs: 0 })).toBe(false)
    expect(await store.renewScheduleLease({ now: new Date(), ...lease, extendByMs: Number.NaN })).toBe(false)
    expect(await store.renewScheduleLease({ now: new Date(), ...lease, claimToken: "stale", extendByMs: 10 })).toBe(false)
    await expect(store.renewScheduleLease({ now: new Date(), ...lease, workerId: "w".repeat(101), extendByMs: 10 })).rejects.toThrow("workerId exceeds")
    expect(await store.releaseSchedule({ ...lease, claimToken: "" })).toBe(false)
    expect(await store.releaseSchedule({ ...lease, claimToken: "stale" })).toBe(false)
    expect(await store.releaseSchedule(lease)).toBe(true)
    expect(state("s1")).toMatchObject({ last_status: "idle", lease_owner: null })
    expect(await store.releaseSchedule(lease)).toBe(false)
  })
})
