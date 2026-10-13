import { describe, expect, it } from "vitest"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { createDrizzleScheduleStore, type DrizzleScheduleStoreConfig } from "../drizzleScheduleStore"
import { DrizzleD1WorkflowStore } from "../drizzleWorkflowStore"

const schedulesTable = sqliteTable("platform_schedules", {
  id: text("id"), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), payload: text("payload"),
  cronExpression: text("cron_expression"), timezone: text("timezone"), enabled: integer("enabled", { mode: "boolean" }), overlapPolicy: text("overlap_policy"), misfirePolicy: text("misfire_policy"),
  nextRunAt: integer("next_run_at", { mode: "timestamp_ms" }), lastRunAt: integer("last_run_at", { mode: "timestamp_ms" }), lastStatus: text("last_status"), lastError: text("last_error"),
  leaseOwner: text("lease_owner"), leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }), claimToken: text("claim_token"),
})
const config = { schedulesTable, columnMap: { schedules: { id: schedulesTable.id, jobType: schedulesTable.jobType, jobVersion: schedulesTable.jobVersion, tenantId: schedulesTable.tenantId, scope: schedulesTable.scope, payload: schedulesTable.payload, cronExpression: schedulesTable.cronExpression, timezone: schedulesTable.timezone, enabled: schedulesTable.enabled, overlapPolicy: schedulesTable.overlapPolicy, misfirePolicy: schedulesTable.misfirePolicy, nextRunAt: schedulesTable.nextRunAt, lastRunAt: schedulesTable.lastRunAt, lastStatus: schedulesTable.lastStatus, lastError: schedulesTable.lastError, leaseOwner: schedulesTable.leaseOwner, leaseExpiresAt: schedulesTable.leaseExpiresAt, claimToken: schedulesTable.claimToken } } } satisfies DrizzleScheduleStoreConfig

const untouchable = (what: string): never => new Proxy({}, { get: (_target, property) => { throw new Error(`${what}.${String(property)} must not be reached for invalid input`) } }) as never
const BAD_LIMITS = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]
const BAD_DURATIONS = [-1, Number.NaN, Number.POSITIVE_INFINITY]
const fence = { instanceId: "i", workerId: "w", claimToken: "t", revision: 1 }

describe("D1 workflow and schedule store input guards", () => {
  const workflows = new DrizzleD1WorkflowStore(untouchable("db"))
  const schedules = createDrizzleScheduleStore(untouchable("session"), config)
  // SQLite reads LIMIT -1 as unbounded and a NULL bind in `lease + ?` clears the lease, so these must be stopped before the statement is built.
  it.each(BAD_LIMITS)("workflow claimDue with limit %s claims nothing and never reaches the database", async (limit) => {
    await expect(workflows.claimDue({ workerId: "w", limit, leaseDurationMs: 1000 })).resolves.toEqual([])
  })
  it.each(BAD_DURATIONS)("workflow claimDue with lease duration %s claims nothing", async (leaseDurationMs) => {
    await expect(workflows.claimDue({ workerId: "w", limit: 1, leaseDurationMs })).resolves.toEqual([])
  })
  it.each([0, ...BAD_DURATIONS])("workflow renewLease with extension %s renews nothing and never reaches the database", async (extendBy) => {
    await expect(workflows.renewLease(fence, extendBy)).resolves.toBe(false)
  })
  it.each(BAD_LIMITS)("schedule claimDueSchedules with limit %s claims nothing and never reaches the database", async (limit) => {
    await expect(schedules.claimDueSchedules({ workerId: "w", limit, leaseDurationMs: 1000 })).resolves.toEqual([])
  })
  it.each(BAD_DURATIONS)("schedule claimDueSchedules with lease duration %s claims nothing", async (leaseDurationMs) => {
    await expect(schedules.claimDueSchedules({ workerId: "w", limit: 1, leaseDurationMs })).resolves.toEqual([])
  })
})
