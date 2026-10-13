import { describe, expect, it } from "vitest"
import { DrizzleMySqlScheduleStore } from "../drizzleScheduleStore"
import { DrizzleMySqlWorkflowStore } from "../drizzleWorkflowStore"

const untouchable = (what: string): never => new Proxy({}, { get: (_target, property) => { throw new Error(`${what}.${String(property)} must not be reached for invalid input`) } }) as never
const BAD_LIMITS = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]
const BAD_DURATIONS = [-1, Number.NaN, Number.POSITIVE_INFINITY]
const fence = { instanceId: "i", workerId: "w", claimToken: "t", revision: 1 }

describe("MySQL workflow and schedule store input guards", () => {
  const workflows = new DrizzleMySqlWorkflowStore(untouchable("pool"))
  const schedules = new DrizzleMySqlScheduleStore(untouchable("pool"))
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
