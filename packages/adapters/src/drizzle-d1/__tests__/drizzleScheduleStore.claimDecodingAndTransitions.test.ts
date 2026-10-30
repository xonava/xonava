import { describe, expect, it } from "vitest"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { createDrizzleScheduleStore, type DrizzleScheduleStoreConfig } from "../drizzleScheduleStore"
import { createScriptedDb, renderSql, type ScriptedHandler } from "../../__tests__/support/scriptedDb"

const ts = (name: string) => integer(name, { mode: "timestamp_ms" })
const schedules = sqliteTable("platform_schedules", {
  id: text("id"), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), scopeKey: text("scope_key"), payload: text("payload"),
  cronExpression: text("cron_expression"), timezone: text("timezone"), enabled: integer("enabled", { mode: "boolean" }), overlapPolicy: text("overlap_policy"), misfirePolicy: text("misfire_policy"),
  nextRunAt: ts("next_run_at"), lastRunAt: ts("last_run_at"), lastStatus: text("last_status"), lastError: text("last_error"), leaseOwner: text("lease_owner"), leaseExpiresAt: ts("lease_expires_at"),
  claimToken: text("claim_token"), paused: integer("paused", { mode: "boolean" }), effectiveFrom: ts("effective_from"), effectiveUntil: ts("effective_until"), remainingOccurrences: integer("remaining_occurrences"),
  calendarExclusionKey: text("calendar_exclusion_key"), owner: text("owner"), description: text("description"),
})
const required = {
  id: schedules.id, jobType: schedules.jobType, jobVersion: schedules.jobVersion, tenantId: schedules.tenantId, scope: schedules.scope, scopeKey: schedules.scopeKey, payload: schedules.payload,
  cronExpression: schedules.cronExpression, timezone: schedules.timezone, enabled: schedules.enabled, overlapPolicy: schedules.overlapPolicy, misfirePolicy: schedules.misfirePolicy,
  nextRunAt: schedules.nextRunAt, lastRunAt: schedules.lastRunAt, lastStatus: schedules.lastStatus, lastError: schedules.lastError, leaseOwner: schedules.leaseOwner,
  leaseExpiresAt: schedules.leaseExpiresAt, claimToken: schedules.claimToken,
}
const lifecycleColumns = { paused: schedules.paused, effectiveFrom: schedules.effectiveFrom, effectiveUntil: schedules.effectiveUntil, remainingOccurrences: schedules.remainingOccurrences }
const optionalColumns = { ...lifecycleColumns, calendarExclusionKey: schedules.calendarExclusionKey, owner: schedules.owner, description: schedules.description }
const NOW = new Date("2026-03-01T00:00:00.000Z")

function build(handler: ScriptedHandler, columns: Record<string, unknown> = required, extra: Partial<DrizzleScheduleStoreConfig> = {}, platformTimezone?: string) {
  const scripted = createScriptedDb("sqlite", handler)
  const store = createDrizzleScheduleStore(scripted.db as never, { schedulesTable: schedules, columnMap: { schedules: columns as never }, ...extra }, platformTimezone)
  return { store, ops: scripted.ops }
}
const row = (overrides: Record<string, unknown> = {}) => ({
  id: "s1", scope: "system", scopeKey: null, jobType: "mail", jobVersion: 1, tenantId: null, payload: "{}", cronExpression: "* * * * *", timezone: "UTC", overlapPolicy: "allow", misfirePolicy: "fire_now",
  nextRunAt: NOW.getTime(), lastRunAt: null, lastStatus: null, claimToken: "tok", ...overrides,
})
const changes = (n: number) => ({ meta: { changes: n } })
const claimHandler = (rows: Record<string, unknown>[]): ScriptedHandler => (op) => (op.kind === "update" ? changes(1) : op.fields ? rows : rows)
const claimArgs = { workerId: "w", limit: 5, leaseDurationMs: 1_000, now: NOW }
const norm = (sql: string | undefined) => (sql ?? "").replace(/\s+/g, " ")
const fenceArgs = { scheduleId: "s1", workerId: "w1", claimToken: "tok", nextRunAt: new Date(5_000), lastRunAt: NOW, lastStatus: "succeeded" } as never

