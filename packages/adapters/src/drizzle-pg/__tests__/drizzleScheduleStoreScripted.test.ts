import { describe, expect, it } from "vitest"
import { getTableColumns } from "drizzle-orm"
import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { ConfigurationError, ValidationError } from "@xonava/core/domain"
import { createDrizzleScheduleStore } from "../drizzleScheduleStore"
import { createScriptedDb, type ScriptedHandler } from "../../__tests__/support/scriptedDb"

const NOW = new Date("2026-03-01T10:00:00.000Z")
const schedules = pgTable("schedules", {
  id: text("id").primaryKey(), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), scopeKey: text("scope_key"), payload: text("payload"),
  cronExpression: text("cron_expression"), timezone: text("timezone"), enabled: boolean("enabled"), overlapPolicy: text("overlap_policy"), misfirePolicy: text("misfire_policy"),
  nextRunAt: timestamp("next_run_at"), lastRunAt: timestamp("last_run_at"), lastStatus: text("last_status"), lastError: text("last_error"), leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at"), claimToken: text("claim_token"),
  paused: boolean("paused"), effectiveFrom: timestamp("effective_from"), effectiveUntil: timestamp("effective_until"), remainingOccurrences: integer("remaining_occurrences"),
  calendarExclusionKey: text("calendar_exclusion_key"), owner: text("owner"), description: text("description"),
})
const baseColumns = () => {
  const { paused, effectiveFrom, effectiveUntil, remainingOccurrences, calendarExclusionKey, owner, description, ...required } = getTableColumns(schedules)
  void paused; void effectiveFrom; void effectiveUntil; void remainingOccurrences; void calendarExclusionKey; void owner; void description
  return required
}
const scheduleRow = (overrides: Record<string, unknown> = {}) => ({
  id: "s1", scope: "system", scopeKey: null, jobType: "report", jobVersion: 1, tenantId: null, payload: "{}", cronExpression: "0 * * * *", timezone: "Europe/Berlin",
  overlapPolicy: "skip", misfirePolicy: "fire_now", nextRunAt: NOW, lastRunAt: null, lastStatus: "idle", claimToken: "ct", ...overrides,
})
const affected = (rowCount: number) => ({ rowCount })

function build(handler: ScriptedHandler, options: { columns?: "full" | "base"; resolveTenantTimezones?: never; platformTimezone?: string } = {}) {
  const scripted = createScriptedDb("pg", handler)
  const columnMap = options.columns === "base" ? baseColumns() : getTableColumns(schedules)
  const store = createDrizzleScheduleStore(scripted.db as never, { schedulesTable: schedules, columnMap: { schedules: columnMap as never }, ...(options.resolveTenantTimezones ? { resolveTenantTimezones: options.resolveTenantTimezones } : {}) }, options.platformTimezone)
  return { store, ops: scripted.ops }
}
const claimArgs = { workerId: "w1", limit: 5, leaseDurationMs: 60_000, now: NOW }

describe("PostgreSQL schedule store: construction", () => {
  it("requires every mandatory column", () => {
    const { id: _id, ...withoutId } = getTableColumns(schedules)
    expect(() => createDrizzleScheduleStore(createScriptedDb("pg", () => []).db as never, { schedulesTable: schedules, columnMap: { schedules: withoutId as never } })).toThrow(ConfigurationError)
  })
})

