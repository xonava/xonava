import { describe, expect, it } from "vitest"
import { PgDialect, pgTable, text, integer, boolean, timestamp } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm/sql/sql"
import { createDrizzleScheduleStore, type DrizzleScheduleStoreConfig } from "../drizzleScheduleStore"
import type { DrizzleSessionLike } from "../drizzleRepository"

const schedulesTable = pgTable("platform_schedules", {
  id: text("id"),
  jobType: text("job_type"),
  jobVersion: integer("job_version"),
  tenantId: text("tenant_id"),
  scope: text("scope"),
  payload: text("payload"),
  cronExpression: text("cron_expression"),
  timezone: text("timezone"),
  enabled: boolean("enabled"),
  overlapPolicy: text("overlap_policy"),
  misfirePolicy: text("misfire_policy"),
  nextRunAt: timestamp("next_run_at"),
  lastRunAt: timestamp("last_run_at"),
  lastStatus: text("last_status"),
  lastError: text("last_error"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at"),
  claimToken: text("claim_token"),
})

const config = {
  schedulesTable,
  columnMap: { schedules: {
    id: schedulesTable.id, jobType: schedulesTable.jobType, jobVersion: schedulesTable.jobVersion,
    tenantId: schedulesTable.tenantId, scope: schedulesTable.scope, payload: schedulesTable.payload, cronExpression: schedulesTable.cronExpression,
    timezone: schedulesTable.timezone, enabled: schedulesTable.enabled, overlapPolicy: schedulesTable.overlapPolicy,
    misfirePolicy: schedulesTable.misfirePolicy, nextRunAt: schedulesTable.nextRunAt, lastRunAt: schedulesTable.lastRunAt,
    lastStatus: schedulesTable.lastStatus, lastError: schedulesTable.lastError, leaseOwner: schedulesTable.leaseOwner,
     leaseExpiresAt: schedulesTable.leaseExpiresAt, claimToken: schedulesTable.claimToken,
  } },
} satisfies DrizzleScheduleStoreConfig

function createStore(rows: Record<string, unknown>[], resolveTenantTimezones?: DrizzleScheduleStoreConfig["resolveTenantTimezones"], affectedRows: number[] = []) {
  const updates: Record<string, unknown>[] = []
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => rows,
          orderBy: () => ({
            limit: () => ({ offset: async () => rows }),
          }),
        }),
      }),
    }),
    update: () => ({ set: (values: Record<string, unknown>) => {
      updates.push(values)
      return { where: async () => {
        const rowCount = affectedRows.length > 0 ? affectedRows.shift()! : 1
        if (rowCount > 0 && rows[0]) Object.assign(rows[0], values)
        return { rowCount }
      } }
    } }),
  } as unknown as DrizzleSessionLike
  return { store: createDrizzleScheduleStore(db, { ...config, ...(resolveTenantTimezones ? { resolveTenantTimezones } : {}) }, "Europe/Berlin"), updates }
}

function schedule(id: string, tenantId: string | null, timezone: string | null, scope: string = tenantId ? "tenant" : "platform"): Record<string, unknown> {
  return {
    id, jobType: "test.job", jobVersion: 1, tenantId, scope, payload: "{}", cronExpression: "* * * * *", timezone,
    overlapPolicy: "allow", misfirePolicy: "fire_now", nextRunAt: new Date(), lastRunAt: null, lastStatus: null,
  }
}

const claimArgs = { workerId: "worker-1", leaseDurationMs: 60_000, limit: 10, now: new Date() }

