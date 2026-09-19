import { describe, expect, it, vi } from "vitest"
import { SQLiteSyncDialect, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { SQL } from "drizzle-orm/sql/sql"
import { ConfigurationError } from "core/domain"
import { createDrizzleJobStore, type DrizzleSessionLike } from "adapters/drizzle-d1"

const jobsTable = sqliteTable("platform_jobs", {
  id: text("id"),
  jobType: text("job_type"),
  jobVersion: integer("job_version"),
  tenantId: text("tenant_id"),
  scope: text("scope"),
  payload: text("payload"),
  status: text("status"),
  priority: integer("priority"),
  attempts: integer("attempts"),
  maxAttempts: integer("max_attempts"),
  runAt: integer("run_at", { mode: "timestamp_ms" }),
  nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
  claimToken: text("claim_token"),
  idempotencyKey: text("idempotency_key"),
  idempotencyScope: text("idempotency_scope"),
  fingerprint: text("fingerprint"),
  correlationId: text("correlation_id"),
  lastError: text("last_error"),
  resultPayload: text("result_payload"),
  metadata: text("metadata"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  partitionKey: text("partition_key"),
})

const executionsTable = sqliteTable("platform_job_executions", {
  id: text("id"),
  jobId: text("job_id"),
  attempt: integer("attempt"),
  workerId: text("worker_id"),
  status: text("status"),
  errorMessage: text("error_message"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
})

const columnMap = {
  jobs: { id: jobsTable.id, jobType: jobsTable.jobType, jobVersion: jobsTable.jobVersion, tenantId: jobsTable.tenantId, scope: jobsTable.scope, payload: jobsTable.payload, status: jobsTable.status, priority: jobsTable.priority, attempts: jobsTable.attempts, maxAttempts: jobsTable.maxAttempts, runAt: jobsTable.runAt, nextAttemptAt: jobsTable.nextAttemptAt, leaseOwner: jobsTable.leaseOwner, leaseExpiresAt: jobsTable.leaseExpiresAt, claimToken: jobsTable.claimToken, idempotencyKey: jobsTable.idempotencyKey, idempotencyScope: jobsTable.idempotencyScope, fingerprint: jobsTable.fingerprint, correlationId: jobsTable.correlationId, lastError: jobsTable.lastError, resultPayload: jobsTable.resultPayload, metadata: jobsTable.metadata, createdAt: jobsTable.createdAt, startedAt: jobsTable.startedAt, completedAt: jobsTable.completedAt, partitionKey: jobsTable.partitionKey },
  executions: { id: executionsTable.id, jobId: executionsTable.jobId, attempt: executionsTable.attempt, workerId: executionsTable.workerId, status: executionsTable.status, errorMessage: executionsTable.errorMessage, startedAt: executionsTable.startedAt, finishedAt: executionsTable.finishedAt },
}

function createStore(options: { affectedRows?: number; historyRequired?: boolean; historyFails?: boolean } = {}) {
  let whereClause: SQL<unknown> | undefined
  let orderByClause: SQL<unknown> | undefined
  const insert = vi.fn(() => options.historyFails ? { values: async () => { throw new Error("history unavailable") } } : undefined)
  const update = vi.fn(() => ({
    set: () => ({
      where: async (where: SQL<unknown> | undefined) => {
        whereClause = where
        return { rowsAffected: options.affectedRows ?? 0 }
      },
    }),
  }))
  const db = {
    insert,
    update,
    ...(options.historyRequired ? {
      atomicJobTransition: async () => {
        if (options.historyFails) throw new Error("history unavailable")
        return { applied: true }
      },
    } : {}),
      select: () => ({
        from: () => ({
          where: (where: SQL<unknown> | undefined) => ({
            limit: async () => {
              whereClause = where
              return []
            },
            orderBy: (orderBy: SQL<unknown>) => {
              orderByClause = orderBy
              return {
                limit: () => ({
                  offset: async () => {
                    whereClause = where
                    return []
                  },
                }),
              }
            },
          }),
        }),
      }),
  } as unknown as DrizzleSessionLike
  return { store: createDrizzleJobStore(db, {
    jobsTable,
    executionsTable,
    ...(options.historyRequired ? { executionHistory: "required" as const } : {}),
    columnMap,
  }), getWhere: () => whereClause, getOrderBy: () => orderByClause, insert, update }
}

describe("D1 job-store idempotency lookup", () => {
  it.each([
    [{ scope: "system" as const }, "system"],
    [{ scope: "platform" as const, actorId: "platform-user" }, "platform"],
    [{ scope: "tenant" as const, tenantId: "tenant-a", actorId: "tenant-user" }, "tenant:tenant-a"],
  ])("includes the %s idempotency scope", async (requester, scope) => {
    const { store, getWhere } = createStore()

    await store.getByIdempotencyKey({ key: "same-key", requester })

    const query = new SQLiteSyncDialect().sqlToQuery(getWhere() as SQL<unknown>)
    expect(query.sql).toContain('"platform_jobs"."idempotency_scope" = ?')
    expect(query.params).toContain(scope)
  })

  it.each(["jobType", "payload", "correlationId", "fingerprint", "createdAt", "partitionKey"] as const)(
    "throws a precise ConfigurationError when the %s column is missing from the map",
    (missing) => {
      const { [missing]: _removed, ...jobsWithout } = columnMap.jobs
      expect(() => createDrizzleJobStore({} as unknown as DrizzleSessionLike, {
        jobsTable,
        executionsTable,
        columnMap: { ...columnMap, jobs: jobsWithout },
      })).toThrow(ConfigurationError)
      expect(() => createDrizzleJobStore({} as unknown as DrizzleSessionLike, {
        jobsTable,
        executionsTable,
        columnMap: { ...columnMap, jobs: jobsWithout },
      })).toThrow(`'${missing}' column`)
    },
  )

  it("resolves the latest prior schedule execution in SQL so newer correlation jobs cannot hide it", async () => {
    const { store, getWhere, getOrderBy } = createStore()

    await store.getLatestPriorScheduleExecution({
      scheduleId: "schedule-1",
      beforeOccurrence: new Date("2026-08-10T10:00:00.000Z"),
      requester: { scope: "platform", actorId: "scheduler" },
    })

    const query = new SQLiteSyncDialect().sqlToQuery(getWhere() as SQL<unknown>)
    expect(query.sql).toContain('"platform_jobs"."correlation_id" = ?')
    expect(query.params).toContain("sched:schedule-1")
    expect(query.sql).toContain('"platform_jobs"."run_at" < ?')
    expect(query.sql).toContain('"platform_jobs"."scope" = ?')
    const ordering = new SQLiteSyncDialect().sqlToQuery(getOrderBy() as SQL<unknown>)
    expect(ordering.sql).toContain('"platform_jobs"."run_at"')
    expect(ordering.sql.toLowerCase()).toContain("desc")
  })

  it("rejects a tenant-mismatched enqueue before persistence", async () => {
    const { store, insert } = createStore()

    await expect(store.enqueue({
      requester: { scope: "tenant", tenantId: "tenant-a", actorId: "tenant-user" },
       job: { executionScope: { kind: "tenant", tenantId: "tenant-b" }, jobType: "test.job", jobVersion: 1, payload: {} },
    })).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
      details: { requesterTenantId: "tenant-a", jobTenantId: "tenant-b" },
    })
    expect(insert).not.toHaveBeenCalled()
  })

  it("guards pending, retrying, and expired-running claims at maxAttempts", async () => {
    const { store, getWhere } = createStore()

    await store.claimDue({
      requester: { scope: "system" },
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      limit: 10,
      now: new Date("2026-08-10T12:00:00.000Z"),
    })

    const query = new SQLiteSyncDialect().sqlToQuery(getWhere() as SQL<unknown>)
    const attemptsGuard = '"platform_jobs"."attempts" < "platform_jobs"."max_attempts"'
    expect(query.sql.match(new RegExp(attemptsGuard, "g"))).toHaveLength(2)
  })

  it.each(["markSucceeded", "markRetrying", "markFailed"] as const)(
    "returns a structured no-op when %s cannot match the current attempt",
    async (method) => {
      const { store, getWhere } = createStore()
      const args = method === "markSucceeded"
         ? { jobId: "job-1", workerId: "worker-1", claimToken: "claim-1", attempt: 2, result: { ok: true } }
        : method === "markRetrying"
           ? { jobId: "job-1", workerId: "worker-1", claimToken: "claim-1", attempt: 2, nextAttemptAt: new Date(), error: "retry" }
           : { jobId: "job-1", workerId: "worker-1", claimToken: "claim-1", attempt: 2, status: "failed" as const, error: "failed" }

      await expect(store[method](args as never)).resolves.toEqual({ applied: false, reason: "LEASE_LOST" })

      const query = new SQLiteSyncDialect().sqlToQuery(getWhere() as SQL<unknown>)
      expect(query.sql).toContain('"platform_jobs"."attempts" = ?')
      expect(query.params).toContain(2)
      expect(query.sql).toContain('"platform_jobs"."claim_token" = ?')
      expect(query.params).toContain("claim-1")
    },
  )

  it("throws ConfigurationError when required execution history lacks atomic transition support", () => {
    const db = { insert: vi.fn(), update: vi.fn(), select: vi.fn() } as unknown as DrizzleSessionLike
    expect(() => createDrizzleJobStore(db, {
      jobsTable,
      executionsTable,
      executionHistory: "required",
      columnMap,
    })).toThrow(ConfigurationError)
    expect(() => createDrizzleJobStore(db, {
      jobsTable,
      executionsTable,
      columnMap,
    })).not.toThrow(ConfigurationError)
  })

  it("does not apply a required transition when execution history fails", async () => {
    const { store, update } = createStore({ affectedRows: 1, historyRequired: true, historyFails: true })
    await expect(store.markSucceeded({ jobId: "job-1", workerId: "worker-1", claimToken: "claim-1", attempt: 1 })).resolves.toMatchObject({
      applied: false,
      reason: "HISTORY_FAILED",
      historyError: "Execution history persistence failed: history unavailable",
    })
    expect(update).not.toHaveBeenCalled()
  })

  it("uses numeric epoch milliseconds for lease expiry (SQLite compatibility)", async () => {
    let capturedSet: Record<string, unknown> | undefined
    const eligibleRow = { id: "job-eligible-1", scope: "system", status: "pending", nextAttemptAt: 0, runAt: 0, attempts: 0, maxAttempts: 3, partitionKey: "p1", leaseExpiresAt: 0, fingerprint: "test-fingerprint" }
    const db = {
      insert: vi.fn(),
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => {
          capturedSet = values
          return { where: async () => ({ rowsAffected: 1 }) }
        },
      })),
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
    } as unknown as DrizzleSessionLike

    const store = createDrizzleJobStore(db, { jobsTable, executionsTable, columnMap })
    await store.claimDue({
      requester: { scope: "system" },
      workerId: "worker-1",
      leaseDurationMs: 30_000,
      limit: 10,
      now: new Date("2026-08-10T12:00:00.000Z"),
    })

    expect(capturedSet).toBeDefined()
    const rendered = new SQLiteSyncDialect().sqlToQuery(capturedSet!.leaseExpiresAt as SQL<unknown>)
    expect(rendered.sql).toContain("julianday('now')")
    expect(rendered.sql).toContain("CAST")
    expect(rendered.params).toContain(30_000)
  })

  it.each([
    [1500, 1],
    [999, 0],
    [1, 0],
    [0, 0],
    [1001, 1],
    [1_500_000, 1500],
  ])("uses the exact %dms duration in lease expiry SQL", async (ms) => {
    let capturedSet: Record<string, unknown> | undefined
    const eligibleRow = { id: "job-edge-1", scope: "system", status: "pending", nextAttemptAt: 0, runAt: 0, attempts: 0, maxAttempts: 3, partitionKey: "p1", leaseExpiresAt: 0, fingerprint: "test-fingerprint" }
    const db = {
      insert: vi.fn(),
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => {
          capturedSet = values
          return { where: async () => ({ rowsAffected: 1 }) }
        },
      })),
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
    } as unknown as DrizzleSessionLike

    const store = createDrizzleJobStore(db, { jobsTable, executionsTable, columnMap })
    await store.claimDue({
      requester: { scope: "system" },
      workerId: "worker-1",
      leaseDurationMs: ms,
      limit: 10,
      now: new Date("2026-08-10T12:00:00.000Z"),
    })

    expect(capturedSet).toBeDefined()
    const rendered = new SQLiteSyncDialect().sqlToQuery(capturedSet!.leaseExpiresAt as SQL<unknown>)
    expect(rendered.sql).toContain("julianday('now')")
    expect(rendered.params).toContain(ms)
  })

  it("uses numeric epoch milliseconds for lease renewal", async () => {
    let capturedSet: Record<string, unknown> | undefined
    const db = {
      insert: vi.fn(),
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => {
          capturedSet = values
          return { where: async () => ({ rowsAffected: 1 }) }
        },
      })),
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
    } as unknown as DrizzleSessionLike

    const store = createDrizzleJobStore(db, { jobsTable, executionsTable, columnMap })
    await store.renewLease({
      jobId: "job-1",
      workerId: "worker-1",
      claimToken: "claim-1",
      extendByMs: 60_000,
    })

    expect(capturedSet).toBeDefined()
    const rendered = new SQLiteSyncDialect().sqlToQuery(capturedSet!.leaseExpiresAt as SQL<unknown>)
    expect(rendered.sql).toContain("julianday('now')")
    expect(rendered.params).toContain(60_000)
  })
})