describe("PostgreSQL schedule store: claiming", () => {
  const claimResponder = (rows: Record<string, unknown>[], claimed: number[] = rows.map(() => 1)): ScriptedHandler => {
    let update = 0
    return (op) => {
      if (op.kind === "update") return affected(claimed[update++] ?? 0)
      return op.fields !== undefined ? rows : rows.map((row) => ({ ...row, lastStatus: "running" }))
    }
  }

  it("claims due schedules, keeping the status observed before the claim and falling back to the platform timezone", async () => {
    const { store, ops } = build(claimResponder([scheduleRow({ id: "a", timezone: "Europe/Berlin", lastStatus: "idle" }), scheduleRow({ id: "b", timezone: null, lastStatus: null })]), { platformTimezone: "Asia/Tokyo" })
    const claims = await store.claimDueSchedules(claimArgs)
    expect(claims.map((claim) => claim.scheduleId)).toEqual(["a", "b"])
    expect(claims[0]).toMatchObject({ claimToken: "ct", timezone: "Europe/Berlin", lastStatus: "idle", overlapPolicy: { type: "skip" }, misfirePolicy: { type: "fire_now" }, scope: "system", executionScope: { kind: "system", systemKey: "framework" } })
    expect(claims[1]).toMatchObject({ timezone: "Asia/Tokyo", lastStatus: null })
    expect(claims[0]!.lifecycle).toEqual({ paused: false })
    const select = ops[0]!
    expect(select).toMatchObject({ kind: "select", limit: 5, offset: 0 })
    expect(Object.keys(select.fields as object)).toEqual(expect.arrayContaining(["paused", "effectiveFrom", "remainingOccurrences", "description"]))
    expect(select.where!.sql).toContain('"enabled" =')
  })

  it("re-checks lifecycle in the update, skips lost races and returns nothing when none were won", async () => {
    const lost = build(claimResponder([scheduleRow()], [0]))
    expect(await lost.store.claimDueSchedules(claimArgs)).toEqual([])
    expect(lost.ops.filter((op) => op.kind === "update")).toHaveLength(1)
    expect(lost.ops.filter((op) => op.kind === "select")).toHaveLength(1)
    const update = lost.ops.find((op) => op.kind === "update")!
    expect(update.set).toMatchObject({ lastStatus: "running", leaseOwner: "w1" })
    expect(update.where!.sql).toContain('"paused" =')
    expect(update.where!.sql).toContain("now()")
    const orderPreserved = build(claimResponder([scheduleRow({ id: "a" }), scheduleRow({ id: "b" })], [1, 1]))
    const rereadReversed: ScriptedHandler = (op) => (op.kind === "update" ? affected(1) : op.fields !== undefined ? [scheduleRow({ id: "a" }), scheduleRow({ id: "b" })] : [scheduleRow({ id: "b" }), scheduleRow({ id: "a" })])
    expect((await build(rereadReversed).store.claimDueSchedules(claimArgs)).map((claim) => claim.scheduleId)).toEqual(["a", "b"])
    void orderPreserved
  })

  it("uses only the mandatory lifecycle predicates when optional columns are unmapped", async () => {
    const { store, ops } = build(claimResponder([scheduleRow()]), { columns: "base" })
    const [claim] = await store.claimDueSchedules(claimArgs)
    expect(ops[0]!.where!.sql).not.toContain("paused")
    expect(Object.keys(ops[0]!.fields as object)).not.toContain("paused")
    expect(claim!.lifecycle).toEqual({ paused: false })
  })

  it("maps lifecycle columns into the claim", async () => {
    const row = scheduleRow({ paused: true, effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveUntil: "2027-01-01T00:00:00.000Z", remainingOccurrences: 0, calendarExclusionKey: "cal", owner: "ops", description: "d", lastRunAt: NOW, lastStatus: "failed", tenantId: "t1", scope: "tenant" })
    const { store } = build(claimResponder([row]))
    const [claim] = await store.claimDueSchedules(claimArgs)
    expect(claim).toMatchObject({ tenantId: "t1", lastRunAt: NOW, lastStatus: "failed", executionScope: { kind: "tenant", tenantId: "t1" } })
    expect(claim!.lifecycle).toEqual({ paused: true, effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveUntil: "2027-01-01T00:00:00.000Z", remainingOccurrences: 0, calendarExclusionKey: "cal", owner: "ops", description: "d" })
  })

  it("applies tenant timezones from the resolver and defaults for the rest", async () => {
    const seen: unknown[] = []
    const resolve = (async (_db: unknown, tenantIds: string[], platform: string) => { seen.push(tenantIds, platform); return new Map([["t1", "America/Chicago"]]) }) as never
    const rows = [scheduleRow({ id: "a", tenantId: "t1", scope: "tenant" }), scheduleRow({ id: "b", tenantId: "t2", scope: "tenant" }), scheduleRow({ id: "c" })]
    const { store } = build(claimResponder(rows), { resolveTenantTimezones: resolve, platformTimezone: "UTC" })
    const claims = await store.claimDueSchedules(claimArgs)
    expect(claims.map((claim) => claim.timezone)).toEqual(["America/Chicago", "Europe/Berlin", "Europe/Berlin"])
    expect(seen).toEqual([["t1", "t2"], "UTC"])
  })

  it("rejects invalid arguments without querying and invalid stored scopes", async () => {
    const { store, ops } = build(() => [])
    await expect(store.claimDueSchedules({ ...claimArgs, workerId: "w".repeat(101) })).rejects.toThrow("workerId exceeds")
    for (const patch of [{ limit: 0 }, { limit: 1.5 }, { leaseDurationMs: -1 }, { leaseDurationMs: Number.NaN }]) expect(await store.claimDueSchedules({ ...claimArgs, ...patch })).toEqual([])
    expect(ops).toEqual([])
    const bad = build(claimResponder([scheduleRow({ scope: "bogus" })]))
    await expect(bad.store.claimDueSchedules(claimArgs)).rejects.toBeInstanceOf(ValidationError)
  })
})

