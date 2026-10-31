/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, expect, it, vi } from "vitest"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import { PgDialect } from "drizzle-orm/pg-core/dialect"
import type { SQL } from "drizzle-orm/sql/sql"
import { ConfigurationError } from "@xonava/core/domain"
import { JobIdempotencyConflictError, buildJobFingerprintInput, fingerprintJob } from "@xonava/core/execution"
import { canonicalizeValue } from "@xonava/core/serialization"
import { createDrizzleJobStore, type DrizzleSessionLike } from "@xonava/adapters/drizzle-pg"

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
      // Replays use INSERT ... ON CONFLICT DO NOTHING RETURNING: a conflict returns no row.
      insert: vi.fn(() => ({ values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }) })),
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

  it("refuses a non-default platform key instead of dropping it when the column map has no scopeKey column", async () => {
    const db = { insert: vi.fn(), select: vi.fn() } as unknown as DrizzleSessionLike
    const store = createDrizzleJobStore(db, { jobsTable, executionsTable, columnMap })
    await expect(store.enqueue({
      requester: { scope: "platform", actorId: "worker-1" },
      job: { executionScope: { kind: "platform", platformKey: "tenantless-a" }, jobType: "test.job", jobVersion: 1, payload: {} },
    })).rejects.toThrow(/scopeKey/)
    expect(db.insert).not.toHaveBeenCalled()
  })

  describe("idempotent re-enqueue by stored fingerprint", () => {
    const runAt = new Date("2026-01-01T00:00:00.000Z")
    const job = { executionScope: { kind: "platform" as const, platformKey: "default" }, jobType: "test.job", jobVersion: 1, payload: { "10": 1, "9": 2 }, idempotencyKey: "job-1", runAt }
    /** What version 3 persisted; kept to assert that it is no longer accepted. */
    const storedV3 = async (payload: Record<string, unknown>): Promise<string> => {
      const text = JSON.stringify(canonicalizeValue({ version: 3, job: { ...buildJobFingerprintInput({ ...job, payload }, runAt), maxAttempts: 3, runAt: runAt.toISOString() } }))
      return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (byte) => byte.toString(16).padStart(2, "0")).join("")
    }
    const storeWithExisting = (fingerprint: string) => createDrizzleJobStore({
      insert: vi.fn(() => ({ values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }) })),
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: async () => [{
        id: "job-1", jobType: "test.job", jobVersion: 1, tenantId: null, scope: "platform", payload: JSON.stringify(job.payload), status: "pending", priority: 0, attempts: 0, maxAttempts: 3,
        runAt: runAt.toISOString(), nextAttemptAt: runAt.toISOString(), leaseOwner: null, leaseExpiresAt: null, claimToken: null, idempotencyKey: "job-1", idempotencyScope: "platform",
        fingerprint, correlationId: null, lastError: null, resultPayload: null, metadata: null, createdAt: runAt.toISOString(), startedAt: null, completedAt: null, partitionKey: null,
      }] })) })) })),
    } as unknown as DrizzleSessionLike, { jobsTable, executionsTable, columnMap })

    it("replays an identical re-enqueue whose stored fingerprint is the current version", async () => {
      const current = await fingerprintJob(buildJobFingerprintInput(job, runAt))
      const stored = await storeWithExisting(current).enqueue({ requester: { scope: "platform", actorId: "worker-1" }, job })
      expect(stored.id).toBe("job-1")
    })

    it("rejects a different job under the current-version fingerprint", async () => {
      const other = await fingerprintJob(buildJobFingerprintInput({ ...job, payload: { "10": 2 } }, runAt))
      await expect(storeWithExisting(other).enqueue({ requester: { scope: "platform", actorId: "worker-1" }, job })).rejects.toThrow(JobIdempotencyConflictError)
    })

    it("no longer recognises a version-3 fingerprint of the same job", async () => {
      await expect(storeWithExisting(await storedV3(job.payload)).enqueue({ requester: { scope: "platform", actorId: "worker-1" }, job })).rejects.toThrow(JobIdempotencyConflictError)
    })
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
      // Sanitized: only the framework error code, never the provider message.
      historyError: "Execution history persistence failed (PERSISTENCE_ERROR)",
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
          where: (where: SQL<unknown> | undefined) => {
            lastWhere = where
            const result = { rowCount: options.affectedRows ?? 0, rowsAffected: options.affectedRows ?? 0 }
            return Object.assign(Promise.resolve(result), { returning: async () => options.selectResult ?? [] })
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

    // The claim is a single fenced UPDATE whose WHERE carries the due condition.
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
          where: (where: SQL<unknown> | undefined) => {
            lastUpdateWhere = where
            return Object.assign(Promise.resolve({ rowCount: 1, rowsAffected: 1 }), { returning: async () => [claimedJob] })
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

describe("job release without consuming an attempt", () => {
  it("fences on worker, token, running status, and live lease, and gives the attempt back", async () => {
    const { store, getWhere, update } = createStore({ affectedRows: 1 })
    await expect(store.release({ jobId: "j1", workerId: "w", claimToken: "t", nextAttemptAt: new Date("2026-01-01T00:00:00.000Z"), reason: "Unknown job definition: x@2" })).resolves.toEqual({ applied: true })
    expect(update).toHaveBeenCalledOnce()
    const where = new PgDialect().sqlToQuery(getWhere()!).sql
    for (const fragment of ["id", "lease_owner", "claim_token", "status", "lease_expires_at"]) expect(where).toContain(fragment)
  })

  it("reports a lost lease when the fenced update matches nothing", async () => {
    const { store } = createStore({ affectedRows: 0 })
    await expect(store.release({ jobId: "j1", workerId: "w", claimToken: "stale", nextAttemptAt: new Date(), reason: "x" })).resolves.toEqual({ applied: false, reason: "LEASE_LOST" })
  })
})

describe("job store guards found by the real-database differential", () => {
  it("cancel only touches jobs that are not already terminal (succeeded, failed, cancelled, dead_letter)", async () => {
    const { store, getWhere } = createStore()
    await store.cancel({ jobId: "j1", requester: { scope: "system" } })
    const { params } = new PgDialect().sqlToQuery(getWhere()!)
    for (const status of ["succeeded", "failed", "cancelled", "dead_letter"]) expect(params).toContain(status)
  })

  it("renewLease keeps the later of the current and the renewed expiry, so a renewal never shortens a lease", async () => {
    let captured: Record<string, unknown> | undefined
    const db = { insert: vi.fn(), update: vi.fn(() => ({ set: (values: Record<string, unknown>) => { captured = values; return { where: async () => ({ rowCount: 1 }) } } })) } as unknown as DrizzleSessionLike
    const store = createDrizzleJobStore(db, { jobsTable, executionsTable, columnMap })
    await store.renewLease({ jobId: "j", workerId: "w", claimToken: "t", extendByMs: 1_000 })
    expect(new PgDialect().sqlToQuery(captured!.leaseExpiresAt as SQL<unknown>).sql).toContain("GREATEST(")
  })

  it("replaces U+0000 in failure text (PostgreSQL text cannot store it) so the transition is not rejected", async () => {
    let captured: Record<string, unknown> | undefined
    const db = {
      insert: vi.fn(() => ({ values: async () => undefined })),
      update: vi.fn(() => ({ set: (values: Record<string, unknown>) => { captured = values; return { where: async () => ({ rowCount: 1 }) } } })),
    } as unknown as DrizzleSessionLike
    const store = createDrizzleJobStore(db, { jobsTable, executionsTable, columnMap })
    await expect(store.markFailed({ jobId: "j", workerId: "w", claimToken: "t", attempt: 1, error: "bad\u0000text", status: "failed" })).resolves.toMatchObject({ applied: true })
    expect(captured!.lastError).toBe("bad\uFFFDtext")
  })
})
