import { describe, expect, it } from "vitest"
import { getTableColumns } from "drizzle-orm"
import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { ConfigurationError, ValidationError } from "@xonava/core/domain"
import { createDrizzleScheduleStore } from "../drizzleScheduleStore"
import { createScriptedDb, renderSql, type ScriptedHandler, type ScriptedOp } from "../../__tests__/support/scriptedDb"

const NOW = new Date("2026-03-01T10:00:00.000Z")
const ISO = NOW.toISOString()
const schedules = pgTable("schedules", {
  id: text("id").primaryKey(), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), scopeKey: text("scope_key"), payload: text("payload"),
  cronExpression: text("cron_expression"), timezone: text("timezone"), enabled: boolean("enabled"), overlapPolicy: text("overlap_policy"), misfirePolicy: text("misfire_policy"),
  nextRunAt: timestamp("next_run_at"), lastRunAt: timestamp("last_run_at"), lastStatus: text("last_status"), lastError: text("last_error"), leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at"), claimToken: text("claim_token"),
  paused: boolean("paused"), effectiveFrom: timestamp("effective_from"), effectiveUntil: timestamp("effective_until"), remainingOccurrences: integer("remaining_occurrences"),
  calendarExclusionKey: text("calendar_exclusion_key"), owner: text("owner"), description: text("description"),
})
const optional = ["paused", "effectiveFrom", "effectiveUntil", "remainingOccurrences", "calendarExclusionKey", "owner", "description"] as const
const allColumns = getTableColumns(schedules) as Record<string, unknown>
const baseColumns = (): Record<string, unknown> => Object.fromEntries(Object.entries(allColumns).filter(([key]) => !(optional as readonly string[]).includes(key)))
const scheduleRow = (overrides: Record<string, unknown> = {}) => ({
  id: "s1", scope: "system", scopeKey: null, jobType: "report", jobVersion: 1, tenantId: null, payload: "{}", cronExpression: "0 * * * *", timezone: "Europe/Berlin",
  overlapPolicy: "skip", misfirePolicy: "fire_now", nextRunAt: NOW, lastRunAt: null, lastStatus: "idle", claimToken: "ct", ...overrides,
})
const affected = (rowCount: number) => ({ rowCount })

interface BuildOptions { columns?: "full" | "base"; resolveTenantTimezones?: (db: unknown, tenantIds: string[], platformTimezone: string) => Promise<Map<string, string>>; platformTimezone?: string }
function build(handler: ScriptedHandler, options: BuildOptions = {}) {
  const scripted = createScriptedDb("pg", handler)
  const columnMap = options.columns === "base" ? baseColumns() : allColumns
  const store = createDrizzleScheduleStore(
    scripted.db as never,
    { schedulesTable: schedules as never, columnMap: { schedules: columnMap as never }, ...(options.resolveTenantTimezones ? { resolveTenantTimezones: options.resolveTenantTimezones as never } : {}) },
    options.platformTimezone,
  )
  return { store, ops: scripted.ops }
}
const claimResponder = (rows: Record<string, unknown>[], claimed: number[] = rows.map(() => 1)): ScriptedHandler => {
  let update = 0
  return (op) => {
    if (op.kind === "update") return affected(claimed[update++] ?? 0)
    return op.fields !== undefined ? rows : rows.map((row) => ({ ...row, lastStatus: "running" }))
  }
}
const claimArgs = { workerId: "w1", limit: 5, leaseDurationMs: 60_000, now: NOW }
const norm = (sql: string | undefined) => (sql ?? "").replace(/\s+/g, " ")
const whereOf = (op: ScriptedOp | undefined) => ({ sql: norm(op?.where?.sql), params: op?.where?.params })
const renderedSet = (op: ScriptedOp | undefined, key: string) => { const r = renderSql("pg", (op?.set as Record<string, unknown>)[key]); return { sql: norm(r?.sql), params: r?.params } }

const CLAIMABLE_TAIL = `(COALESCE("schedules"."last_status", '') <> 'failed' or "schedules"."lease_expires_at" is null or "schedules"."lease_expires_at" <= $N1) and (("schedules"."last_status" IS NULL OR "schedules"."last_status" != 'running') or "schedules"."lease_expires_at" < now()))`
const FENCE = `("schedules"."id" = $1 and "schedules"."lease_owner" = $2 and "schedules"."claim_token" = $3 and "schedules"."last_status" = $4 and "schedules"."lease_expires_at" > now())`

