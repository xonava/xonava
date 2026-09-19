/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, expect, it, vi } from "vitest"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import { PgDialect } from "drizzle-orm/pg-core/dialect"
import type { SQL } from "drizzle-orm/sql/sql"
import { ConfigurationError } from "core/domain"
import { createDrizzleJobStore, type DrizzleSessionLike } from "adapters/drizzle-pg"

const jobsTable = pgTable("platform_jobs", {
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
  runAt: text("run_at"),
  nextAttemptAt: text("next_attempt_at"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: text("lease_expires_at"),
  claimToken: text("claim_token"),
  idempotencyKey: text("idempotency_key"),
  idempotencyScope: text("idempotency_scope"),
  fingerprint: text("fingerprint"),
  correlationId: text("correlation_id"),
  lastError: text("last_error"),
  resultPayload: text("result_payload"),
  metadata: text("metadata"),
  createdAt: text("created_at"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  partitionKey: text("partition_key"),
})

const executionsTable = pgTable("platform_job_executions", {
  id: text("id"),
  jobId: text("job_id"),
  attempt: integer("attempt"),
  workerId: text("worker_id"),
  status: text("status"),
  errorMessage: text("error_message"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
})

const columnMap = {
  jobs: { id: jobsTable.id, jobType: jobsTable.jobType, jobVersion: jobsTable.jobVersion, tenantId: jobsTable.tenantId, scope: jobsTable.scope, payload: jobsTable.payload, status: jobsTable.status, priority: jobsTable.priority, attempts: jobsTable.attempts, maxAttempts: jobsTable.maxAttempts, runAt: jobsTable.runAt, nextAttemptAt: jobsTable.nextAttemptAt, leaseOwner: jobsTable.leaseOwner, claimToken: jobsTable.claimToken, leaseExpiresAt: jobsTable.leaseExpiresAt, idempotencyKey: jobsTable.idempotencyKey, idempotencyScope: jobsTable.idempotencyScope, fingerprint: jobsTable.fingerprint, correlationId: jobsTable.correlationId, lastError: jobsTable.lastError, resultPayload: jobsTable.resultPayload, metadata: jobsTable.metadata, createdAt: jobsTable.createdAt, startedAt: jobsTable.startedAt, completedAt: jobsTable.completedAt, partitionKey: jobsTable.partitionKey },
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

describe("PostgreSQL job-store idempotency lookup", () => {
  it("rejects an existing job with no fingerprint", async () => {
    const db = {
      insert: vi.fn(() => ({ values: async () => { throw Object.assign(new Error("unique constraint"), { code: "23505" }) } })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: async () => [{ fingerprint: null }] })),
        })),
      })),
    } as unknown as DrizzleSessionLike
    const store = createDrizzleJobStore(db, { jobsTable, executionsTable, columnMap })

    await expect(store.enqueue({
      requester: { scope: "platform", actorId: "worker-1" },
      job: { executionScope: { kind: "platform", platformKey: "default" }, jobType: "test.job", jobVersion: 1, payload: {}, idempotencyKey: "job-1" },
    })).rejects.toThrow("fingerprint is missing")
  })

  it("requires a partitionKey column to serialize schedule execution", () => {
    const { partitionKey: _partitionKey, ...jobsWithoutPartition } = columnMap.jobs
    expect(() => createDrizzleJobStore({} as unknown as DrizzleSessionLike, {
      jobsTable,
      executionsTable,
      columnMap: { ...columnMap, jobs: jobsWithoutPartition },
    })).toThrow("'partitionKey' column")
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

  it.each([
    [{ scope: "system" as const }, "system"],
    [{ scope: "platform" as const, actorId: "platform-user" }, "platform"],
    [{ scope: "tenant" as const, tenantId: "tenant-a", actorId: "tenant-user" }, "tenant:tenant-a"],
  ])("includes the %s idempotency scope", async (requester, scope) => {
    const { store, getWhere } = createStore()

    await store.getByIdempotencyKey({ key: "same-key", requester })

    const query = new PgDialect().sqlToQuery(getWhere() as SQL<unknown>)
    expect(query.sql).toContain('"platform_jobs"."idempotency_scope" = $2')
    expect(query.params).toContain(scope)
  })

  it("resolves the latest prior schedule execution in SQL so newer correlation jobs cannot hide it", async () => {
    const { store, getWhere, getOrderBy } = createStore()

    await store.getLatestPriorScheduleExecution({
      scheduleId: "schedule-1",
      beforeOccurrence: new Date("2026-08-10T10:00:00.000Z"),
      requester: { scope: "platform", actorId: "scheduler" },
    })

    const query = new PgDialect().sqlToQuery(getWhere() as SQL<unknown>)
    expect(query.sql).toContain('"platform_jobs"."correlation_id" = $1')
    expect(query.params).toContain("sched:schedule-1")
    expect(query.sql).toContain('"platform_jobs"."run_at" < $2')
    expect(query.sql).toContain('"platform_jobs"."scope" = $3')
    const ordering = new PgDialect().sqlToQuery(getOrderBy() as SQL<unknown>)
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

      const query = new PgDialect().sqlToQuery(getWhere() as SQL<unknown>)
      expect(query.sql).toContain('"platform_jobs"."attempts" = $')
      expect(query.params).toContain(2)
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
})

describe("PostgreSQL job-store column-rename conformance (P1-11)", () => {
  /**
   * Verifies that the job store works correctly when physical column names
   * differ from the canonical names. The column map allows callers to use
   * renamed columns in their schema, and the store derives the correct physical
   * names for SQL generation (e.g. the `noRunningSibling` subquery in claimDue
   * uses `partition`, `job_status`, `lease_expiry`, and `pk_id` derived from
   * the column objects).
   *
   * Key constraint: TypeScript field names MUST stay the same as the original
   * table (id, status, partitionKey, etc.) because `toStoredJob()` reads the
   * row by these hardcoded names. Only the *physical* column names differ.
   */
  const renamedJobsTable = pgTable("app_jobs", {
    id: text("pk_id"),                // physical: pk_id (was: id)
    jobType: text("job_type"),
    jobVersion: integer("job_version"),
    tenantId: text("tenant_id"),
    scope: text("scope"),
    payload: text("payload"),
    status: text("job_status"),        // physical: job_status (was: status)
    priority: integer("priority"),
    attempts: integer("attempts"),
    maxAttempts: integer("max_attempts"),
    runAt: text("run_at"),
    nextAttemptAt: text("next_attempt_at"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expiry"), // physical: lease_expiry (was: lease_expires_at)
    claimToken: text("claim_token"),
    idempotencyKey: text("idempotency_key"),
    idempotencyScope: text("idempotency_scope"),
    fingerprint: text("fingerprint"),
    correlationId: text("correlation_id"),
    lastError: text("last_error"),
    resultPayload: text("result_payload"),
    metadata: text("metadata"),
    createdAt: text("created_at"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    partitionKey: text("app_partition"), // physical: app_partition (was: partition_key)
  })

  const renamedExecutionsTable = pgTable("app_job_executions", {
    id: text("ex_id"),
    jobId: text("ex_job_id"),
    attempt: integer("ex_attempt"),
    workerId: text("ex_worker_id"),
    status: text("ex_status"),
    errorMessage: text("ex_error_message"),
    startedAt: text("ex_started_at"),
    finishedAt: text("ex_finished_at"),
  })

  const renamedColumnMap = {
    jobs: {
      id: renamedJobsTable.id,
      jobType: renamedJobsTable.jobType,
      jobVersion: renamedJobsTable.jobVersion,
      tenantId: renamedJobsTable.tenantId,
      scope: renamedJobsTable.scope,
      payload: renamedJobsTable.payload,
      status: renamedJobsTable.status,
      priority: renamedJobsTable.priority,
      attempts: renamedJobsTable.attempts,
      maxAttempts: renamedJobsTable.maxAttempts,
      runAt: renamedJobsTable.runAt,
      nextAttemptAt: renamedJobsTable.nextAttemptAt,
      leaseOwner: renamedJobsTable.leaseOwner,
      leaseExpiresAt: renamedJobsTable.leaseExpiresAt,
      claimToken: renamedJobsTable.claimToken,
      idempotencyKey: renamedJobsTable.idempotencyKey,
      idempotencyScope: renamedJobsTable.idempotencyScope,
      fingerprint: renamedJobsTable.fingerprint,
      correlationId: renamedJobsTable.correlationId,
      lastError: renamedJobsTable.lastError,
      resultPayload: renamedJobsTable.resultPayload,
      metadata: renamedJobsTable.metadata,
      createdAt: renamedJobsTable.createdAt,
      startedAt: renamedJobsTable.startedAt,
      completedAt: renamedJobsTable.completedAt,
      partitionKey: renamedJobsTable.partitionKey,
    },
    executions: {
      id: renamedExecutionsTable.id,
      jobId: renamedExecutionsTable.jobId,
      attempt: renamedExecutionsTable.attempt,
      workerId: renamedExecutionsTable.workerId,
      status: renamedExecutionsTable.status,
      errorMessage: renamedExecutionsTable.errorMessage,
      startedAt: renamedExecutionsTable.startedAt,
      finishedAt: renamedExecutionsTable.finishedAt,
    },
  }

  function createRenamedStore(options: { affectedRows?: number; selectResult?: unknown[]; historyRequired?: boolean } = {}) {
    let lastWhere: SQL<unknown> | undefined
    const insert = vi.fn(() => ({ values: vi.fn(async () => ({ rowCount: 1 })) }))
    const db = {
      insert,
      update: vi.fn(() => ({
        set: () => ({
          where: async (where: SQL<unknown> | undefined) => {
            lastWhere = where
            return { rowCount: options.affectedRows ?? 0, rowsAffected: options.affectedRows ?? 0 }
          },
        }),
      })),
      select: () => ({
        from: () => ({
          where: (where: SQL<unknown> | undefined) => ({
            limit: async () => {
              lastWhere = where
              return options.selectResult ?? []
            },
            orderBy: () => ({
              limit: () => ({
                offset: async () => {
                  lastWhere = where
                  return options.selectResult ?? []
                },
              }),
            }),
          }),
        }),
      }),
      ...(options.historyRequired ? {
        atomicJobTransition: async () => ({ applied: true }),
      } : {}),
    } as unknown as DrizzleSessionLike

    const store = createDrizzleJobStore(db, {
      jobsTable: renamedJobsTable,
      executionsTable: renamedExecutionsTable,
      columnMap: renamedColumnMap,
    })

    return { store, getWhere: () => lastWhere, insert }
  }

  it("constructs without errors using renamed physical columns", () => {
    const db = { insert: vi.fn(), update: vi.fn(), select: vi.fn() } as unknown as DrizzleSessionLike
    expect(() => createDrizzleJobStore(db, {
      jobsTable: renamedJobsTable,
      executionsTable: renamedExecutionsTable,
      columnMap: renamedColumnMap,
    })).not.toThrow()
  })

  it("enqueue succeeds with renamed physical columns", async () => {
    // Mock select returns row using the TS field names (id, status, etc.)
    // which match the table's TS property names, NOT the physical column names.
    const selectResult = [{
      id: "job-1",
      jobType: "test.job",
      jobVersion: 1,
      tenantId: null,
      scope: "platform",
      payload: '{"data":1}',
      status: "pending",
      priority: 0,
      attempts: 0,
      maxAttempts: 3,
      runAt: "2026-01-01T00:00:00.000Z",
      nextAttemptAt: "2026-01-01T00:00:00.000Z",
      leaseOwner: null,
      leaseExpiresAt: null,
      claimToken: null,
      idempotencyKey: null,
      idempotencyScope: null,
      fingerprint: "test-fingerprint",
      correlationId: null,
      lastError: null,
      resultPayload: null,
      metadata: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      partitionKey: null,
    }]

    const { store, insert, getWhere } = createRenamedStore({ selectResult })

    const job = await store.enqueue({
      requester: { scope: "platform", actorId: "platform-user" },
      job: { executionScope: { kind: "platform", platformKey: "default" }, jobType: "test.job", jobVersion: 1, payload: { data: 1 } },
    })

    expect(job.id).toBe("job-1")
    expect(job.jobType).toBe("test.job")
    expect(job.status).toBe("pending")
    // Verify insert was called (the store successfully constructed with renamed columns)
    expect(insert).toHaveBeenCalled()
    // The readback WHERE uses the column map's id column, which has physical
    // name "pk_id" instead of "id".
    const where = getWhere()
    expect(where).toBeDefined()
    const query = new PgDialect().sqlToQuery(where as SQL<unknown>)
    expect(query.sql).toContain('"app_jobs"."pk_id" = $1')
  })

  it("claimDue generates noRunningSibling SQL with derived physical column names", async () => {
    const { store, getWhere } = createRenamedStore({ selectResult: [] })

    await store.claimDue({
      workerId: "worker-1",
      leaseDurationMs: 30_000,
      limit: 10,
      requester: { scope: "platform", actorId: "worker-1" },
    })

    // The select's WHERE captures the due-condition clause.
    const where = getWhere()
    expect(where).toBeDefined()
    const query = new PgDialect().sqlToQuery(where as SQL<unknown>)

    // The due condition references status via the column map, which resolves
    // to the physical "job_status" column
    expect(query.sql).toContain('"app_jobs"."job_status"')
    // The lease expiry column in the expired-lease branch
    expect(query.sql).toContain('"app_jobs"."lease_expiry"')
  })

  it("claimDue uses the noRunningSibling subquery with derived partition and id columns", async () => {
    // claimDue's noRunningSibling is embedded in the UPDATE's WHERE clause.
    // The UPDATE mock captures the final WHERE including noRunningSibling.
    const { store, getWhere } = createRenamedStore({ selectResult: [], affectedRows: 1 })

    // First, seed the select to return eligible jobs
    // The store calls select().from().where().limit() to find eligible jobs,
    // then for each eligible job, it calls update().set().where() with
    // the noRunningSibling subquery embedded in the WHERE.
    // We need the initial select to return a job so the UPDATE is attempted.

    // Reset the store with a select that returns one eligible job on the first call
    // and captures the UPDATE WHERE on the second.
    let selectCallCount = 0
    let lastUpdateWhere: SQL<unknown> | undefined
    const eligibleJob = {
      id: "job-1", jobType: "test", jobVersion: 1, tenantId: null, scope: "platform",
      payload: "{}", status: "pending", priority: 0, attempts: 0, maxAttempts: 3,
      runAt: "2026-01-01T00:00:00.000Z", nextAttemptAt: "2025-01-01T00:00:00.000Z",
      leaseOwner: null, leaseExpiresAt: null, claimToken: null,
      idempotencyKey: null, idempotencyScope: null, fingerprint: "test-fingerprint",
      correlationId: null, lastError: null, resultPayload: null, metadata: null,
      createdAt: "2026-01-01T00:00:00.000Z", startedAt: null, completedAt: null,
      partitionKey: null,
    }
    const claimedJob = { ...eligibleJob, status: "running", leaseOwner: "worker-1", claimToken: "ct-1", leaseExpiresAt: "2099-01-01T00:00:00.000Z", attempts: 1 }

    const db2 = {
      insert: vi.fn(() => ({ values: vi.fn(async () => ({ rowCount: 1 })) })),
      update: vi.fn(() => ({
        set: () => ({
          where: async (where: SQL<unknown> | undefined) => {
            lastUpdateWhere = where
            return { rowCount: 1, rowsAffected: 1 }
          },
        }),
      })),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCallCount++
              return selectCallCount === 1 ? [eligibleJob] : [claimedJob]
            },
            orderBy: () => ({
              limit: () => ({
                offset: async () => {
                  selectCallCount++
                  return selectCallCount === 1 ? [eligibleJob] : [claimedJob]
                },
              }),
            }),
          }),
        }),
      }),
    } as unknown as DrizzleSessionLike

    const store2 = createDrizzleJobStore(db2, {
      jobsTable: renamedJobsTable,
      executionsTable: renamedExecutionsTable,
      columnMap: renamedColumnMap,
    })

    await store2.claimDue({
      workerId: "worker-1",
      leaseDurationMs: 30_000,
      limit: 10,
      requester: { scope: "platform", actorId: "worker-1" },
    })

    // The UPDATE WHERE clause contains the noRunningSibling subquery.
    // Verify the derived physical column names are used.
    expect(lastUpdateWhere).toBeDefined()
    const query = new PgDialect().sqlToQuery(lastUpdateWhere as SQL<unknown>)

    // noRunningSibling references:
    // - sibling."app_partition" (was: partition_key)
    // - sibling."job_status"    (was: status)
    // - sibling."lease_expiry"  (was: lease_expires_at)
    // - sibling."pk_id"         (was: id)
    expect(query.sql).toContain('"app_jobs"."app_partition"')
    expect(query.sql).toContain('"app_jobs"."job_status"')
    expect(query.sql).toContain('"app_jobs"."lease_expiry"')
    expect(query.sql).toContain('"app_jobs"."pk_id"')
  })
})