describe("d1 schedule store claim row decoding", () => {
  it("decodes lifecycle fields, keeping zero remaining occurrences and omitting absent ones", async () => {
    const full = build(claimHandler([row({ paused: 1, effectiveFrom: 1_000, effectiveUntil: 2_000, remainingOccurrences: 0, lastRunAt: 3_000, lastStatus: "idle" })]), { ...required, ...optionalColumns })
    const [claim] = await full.store.claimDueSchedules(claimArgs)
    expect(claim!.lifecycle).toEqual({ paused: true, effectiveFrom: new Date(1_000).toISOString(), effectiveUntil: new Date(2_000).toISOString(), remainingOccurrences: 0 })
    expect(claim!.lastRunAt).toEqual(new Date(3_000))
    const bare = build(claimHandler([row({ paused: 0, effectiveFrom: null, effectiveUntil: null, remainingOccurrences: null })]), { ...required, ...optionalColumns })
    expect((await bare.store.claimDueSchedules(claimArgs))[0]!.lifecycle).toEqual({ paused: false })
    const undef = build(claimHandler([row({ remainingOccurrences: undefined })]), required)
    expect((await undef.store.claimDueSchedules(claimArgs))[0]!.lifecycle).toEqual({ paused: false })
    const five = build(claimHandler([row({ remainingOccurrences: "5" })]), { ...required, ...optionalColumns })
    expect((await five.store.claimDueSchedules(claimArgs))[0]!.lifecycle).toEqual({ paused: false, remainingOccurrences: 5 })
  })

  it("selects optional lifecycle columns only when they are mapped", async () => {
    const without = build(claimHandler([]), required)
    await without.store.claimDueSchedules(claimArgs)
    expect(Object.keys(without.ops[0]!.fields as object)).toEqual(["id", "scope", "jobType", "jobVersion", "tenantId", "payload", "cronExpression", "timezone", "overlapPolicy", "misfirePolicy", "nextRunAt", "lastRunAt", "lastStatus"])
    const withAll = build(claimHandler([]), { ...required, ...optionalColumns })
    await withAll.store.claimDueSchedules(claimArgs)
    expect(Object.keys(withAll.ops[0]!.fields as object)).toEqual(["id", "scope", "jobType", "jobVersion", "tenantId", "payload", "cronExpression", "timezone", "overlapPolicy", "misfirePolicy", "nextRunAt", "lastRunAt", "lastStatus", "paused", "effectiveFrom", "effectiveUntil", "remainingOccurrences", "calendarExclusionKey", "owner", "description"])
    const some = build(claimHandler([]), { ...required, owner: schedules.owner })
    await some.store.claimDueSchedules(claimArgs)
    expect(Object.keys(some.ops[0]!.fields as object).slice(13)).toEqual(["owner"])
  })

  it("reads the claimed rows back by id and claim token under the live lease", async () => {
    const f = build(claimHandler([row()]))
    await f.store.claimDueSchedules(claimArgs)
    const readback = f.ops[f.ops.length - 1]!
    expect(readback.kind).toBe("select")
    expect(readback.limit).toBe(1)
    const token = (f.ops[1]!.set as { claimToken: string }).claimToken
    expect(norm(readback.where!.sql)).toContain('(("platform_schedules"."id" = ? and "platform_schedules"."claim_token" = ?) and "platform_schedules"."lease_owner" = ? and "platform_schedules"."last_status" = ? and "platform_schedules"."lease_expires_at" >')
    expect(readback.where!.params).toEqual(["s1", token, "w", "running"])
  })

  it("resolves timezones only for tenant claims and falls back to the platform timezone", async () => {
    const calls: unknown[][] = []
    const resolver: DrizzleScheduleStoreConfig["resolveTenantTimezones"] = async (_db, tenantIds, platform) => { calls.push([tenantIds, platform]); return new Map([["t1", "Europe/Berlin"]]) }
    const mixed = build(claimHandler([row({ id: "a", scope: "tenant", tenantId: "t1", timezone: "UTC" }), row({ id: "b", scope: "system", tenantId: null, timezone: "Asia/Tokyo" }), row({ id: "c", scope: "tenant", tenantId: "t2", timezone: "" })]), required, { resolveTenantTimezones: resolver }, "America/New_York")
    const claims = await mixed.store.claimDueSchedules(claimArgs)
    expect(calls).toEqual([[["t1", "t2"], "America/New_York"]])
    expect(Object.fromEntries(claims.map((claim) => [claim.scheduleId, claim.timezone]))).toEqual({ a: "Europe/Berlin", b: "Asia/Tokyo", c: "America/New_York" })
    const none: unknown[][] = []
    const systemOnly = build(claimHandler([row()]), required, { resolveTenantTimezones: async (_db, tenantIds) => { none.push(tenantIds); return new Map() } })
    expect((await systemOnly.store.claimDueSchedules(claimArgs))[0]!.timezone).toBe("UTC")
    expect(none).toEqual([])
    const defaulted = build(claimHandler([row({ timezone: null })]))
    expect((await defaulted.store.claimDueSchedules(claimArgs))[0]!.timezone).toBe("UTC")
    const custom = build(claimHandler([row({ timezone: null })]), required, {}, "Pacific/Auckland")
    expect((await custom.store.claimDueSchedules(claimArgs))[0]!.timezone).toBe("Pacific/Auckland")
  })
})

