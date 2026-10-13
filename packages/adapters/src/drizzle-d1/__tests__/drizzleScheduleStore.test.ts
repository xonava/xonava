import { describe, expect, it, vi } from "vitest"
import { SQLiteSyncDialect, sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import type { SQL } from "drizzle-orm/sql/sql"
import { createDrizzleScheduleStore, type DrizzleScheduleStoreConfig } from "../drizzleScheduleStore"
import type { DrizzleSessionLike } from "../drizzleRepository"

const schedulesTable = sqliteTable("platform_schedules", {
  id: text("id"),
  jobType: text("job_type"),
  jobVersion: integer("job_version"),
  tenantId: text("tenant_id"),
  scope: text("scope"),
  payload: text("payload"),
  cronExpression: text("cron_expression"),
  timezone: text("timezone"),
  enabled: integer("enabled", { mode: "boolean" }),
  overlapPolicy: text("overlap_policy"),
  misfirePolicy: text("misfire_policy"),
  nextRunAt: integer("next_run_at", { mode: "timestamp_ms" }),
  lastRunAt: integer("last_run_at", { mode: "timestamp_ms" }),
  lastStatus: text("last_status"),
  lastError: text("last_error"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
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

function createStore(rows: Record<string, unknown>[], resolveTenantTimezones?: DrizzleScheduleStoreConfig["resolveTenantTimezones"], affectedRows: number[] = [], beforeUpdate?: () => void | Promise<void>) {
  let updateCount = 0
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          const result = Promise.resolve(rows)
          return {
            orderBy: () => ({
              limit: () => ({ offset: async () => rows }),
            }),
            limit: async () => result,
          }
        },
      }),
    }),
    update: () => ({ set: (values: Record<string, unknown>) => ({ where: async () => {
      const updateIndex = updateCount++
      await beforeUpdate?.()
      const changes = affectedRows.length > 0 ? affectedRows.shift()! : 1
      const row = rows.length === 1 ? rows[0] : rows[updateIndex % rows.length]
      if (changes > 0 && row) Object.assign(row, values)
      return { changes }
    } }) }),
  } as unknown as DrizzleSessionLike
  return createDrizzleScheduleStore(db, { ...config, ...(resolveTenantTimezones ? { resolveTenantTimezones } : {}) }, "Europe/Berlin")
}

function schedule(id: string, tenantId: string | null, timezone: string | null, scope: string = tenantId ? "tenant" : "platform"): Record<string, unknown> {
  return {
    id, jobType: "test.job", jobVersion: 1, tenantId, scope, payload: "{}", cronExpression: "* * * * *", timezone,
    overlapPolicy: "allow", misfirePolicy: "fire_now", nextRunAt: Date.now(), lastRunAt: null, lastStatus: null,
    claimToken: `persisted-${id}`,
  }
}

const claimArgs = { workerId: "worker-1", leaseDurationMs: 60_000, limit: 10, now: new Date() }