describe("PostgreSQL schedule store timezone resolution", () => {
  it.each([
    ["tenant", "tenant-1"],
    ["platform", null],
    ["system", null],
  ] as const)("preserves the explicit %s schedule scope", async (scope, tenantId) => {
    const claims = await createStore([schedule("scope-test", tenantId, "UTC", scope)]).store.claimDueSchedules(claimArgs)

    expect(claims[0]?.scope).toBe(scope)
  })

  it.each([null, ""])("rejects an invalid schedule scope (%s)", async (scope) => {
    await expect(createStore([schedule("corrupt-scope", null, "UTC", scope as string)]).store.claimDueSchedules(claimArgs))
      .rejects.toThrow("missing or invalid scope")
  })

  it("rejects a missing schedule scope", async () => {
    const row = schedule("corrupt-scope", null, "UTC")
    delete row.scope
    await expect(createStore([row]).store.claimDueSchedules(claimArgs)).rejects.toThrow("missing or invalid scope")
  })

  it("preserves a stored Asia/Kolkata timezone for a platform schedule", async () => {
    const { store, updates } = createStore([schedule("platform-1", null, "Asia/Kolkata")])
    const claims = await store.claimDueSchedules(claimArgs)

    expect(claims[0]?.timezone).toBe("Asia/Kolkata")
    expect(claims[0]?.claimToken).toEqual(expect.any(String))
    expect(updates[0]?.claimToken).toBe(claims[0]?.claimToken)
  })

  it("uses the configured platform timezone only when the stored timezone is absent", async () => {
    const claims = await createStore([schedule("platform-1", null, null)]).store.claimDueSchedules(claimArgs)

    expect(claims[0]?.timezone).toBe("Europe/Berlin")
  })

  it("prefers the tenant timezone and preserves the stored timezone when unresolved", async () => {
    const claims = await createStore(
      [schedule("tenant-1", "tenant-1", "Asia/Kolkata"), schedule("tenant-2", "tenant-2", "America/New_York")],
      async (_db, tenantIds) => new Map([[tenantIds[0]!, "Australia/Sydney"]]),
    ).store.claimDueSchedules(claimArgs)

    expect(claims.map((claim) => claim.timezone)).toEqual(["Australia/Sydney", "America/New_York"])
  })

  it("returns the prior execution status, not the transient claim status", async () => {
    const row = schedule("platform-1", null, "UTC")
    row.lastStatus = "succeeded"
    const claims = await createStore([row]).store.claimDueSchedules(claimArgs)

    expect(claims[0]?.lastStatus).toBe("succeeded")
    expect(row.lastStatus).toBe("running")
  })

  it.each(["id", "jobType", "nextRunAt", "leaseExpiresAt", "claimToken"] as const)(
    "throws a precise ConfigurationError when the %s schedule column is missing from the map",
    (missing) => {
      const { [missing]: _removed, ...schedulesWithout } = config.columnMap.schedules
      expect(() => createDrizzleScheduleStore({} as unknown as DrizzleSessionLike, { ...config, columnMap: { schedules: schedulesWithout } }))
        .toThrow(`'${missing}' column`)
    },
  )

  it("rejects an expired requested renewal expiry", async () => {
    const store = createStore([schedule("platform-1", null, "UTC")]).store
    const now = new Date("2026-08-11T12:00:00.000Z")

    await expect(store.renewScheduleLease({
      scheduleId: "platform-1", workerId: "worker-1", claimToken: "token", now,
      extendByMs: 0,
    })).resolves.toBe(false)
  })

  it("fences a stale worker after a replacement claim", async () => {
    const now = new Date("2026-08-11T12:00:00.000Z")
    const store = createStore([schedule("platform-1", null, "UTC")], undefined, [1, 1, 0, 0]).store
    const first = (await store.claimDueSchedules({ ...claimArgs, now }))[0]!
    const second = (await store.claimDueSchedules({ ...claimArgs, workerId: "worker-2", now: new Date(now.getTime() + 60_001) }))[0]!

    expect(second.claimToken).not.toBe(first.claimToken)
    await expect(store.renewScheduleLease({
      scheduleId: first.scheduleId, workerId: "worker-1", claimToken: first.claimToken,
      now: new Date(now.getTime() + 60_001), extendByMs: 60_000,
    })).resolves.toBe(false)
    await expect(store.advanceSchedule({
      scheduleId: first.scheduleId, workerId: "worker-1", claimToken: first.claimToken,
      nextRunAt: new Date(now.getTime() + 180_000), lastRunAt: now, lastStatus: "succeeded",
    })).resolves.toBe(false)
  })

  it("renews to the later of the current and the requested expiry, so a smaller extension never shortens a lease", async () => {
    const { store, updates } = createStore([schedule("platform-1", null, "UTC")])
    await expect(store.renewScheduleLease({ scheduleId: "platform-1", workerId: "worker-1", claimToken: "token", now: new Date(), extendByMs: 1_000 })).resolves.toBe(true)
    const rendered = new PgDialect().sqlToQuery(updates[0]!.leaseExpiresAt as SQL)
    expect(rendered.sql.toLowerCase()).toMatch(/greatest\(.*lease_expires_at.*now\(\)/)
    expect(rendered.params).toContain(1_000)
  })

  function recordingStore(eligible: Record<string, unknown>[], reread: Record<string, unknown>[]) {
    const conditions: SQL[] = []
    const db = {
      select: () => ({ from: () => ({ where: (condition: SQL) => {
        conditions.push(condition)
        return { orderBy: () => ({ limit: () => ({ offset: async () => eligible }) }), limit: async () => reread }
      } }) }),
      update: () => ({ set: () => ({ where: async () => ({ rowCount: 1 }) }) }),
    } as unknown as DrizzleSessionLike
    return { store: createDrizzleScheduleStore(db, config, "UTC"), conditions }
  }

  it("keeps schedules held by a live claim out of the candidate scan, so they cannot use up the claim limit", async () => {
    const { store, conditions } = recordingStore([], [])
    await store.claimDueSchedules(claimArgs)
    const rendered = new PgDialect().sqlToQuery(conditions[0]!)
    expect(rendered.sql).toContain(`!= 'running'`)
    expect(rendered.sql).toMatch(/"lease_expires_at" < now\(\)/)
  })

  it("returns the claims oldest-due first, whatever order the re-read returns them in", async () => {
    const older = { ...schedule("older", null, "UTC"), nextRunAt: new Date(1_000), claimToken: "t1", leaseOwner: "worker-1", lastStatus: "running", leaseExpiresAt: new Date(Date.now() + 60_000) }
    const newer = { ...schedule("newer", null, "UTC"), nextRunAt: new Date(2_000), claimToken: "t2", leaseOwner: "worker-1", lastStatus: "running", leaseExpiresAt: new Date(Date.now() + 60_000) }
    const { store } = recordingStore([older, newer], [newer, older])
    const claims = await store.claimDueSchedules(claimArgs)
    expect(claims.map((claim) => claim.scheduleId)).toEqual(["older", "newer"])
  })
})