describe("schedule store claiming statements", () => {
  it("scans enabled, due, unpaused, in-window, unexhausted and claimable schedules, oldest first, when every lifecycle column is mapped", async () => {
    const { store, ops } = build(claimResponder([scheduleRow()]))
    await store.claimDueSchedules(claimArgs)
    const scan = ops[0]!
    expect(whereOf(scan)).toEqual({
      sql: `("schedules"."enabled" = $1 and "schedules"."next_run_at" <= $2 and "schedules"."paused" = $3 and ("schedules"."effective_from" is null or "schedules"."effective_from" <= $4) and ("schedules"."effective_until" is null or "schedules"."effective_until" > $5) and ("schedules"."remaining_occurrences" is null or "schedules"."remaining_occurrences" > $6) and ${CLAIMABLE_TAIL.replace("$N1", "$7")}`,
      params: [true, ISO, false, ISO, ISO, 0, ISO],
    })
    expect(norm(scan.orderBy!.sql)).toBe('"schedules"."next_run_at" asc')
    expect(scan).toMatchObject({ kind: "select", limit: 5, offset: 0 })
    expect(Object.keys(scan.fields as object)).toEqual(["id", "scope", "jobType", "jobVersion", "tenantId", "payload", "cronExpression", "timezone", "overlapPolicy", "misfirePolicy", "nextRunAt", "lastRunAt", "lastStatus", "paused", "effectiveFrom", "effectiveUntil", "remainingOccurrences", "calendarExclusionKey", "owner", "description"])
  })

  it("leaves out lifecycle conditions and selections for unmapped optional columns", async () => {
    const { store, ops } = build(claimResponder([scheduleRow()]), { columns: "base" })
    await store.claimDueSchedules(claimArgs)
    expect(whereOf(ops[0])).toEqual({
      sql: `("schedules"."enabled" = $1 and "schedules"."next_run_at" <= $2 and ${CLAIMABLE_TAIL.replace("$N1", "$3")}`,
      params: [true, ISO, ISO],
    })
    expect(Object.keys(ops[0]!.fields as object)).toEqual(["id", "scope", "jobType", "jobVersion", "tenantId", "payload", "cronExpression", "timezone", "overlapPolicy", "misfirePolicy", "nextRunAt", "lastRunAt", "lastStatus"])
  })

  it("claims each candidate under the same lifecycle conditions and a database-clock lease, then re-reads the winners under their tokens", async () => {
    const { store, ops } = build(claimResponder([scheduleRow({ id: "a" }), scheduleRow({ id: "b" })]))
    const claims = await store.claimDueSchedules(claimArgs)
    const [, claimA, claimB, reread] = ops
    const lifecycle = `"schedules"."paused" = $4 and ("schedules"."effective_from" is null or "schedules"."effective_from" <= $5) and ("schedules"."effective_until" is null or "schedules"."effective_until" > $6) and ("schedules"."remaining_occurrences" is null or "schedules"."remaining_occurrences" > $7) and ${CLAIMABLE_TAIL.replace("$N1", "$8")}`
    for (const [op, id] of [[claimA, "a"], [claimB, "b"]] as const) {
      expect(whereOf(op)).toEqual({ sql: `("schedules"."id" = $1 and "schedules"."enabled" = $2 and "schedules"."next_run_at" <= $3 and ${lifecycle}`, params: [id, true, ISO, false, ISO, ISO, 0, ISO] })
      expect(Object.keys(op!.set as object)).toEqual(["lastStatus", "leaseOwner", "claimToken", "leaseExpiresAt"])
      expect(op!.set).toMatchObject({ lastStatus: "running", leaseOwner: "w1", claimToken: expect.any(String) })
      expect(renderedSet(op, "leaseExpiresAt")).toEqual({ sql: "now() + ($1 * interval '1 millisecond')", params: [60_000] })
    }
    expect((claimA!.set as { claimToken: string }).claimToken).not.toBe((claimB!.set as { claimToken: string }).claimToken)
    const tokens = [(claimA!.set as { claimToken: string }).claimToken, (claimB!.set as { claimToken: string }).claimToken]
    expect(whereOf(reread)).toEqual({
      sql: `((("schedules"."id" = $1 and "schedules"."claim_token" = $2) or ("schedules"."id" = $3 and "schedules"."claim_token" = $4)) and "schedules"."lease_owner" = $5 and "schedules"."last_status" = $6 and "schedules"."lease_expires_at" > now())`,
      params: ["a", tokens[0], "b", tokens[1], "w1", "running"],
    })
    expect(reread).toMatchObject({ kind: "select", limit: 2 })
    expect(claims.map((claim) => claim.scheduleId)).toEqual(["a", "b"])
  })

  it("defaults the clock and treats a zero lease as claimable but a negative one as unusable", async () => {
    const before = Date.now()
    const { store, ops } = build(claimResponder([scheduleRow()]))
    await store.claimDueSchedules({ workerId: "w1", limit: 1, leaseDurationMs: 0 })
    expect(ops.length).toBeGreaterThan(1)
    const stamp = new Date(String(ops[0]!.where!.params[1])).getTime()
    expect(stamp).toBeGreaterThanOrEqual(before - 1)
    expect(stamp).toBeLessThanOrEqual(Date.now())
    expect(renderedSet(ops[1], "leaseExpiresAt").params).toEqual([0])
    const guarded = build(claimResponder([scheduleRow()]))
    for (const leaseDurationMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(await guarded.store.claimDueSchedules({ ...claimArgs, leaseDurationMs })).toEqual([])
    for (const limit of [0, -1, 1.5]) expect(await guarded.store.claimDueSchedules({ ...claimArgs, limit })).toEqual([])
    expect(guarded.ops).toEqual([])
  })

  it("returns nothing and does not re-read when every claim race is lost", async () => {
    const { store, ops } = build(claimResponder([scheduleRow()], [0]))
    expect(await store.claimDueSchedules(claimArgs)).toEqual([])
    expect(ops.map((op) => op.kind)).toEqual(["select", "update"])
  })

  it("counts a claim only when the conditional update affected a row, and returns winners in claim order", async () => {
    const rows = [scheduleRow({ id: "a" }), scheduleRow({ id: "b" }), scheduleRow({ id: "c" })]
    const handler: ScriptedHandler = (op) => {
      if (op.kind === "update") return affected(op.where!.params[0] === "b" ? 0 : 1)
      return op.fields !== undefined ? rows : [{ ...rows[2], lastStatus: "running" }, { ...rows[0], lastStatus: "running" }]
    }
    const { store } = build(handler)
    expect((await store.claimDueSchedules(claimArgs)).map((claim) => claim.scheduleId)).toEqual(["a", "c"])
  })
})

describe("schedule claim decoding and timezones", () => {
  it("decodes the full lifecycle of a claimed schedule", async () => {
    const later = new Date("2026-04-01T00:00:00.000Z")
    const row = scheduleRow({ paused: true, effectiveFrom: NOW, effectiveUntil: later, remainingOccurrences: 3, calendarExclusionKey: "holidays", owner: "ops", description: "nightly", lastRunAt: later, lastStatus: "failed", scope: "tenant", tenantId: "t1" })
    const { store } = build(claimResponder([row]))
    const [claim] = await store.claimDueSchedules(claimArgs)
    expect(claim!.lifecycle).toEqual({ paused: true, effectiveFrom: ISO, effectiveUntil: later.toISOString(), remainingOccurrences: 3, calendarExclusionKey: "holidays", owner: "ops", description: "nightly" })
    expect(claim).toMatchObject({ scope: "tenant", tenantId: "t1", lastRunAt: later, nextRunAt: NOW, lastStatus: "failed", jobType: "report", jobVersion: 1, cronExpression: "0 * * * *", payload: "{}" })
  })

  it("omits empty lifecycle fields but keeps a remaining count of zero", async () => {
    const zero = build(claimResponder([scheduleRow({ paused: false, remainingOccurrences: 0, effectiveFrom: null, effectiveUntil: null, calendarExclusionKey: "", owner: null, description: "" })]))
    expect((await zero.store.claimDueSchedules(claimArgs))[0]!.lifecycle).toEqual({ paused: false, remainingOccurrences: 0 })
    for (const remainingOccurrences of [null, undefined]) {
      const none = build(claimResponder([scheduleRow({ remainingOccurrences })]))
      expect((await none.store.claimDueSchedules(claimArgs))[0]!.lifecycle).toEqual({ paused: false })
    }
  })

  it("defaults overlap and misfire policies and rejects unknown scopes", async () => {
    const defaults = build(claimResponder([scheduleRow({ overlapPolicy: null, misfirePolicy: undefined, lastStatus: null })]))
    const [claim] = await defaults.store.claimDueSchedules(claimArgs)
    expect(claim).toMatchObject({ overlapPolicy: { type: "allow" }, misfirePolicy: { type: "fire_now" }, lastStatus: null })
    const bad = build(claimResponder([scheduleRow({ scope: "bogus", id: "sx" })]))
    await expect(bad.store.claimDueSchedules(claimArgs)).rejects.toThrow(new ValidationError("Schedule sx has a missing or invalid scope"))
    for (const scope of ["tenant", "platform", "system"]) {
      const ok = build(claimResponder([scheduleRow({ scope, tenantId: scope === "tenant" ? "t1" : null })]))
      expect((await ok.store.claimDueSchedules(claimArgs))[0]!.scope).toBe(scope)
    }
  })

  it("resolves tenant timezones only for tenant-owned claims and only when a resolver exists", async () => {
    const calls: string[][] = []
    const resolve = async (_db: unknown, tenantIds: string[], platformTimezone: string) => { calls.push([...tenantIds, platformTimezone]); return new Map([["t1", "Asia/Tokyo"]]) }
    const tenantRows = [scheduleRow({ id: "a", scope: "tenant", tenantId: "t1" }), scheduleRow({ id: "b", scope: "tenant", tenantId: "t2", timezone: "Europe/Berlin" }), scheduleRow({ id: "c" })]
    const withResolver = build(claimResponder(tenantRows), { resolveTenantTimezones: resolve, platformTimezone: "UTC" })
    const claims = await withResolver.store.claimDueSchedules(claimArgs)
    expect(calls).toEqual([["t1", "t2", "UTC"]])
    expect(claims.map((claim) => claim.timezone)).toEqual(["Asia/Tokyo", "Europe/Berlin", "Europe/Berlin"])
    calls.length = 0
    const systemOnly = build(claimResponder([scheduleRow()]), { resolveTenantTimezones: resolve })
    await systemOnly.store.claimDueSchedules(claimArgs)
    expect(calls).toEqual([])
    const noResolver = build(claimResponder(tenantRows))
    expect((await noResolver.store.claimDueSchedules(claimArgs)).map((claim) => claim.timezone)).toEqual(["Europe/Berlin", "Europe/Berlin", "Europe/Berlin"])
    const missing = build(claimResponder([scheduleRow({ timezone: "" }), scheduleRow({ id: "b", timezone: null })]), { platformTimezone: "Asia/Tokyo" })
    expect((await missing.store.claimDueSchedules(claimArgs)).map((claim) => claim.timezone)).toEqual(["Asia/Tokyo", "Asia/Tokyo"])
    const defaultTz = build(claimResponder([scheduleRow({ timezone: null })]))
    expect((await defaultTz.store.claimDueSchedules(claimArgs))[0]!.timezone).toBe("UTC")
  })
})

describe("schedule fenced transitions", () => {
  const args = { scheduleId: "s1", workerId: "w1", claimToken: "ct", nextRunAt: NOW, lastRunAt: NOW }

  it("advance clears the lease under the fence and records the outcome", async () => {
    const { store, ops } = build(() => affected(1))
    expect(await store.advanceSchedule({ ...args, lastStatus: "success" } as never)).toBe(true)
    expect(whereOf(ops[0])).toEqual({ sql: FENCE, params: ["s1", "w1", "ct", "running"] })
    expect(ops[0]!.set).toEqual({ nextRunAt: NOW, lastRunAt: NOW, lastStatus: "success", lastError: null, leaseOwner: null, claimToken: null, leaseExpiresAt: null })
    await store.advanceSchedule({ ...args, lastStatus: "failed", lastError: "boom" } as never)
    expect(ops[1]!.set).toMatchObject({ lastError: "boom", leaseExpiresAt: null })
  })

  it("a failed advance with a retry time keeps the schedule unleased but unclaimable until then", async () => {
    const { store, ops } = build(() => affected(1))
    const retryAt = new Date("2026-03-02T00:00:00.000Z")
    await store.advanceSchedule({ ...args, lastStatus: "failed", lastError: "e", retryAt } as never)
    expect(ops[0]!.set).toMatchObject({ leaseOwner: null, claimToken: null, leaseExpiresAt: retryAt })
    await store.advanceSchedule({ ...args, lastStatus: "failed", lastError: "e" } as never)
    expect(ops[1]!.set).toMatchObject({ leaseExpiresAt: null })
    await store.advanceSchedule({ ...args, lastStatus: "fired", retryAt } as never)
    expect(ops[2]!.set).toMatchObject({ leaseExpiresAt: null })
  })

  it("decrements remaining occurrences by the fired count when the column is mapped", async () => {
    const { store, ops } = build(() => affected(1))
    await store.advanceSchedule({ ...args, lastStatus: "fired" } as never)
    expect(renderedSet(ops[0], "remainingOccurrences")).toEqual({
      sql: 'CASE WHEN "schedules"."remaining_occurrences" IS NULL THEN NULL ELSE GREATEST("schedules"."remaining_occurrences" - $1::integer, 0) END',
      params: [1],
    })
    await store.advanceSchedule({ ...args, lastStatus: "fired", occurrencesFired: 4 } as never)
    expect(renderedSet(ops[1], "remainingOccurrences").params).toEqual([4])
    await store.advanceSchedule({ ...args, lastStatus: "skipped" } as never)
    expect(ops[2]!.set).not.toHaveProperty("remainingOccurrences")
    await store.advanceSchedule({ ...args, lastStatus: "fired", occurrencesFired: 0 } as never)
    expect(ops[3]!.set).not.toHaveProperty("remainingOccurrences")
    const base = build(() => affected(1), { columns: "base" })
    await base.store.advanceSchedule({ ...args, lastStatus: "fired" } as never)
    expect(base.ops[0]!.set).not.toHaveProperty("remainingOccurrences")
  })

  it("advance, release and renew refuse an empty claim token and report lost fences", async () => {
    const f = build(() => affected(1))
    expect(await f.store.advanceSchedule({ ...args, claimToken: "", lastStatus: "success" } as never)).toBe(false)
    expect(await f.store.releaseSchedule({ scheduleId: "s1", workerId: "w1", claimToken: "" } as never)).toBe(false)
    expect(f.ops).toEqual([])
    const lost = build(() => affected(0))
    expect(await lost.store.advanceSchedule({ ...args, lastStatus: "success" } as never)).toBe(false)
    expect(await lost.store.releaseSchedule({ scheduleId: "s1", workerId: "w1", claimToken: "ct" } as never)).toBe(false)
    expect(await lost.store.renewScheduleLease({ scheduleId: "s1", workerId: "w1", claimToken: "ct", extendByMs: 5 } as never)).toBe(false)
  })

  it("release returns the schedule to idle under the fence", async () => {
    const { store, ops } = build(() => affected(1))
    expect(await store.releaseSchedule({ scheduleId: "s1", workerId: "w1", claimToken: "ct" } as never)).toBe(true)
    expect(whereOf(ops[0])).toEqual({ sql: FENCE, params: ["s1", "w1", "ct", "running"] })
    expect(ops[0]!.set).toEqual({ lastStatus: "idle", leaseOwner: null, claimToken: null, leaseExpiresAt: null })
  })

  it("renewal only extends a live owned lease and never shortens it", async () => {
    const { store, ops } = build(() => affected(1))
    expect(await store.renewScheduleLease({ scheduleId: "s1", workerId: "w1", claimToken: "ct", extendByMs: 500 } as never)).toBe(true)
    expect(whereOf(ops[0])).toEqual({ sql: FENCE, params: ["s1", "w1", "ct", "running"] })
    expect(Object.keys(ops[0]!.set as object)).toEqual(["leaseExpiresAt"])
    expect(renderedSet(ops[0], "leaseExpiresAt")).toEqual({ sql: `GREATEST("schedules"."lease_expires_at", now() + ($1 * interval '1 millisecond'))`, params: [500] })
    for (const extendByMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(await store.renewScheduleLease({ scheduleId: "s1", workerId: "w1", claimToken: "ct", extendByMs } as never)).toBe(false)
    expect(ops).toHaveLength(1)
    await expect(store.renewScheduleLease({ scheduleId: "s1", workerId: "x".repeat(101), claimToken: "ct", extendByMs: 5 } as never)).rejects.toThrow("workerId exceeds")
  })

  it("names the missing column in the construction error", () => {
    const { enabled: _enabled, ...withoutEnabled } = allColumns
    expect(() => createDrizzleScheduleStore(createScriptedDb("pg", () => []).db as never, { schedulesTable: schedules as never, columnMap: { schedules: withoutEnabled as never } }))
      .toThrow(new ConfigurationError("Schedule store is missing the required 'enabled' column in its column map"))
  })
})