describe("D1 schedule store timezone resolution", () => {
  it.each([
    ["tenant", "tenant-1"],
    ["platform", null],
    ["system", null],
  ] as const)("preserves the explicit %s schedule scope", async (scope, tenantId) => {
    const claims = await createStore([schedule("scope-test", tenantId, "UTC", scope)]).claimDueSchedules(claimArgs)

    expect(claims[0]?.scope).toBe(scope)
  })

  it.each([null, ""])("rejects an invalid schedule scope (%s)", async (scope) => {
    await expect(createStore([schedule("corrupt-scope", null, "UTC", scope as string)]).claimDueSchedules(claimArgs))
      .rejects.toThrow("missing or invalid scope")
  })

  it("rejects a missing schedule scope", async () => {
    const row = schedule("corrupt-scope", null, "UTC")
    delete row.scope
    await expect(createStore([row]).claimDueSchedules(claimArgs)).rejects.toThrow("missing or invalid scope")
  })

  it("preserves a stored Asia/Kolkata timezone for a platform schedule", async () => {
    const claims = await createStore([schedule("platform-1", null, "Asia/Kolkata")]).claimDueSchedules(claimArgs)

    expect(claims[0]?.timezone).toBe("Asia/Kolkata")
    expect(claims[0]?.claimToken).toEqual(expect.any(String))
  })

  it("uses the configured platform timezone only when the stored timezone is absent", async () => {
    const claims = await createStore([schedule("platform-1", null, null)]).claimDueSchedules(claimArgs)

    expect(claims[0]?.timezone).toBe("Europe/Berlin")
  })

  it("prefers the tenant timezone and preserves the stored timezone when unresolved", async () => {
    const claims = await createStore(
      [schedule("tenant-1", "tenant-1", "Asia/Kolkata"), schedule("tenant-2", "tenant-2", "America/New_York")],
      async (_db, tenantIds) => new Map([[tenantIds[0]!, "Australia/Sydney"]]),
    ).claimDueSchedules(claimArgs)

    expect(claims.map((claim) => claim.timezone)).toEqual(["Australia/Sydney", "America/New_York"])
  })

  it("returns the prior execution status, not the transient claim status", async () => {
    const row = schedule("platform-1", null, "UTC")
    row.lastStatus = "succeeded"
    const claims = await createStore([row]).claimDueSchedules(claimArgs)

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
    const store = createStore([schedule("platform-1", null, "UTC")])
    const now = new Date("2026-08-11T12:00:00.000Z")

    await expect(store.renewScheduleLease({
      scheduleId: "platform-1", workerId: "worker-1", claimToken: "token", now,
      extendByMs: 0,
    })).resolves.toBe(false)
  })

  it("fences a stale worker after a replacement claim", async () => {
    const now = new Date("2026-08-11T12:00:00.000Z")
    const store = createStore([schedule("platform-1", null, "UTC")], undefined, [1, 1, 0, 0])
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

  it("lets only the worker that wins the conditional update claim a raced schedule", async () => {
    const now = new Date("2026-08-11T12:00:00.000Z")
    const row = schedule("platform-1", null, "UTC")
    row.nextRunAt = now.getTime()
    let releaseFirstUpdate!: () => void
    const firstUpdate = new Promise<void>((resolve) => { releaseFirstUpdate = resolve })
    let secondUpdateStarted!: () => void
    const secondUpdate = new Promise<void>((resolve) => { secondUpdateStarted = resolve })
    let callbackCount = 0
    const store = createStore([row], undefined, [0, 1], async () => {
      callbackCount++
      if (callbackCount === 1) await firstUpdate
      if (callbackCount === 2) {
        secondUpdateStarted()
        releaseFirstUpdate()
      }
    })

    const firstPromise = store.claimDueSchedules({ ...claimArgs, workerId: "worker-1", now })
    const secondPromise = store.claimDueSchedules({ ...claimArgs, workerId: "worker-2", now })
    await secondUpdate
    const second = await secondPromise
    const first = await firstPromise

    expect(first.length + second.length).toBe(1)
    const winner = first[0] ?? second[0]
    expect(row.leaseOwner).toBe(winner?.scheduleId === first[0]?.scheduleId ? "worker-1" : "worker-2")
    expect(row.claimToken).toBe(winner?.claimToken)
  })

  it("recovers a partial claim after the claiming worker fails", async () => {
    const now = new Date("2026-08-11T12:00:00.000Z")
    const rows = [schedule("platform-1", null, "UTC"), schedule("platform-2", null, "UTC")]
    for (const row of rows) row.nextRunAt = now.getTime()
    let callbackCount = 0
    const store = createStore(rows, undefined, [1], () => {
      callbackCount++
      if (callbackCount === 2) throw new Error("worker crashed after claiming")
    })

    await expect(store.claimDueSchedules({ ...claimArgs, now })).rejects.toThrow("worker crashed after claiming")
    expect(rows[0]?.lastStatus).toBe("running")
    rows[0]!.leaseExpiresAt = now.getTime()

    const recovered = await store.claimDueSchedules({
      ...claimArgs,
      workerId: "worker-2",
      now: new Date(now.getTime() + 60_000),
    })

    expect(recovered).toHaveLength(2)
    expect(recovered[0]?.claimToken).not.toBe("persisted-platform-1")
  })

  it("reclaims an expired lease at its exact expiry and repairs a missing expiry", async () => {
    const now = new Date("2026-08-11T12:00:00.000Z")
    const row = schedule("platform-1", null, "UTC")
    row.lastStatus = "running"
    row.leaseOwner = "dead-worker"
    row.leaseExpiresAt = now.getTime()
    row.nextRunAt = now.getTime()
    const store = createStore([row])

    const claims = await store.claimDueSchedules({ ...claimArgs, workerId: "worker-2", now })

    expect(claims).toHaveLength(1)
    expect(claims[0]?.claimToken).not.toBe("persisted-platform-1")

    row.lastStatus = "running"
    row.leaseExpiresAt = null
    expect(await store.claimDueSchedules({ ...claimArgs, workerId: "worker-3", now })).toHaveLength(1)
  })

  it("uses numeric epoch milliseconds for lease expiry in claimDueSchedules (SQLite compatibility)", async () => {
    let capturedSet: Record<string, unknown> | undefined
    const eligibleRow = { id: "sched-1", scope: "platform", jobType: "test.job", jobVersion: 1, tenantId: null, payload: "{}", cronExpression: "* * * * *", timezone: "UTC", overlapPolicy: "allow", misfirePolicy: "fire_now", nextRunAt: Date.now(), lastRunAt: null, lastStatus: null, enabled: true }
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [eligibleRow]),
            orderBy: () => ({
              limit: () => ({
                offset: async () => [eligibleRow],
              }),
            }),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => {
          capturedSet = values
          return { where: async () => ({ changes: 1 }) }
        },
      })),
    } as unknown as DrizzleSessionLike

    const store = createDrizzleScheduleStore(db, { ...config }, "UTC")
    await store.claimDueSchedules({ workerId: "worker-1", leaseDurationMs: 45_000, limit: 10, now: new Date() })

    expect(capturedSet).toBeDefined()
    const rendered = new SQLiteSyncDialect().sqlToQuery(capturedSet!.leaseExpiresAt as SQL<unknown>)
    expect(rendered.sql).toContain("julianday('now')")
    expect(rendered.params).toContain(45_000)
  })

  it.each([
    [1500, 1],
    [999, 0],
    [1, 0],
    [0, 0],
    [1001, 1],
  ])("uses the exact %dms duration in schedule lease expiry SQL", async (ms) => {
    let capturedSet: Record<string, unknown> | undefined
    const eligibleRow = { id: "sched-edge-1", scope: "platform", jobType: "test.job", jobVersion: 1, tenantId: null, payload: "{}", cronExpression: "* * * * *", timezone: "UTC", overlapPolicy: "allow", misfirePolicy: "fire_now", nextRunAt: Date.now(), lastRunAt: null, lastStatus: null, enabled: true }
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [eligibleRow]),
            orderBy: () => ({
              limit: () => ({
                offset: async () => [eligibleRow],
              }),
            }),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => {
          capturedSet = values
          return { where: async () => ({ changes: 1 }) }
        },
      })),
    } as unknown as DrizzleSessionLike

    const store = createDrizzleScheduleStore(db, { ...config }, "UTC")
    await store.claimDueSchedules({ workerId: "worker-1", leaseDurationMs: ms, limit: 10, now: new Date() })

    expect(capturedSet).toBeDefined()
    const rendered = new SQLiteSyncDialect().sqlToQuery(capturedSet!.leaseExpiresAt as SQL<unknown>)
    expect(rendered.sql).toContain("julianday('now')")
    expect(rendered.params).toContain(ms)
  })

  it("uses numeric epoch milliseconds for lease renewal in renewScheduleLease", async () => {
    let capturedSet: Record<string, unknown> | undefined
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: async () => [],
            orderBy: () => ({
              limit: () => ({
                offset: async () => [],
              }),
            }),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => {
          capturedSet = values
          return { where: async () => ({ changes: 1 }) }
        },
      })),
    } as unknown as DrizzleSessionLike

    const store = createDrizzleScheduleStore(db, { ...config }, "UTC")
    const now = new Date("2026-08-11T12:00:00.000Z")
    await store.renewScheduleLease({
      scheduleId: "sched-1", workerId: "worker-1", claimToken: "token", now, extendByMs: 90_000,
    })

    expect(capturedSet).toBeDefined()
    const rendered = new SQLiteSyncDialect().sqlToQuery(capturedSet!.leaseExpiresAt as SQL<unknown>)
    expect(rendered.sql).toContain("julianday('now')")
    expect(rendered.params).toContain(90_000)
  })

  it("renews to the later of the current and the requested expiry, so a smaller extension never shortens a lease", async () => {
    let capturedSet: Record<string, unknown> | undefined
    const db = { update: () => ({ set: (values: Record<string, unknown>) => { capturedSet = values; return { where: async () => ({ changes: 1 }) } } }) } as unknown as DrizzleSessionLike
    const store = createDrizzleScheduleStore(db, { ...config }, "UTC")
    await store.renewScheduleLease({ scheduleId: "sched-1", workerId: "worker-1", claimToken: "token", now: new Date(), extendByMs: 1_000 })
    const rendered = new SQLiteSyncDialect().sqlToQuery(capturedSet!.leaseExpiresAt as SQL<unknown>)
    expect(rendered.sql.toLowerCase()).toMatch(/max\(.*lease_expires_at.*julianday/)
  })

  function recordingStore(eligible: Record<string, unknown>[], reread: Record<string, unknown>[]) {
    const conditions: SQL[] = []
    const db = {
      select: () => ({ from: () => ({ where: (condition: SQL) => {
        conditions.push(condition)
        return { orderBy: () => ({ limit: () => ({ offset: async () => eligible }) }), limit: async () => reread }
      } }) }),
      update: () => ({ set: () => ({ where: async () => ({ changes: 1 }) }) }),
    } as unknown as DrizzleSessionLike
    return { store: createDrizzleScheduleStore(db, { ...config }, "UTC"), conditions }
  }

  it("keeps schedules held by a live claim out of the candidate scan, so they cannot use up the claim limit", async () => {
    const { store, conditions } = recordingStore([], [])
    await store.claimDueSchedules({ workerId: "worker-1", leaseDurationMs: 60_000, limit: 10, now: new Date() })
    const rendered = new SQLiteSyncDialect().sqlToQuery(conditions[0]!)
    expect(rendered.sql).toContain(`!= 'running'`)
    expect(rendered.sql).toMatch(/"lease_expires_at" <= /)
  })

  it("returns the claims oldest-due first, whatever order the re-read returns them in", async () => {
    const base = { jobType: "j", jobVersion: 1, tenantId: null, scope: "system", payload: "{}", cronExpression: "* * * * *", timezone: "UTC", overlapPolicy: "allow", misfirePolicy: "fire_now", lastRunAt: null, lastStatus: null, claimToken: "t", leaseOwner: "worker-1" }
    const older = { ...base, id: "older", nextRunAt: 1_000 }
    const newer = { ...base, id: "newer", nextRunAt: 2_000 }
    const { store } = recordingStore([older, newer], [newer, older])
    const claims = await store.claimDueSchedules({ workerId: "worker-1", leaseDurationMs: 60_000, limit: 10, now: new Date() })
    expect(claims.map((claim) => claim.scheduleId)).toEqual(["older", "newer"])
  })
})