describe("d1 schedule store fenced transitions", () => {
  it("advance needs a claim token and writes the next run under the live lease", async () => {
    const none = build(() => changes(1))
    expect(await none.store.advanceSchedule({ ...(fenceArgs as object), claimToken: "" } as never)).toBe(false)
    expect(none.ops).toEqual([])
    const f = build(() => changes(1))
    expect(await f.store.advanceSchedule({ ...(fenceArgs as object), lastError: "e" } as never)).toBe(true)
    expect(f.ops[0]!.set).toEqual({ nextRunAt: new Date(5_000), lastRunAt: NOW, lastStatus: "succeeded", lastError: "e", leaseOwner: null, leaseExpiresAt: null, claimToken: null })
    expect(f.ops[0]!.where!.params).toEqual(["s1", "w1", "tok", "running"])
    expect(await build(() => changes(0)).store.advanceSchedule(fenceArgs)).toBe(false)
  })

  it("advance consumes remaining occurrences only when the column is mapped and something was consumed", async () => {
    const mapped = build(() => changes(1), { ...required, remainingOccurrences: schedules.remainingOccurrences })
    await mapped.store.advanceSchedule({ ...(fenceArgs as object), occurrencesFired: 2 } as never)
    const set = mapped.ops[0]!.set as Record<string, unknown>
    expect(Object.keys(set)).toContain("remainingOccurrences")
    const rendered = renderSql("sqlite", set.remainingOccurrences)
    expect(norm(rendered!.sql)).toBe('CASE WHEN "platform_schedules"."remaining_occurrences" IS NULL THEN NULL ELSE MAX("platform_schedules"."remaining_occurrences" - ?, 0) END')
    expect(rendered!.params).toEqual([2])
    const byStatus = build(() => changes(1), { ...required, remainingOccurrences: schedules.remainingOccurrences })
    await byStatus.store.advanceSchedule({ ...(fenceArgs as object), lastStatus: "fired" } as never)
    expect(renderSql("sqlite", (byStatus.ops[0]!.set as Record<string, unknown>).remainingOccurrences)!.params).toEqual([1])
    const unmapped = build(() => changes(1))
    await unmapped.store.advanceSchedule({ ...(fenceArgs as object), occurrencesFired: 1 } as never)
    expect(unmapped.ops[0]!.set).not.toHaveProperty("remainingOccurrences")
    const skipped = build(() => changes(1), { ...required, remainingOccurrences: schedules.remainingOccurrences })
    await skipped.store.advanceSchedule({ ...(fenceArgs as object), occurrencesFired: 0, lastStatus: "skipped" } as never)
    expect(skipped.ops[0]!.set).not.toHaveProperty("remainingOccurrences")
  })

  it("a failed run with a retry time holds the lease expiry at that time, otherwise it is cleared", async () => {
    const retryAt = new Date(9_000)
    const failed = build(() => changes(1))
    await failed.store.advanceSchedule({ ...(fenceArgs as object), lastStatus: "failed", retryAt } as never)
    expect(failed.ops[0]!.set).toMatchObject({ lastStatus: "failed", leaseExpiresAt: retryAt, leaseOwner: null, claimToken: null })
    const noRetry = build(() => changes(1))
    await noRetry.store.advanceSchedule({ ...(fenceArgs as object), lastStatus: "failed" } as never)
    expect(noRetry.ops[0]!.set).toMatchObject({ leaseExpiresAt: null })
    const succeeded = build(() => changes(1))
    await succeeded.store.advanceSchedule({ ...(fenceArgs as object), lastStatus: "succeeded", retryAt } as never)
    expect(succeeded.ops[0]!.set).toMatchObject({ leaseExpiresAt: null })
  })

  it("release needs a claim token and returns the schedule to idle under the live lease", async () => {
    const none = build(() => changes(1))
    expect(await none.store.releaseSchedule({ scheduleId: "s1", workerId: "w1", claimToken: "" } as never)).toBe(false)
    expect(none.ops).toEqual([])
    const f = build(() => changes(1))
    expect(await f.store.releaseSchedule({ scheduleId: "s1", workerId: "w1", claimToken: "tok" } as never)).toBe(true)
    expect(f.ops[0]!.set).toEqual({ lastStatus: "idle", leaseOwner: null, leaseExpiresAt: null, claimToken: null })
    expect(f.ops[0]!.where!.params).toEqual(["s1", "w1", "tok", "running"])
    expect(await build(() => changes(0)).store.releaseSchedule({ scheduleId: "s1", workerId: "w1", claimToken: "tok" } as never)).toBe(false)
  })
})