describe("PostgreSQL schedule store: fenced transitions", () => {
  const advance = { scheduleId: "s1", workerId: "w1", claimToken: "ct", nextRunAt: new Date(NOW.getTime() + 3_600_000), lastRunAt: NOW, lastStatus: "idle" }

  it("advances a schedule under its claim fence and consumes remaining occurrences", async () => {
    const { store, ops } = build(() => affected(1))
    expect(await store.advanceSchedule({ ...advance, lastStatus: "idle", lastError: undefined } as never)).toBe(true)
    expect(ops[0]!.set).toMatchObject({ lastStatus: "idle", lastError: null, leaseOwner: null, claimToken: null, leaseExpiresAt: null })
    expect(ops[0]!.where!.sql).toContain("now()")
    expect(await store.advanceSchedule({ ...advance, lastStatus: "fired", occurrencesFired: 3 } as never)).toBe(true)
    expect((ops[1]!.set as Record<string, unknown>).remainingOccurrences).toBeDefined()
    expect(await store.advanceSchedule({ ...advance, lastStatus: "failed", lastError: "boom", retryAt: new Date(NOW.getTime() + 60_000) } as never)).toBe(true)
    expect(ops[2]!.set).toMatchObject({ lastError: "boom", leaseExpiresAt: new Date(NOW.getTime() + 60_000) })
    expect(await store.advanceSchedule({ ...advance, claimToken: "" } as never)).toBe(false)
    expect(ops).toHaveLength(3)
    expect(await build(() => affected(0)).store.advanceSchedule(advance as never)).toBe(false)
    await expect(store.advanceSchedule({ ...advance, occurrencesFired: -1 } as never)).rejects.toThrow("occurrencesFired")
    await store.advanceSchedule({ ...advance, lastStatus: "fired" } as never)
    expect((ops.at(-1)!.set as Record<string, unknown>).remainingOccurrences).toBeDefined()
    const base = build(() => affected(1), { columns: "base" })
    await base.store.advanceSchedule({ ...advance, lastStatus: "fired", occurrencesFired: 3 } as never)
    expect(base.ops[0]!.set).not.toHaveProperty("remainingOccurrences")
  })

  it("releases and renews leases only for the live claim", async () => {
    const { store, ops } = build(() => affected(1))
    expect(await store.releaseSchedule({ scheduleId: "s1", workerId: "w1", claimToken: "ct" })).toBe(true)
    expect(ops[0]!.set).toMatchObject({ lastStatus: "idle", leaseOwner: null })
    expect(await store.releaseSchedule({ scheduleId: "s1", workerId: "w1", claimToken: "" })).toBe(false)
    expect(await build(() => affected(0)).store.releaseSchedule({ scheduleId: "s1", workerId: "w1", claimToken: "ct" })).toBe(false)
    expect(await store.renewScheduleLease({ now: new Date(), scheduleId: "s1", workerId: "w1", claimToken: "ct", extendByMs: 1_000 })).toBe(true)
    expect(ops.at(-1)!.set).toBeDefined()
    expect(await store.renewScheduleLease({ now: new Date(), scheduleId: "s1", workerId: "w1", claimToken: "ct", extendByMs: 0 })).toBe(false)
    expect(await store.renewScheduleLease({ now: new Date(), scheduleId: "s1", workerId: "w1", claimToken: "ct", extendByMs: Number.NaN })).toBe(false)
    await expect(store.renewScheduleLease({ now: new Date(), scheduleId: "s1", workerId: "w".repeat(101), claimToken: "ct", extendByMs: 1 })).rejects.toThrow("workerId exceeds")
    expect(await build(() => affected(0)).store.renewScheduleLease({ now: new Date(), scheduleId: "s1", workerId: "w1", claimToken: "ct", extendByMs: 1_000 })).toBe(false)
  })
})
