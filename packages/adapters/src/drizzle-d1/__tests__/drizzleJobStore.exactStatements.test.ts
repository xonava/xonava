import { describe, expect, it } from "vitest"
import { getTableColumns } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ConfigurationError, ConflictError } from "@xonava/core/domain"
import { buildJobFingerprintInput, CorruptJobMetadataError, fingerprintJob, JobIdempotencyConflictError } from "@xonava/core/execution"
import { createDrizzleJobStore } from "../drizzleJobStore"
import { createScriptedDb, renderSql, type ScriptedHandler, type ScriptedOp } from "../../__tests__/support/scriptedDb"

const ts = (name: string) => integer(name, { mode: "timestamp_ms" })
const jobs = sqliteTable("platform_jobs", {
  id: text("id").primaryKey(), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), scopeKey: text("scope_key"), payload: text("payload"),
  status: text("status"), priority: integer("priority"), attempts: integer("attempts"), maxAttempts: integer("max_attempts"), runAt: ts("run_at"), nextAttemptAt: ts("next_attempt_at"),
  leaseOwner: text("lease_owner"), leaseExpiresAt: ts("lease_expires_at"), claimToken: text("claim_token"), idempotencyKey: text("idempotency_key"), idempotencyScope: text("idempotency_scope"),
  fingerprint: text("fingerprint"), correlationId: text("correlation_id"), lastError: text("last_error"), resultPayload: text("result_payload"), metadata: text("metadata"),
  createdAt: ts("created_at"), startedAt: ts("started_at"), completedAt: ts("completed_at"), partitionKey: text("partition_key"),
})
const executions = sqliteTable("platform_job_executions", {
  id: text("id").primaryKey(), jobId: text("job_id"), attempt: integer("attempt"), workerId: text("worker_id"), status: text("status"), errorMessage: text("error_message"),
  startedAt: ts("started_at"), finishedAt: ts("finished_at"),
})
const jobColumns = getTableColumns(jobs) as Record<string, unknown>
const execColumns = getTableColumns(executions) as Record<string, unknown>

const RUN_AT = new Date("2026-01-01T00:00:00.000Z")
const system = { scope: "system" } as never
const platform = { scope: "platform", actorId: "p" } as never
const tenant = (tenantId: string) => ({ scope: "tenant", tenantId, actorId: "u" }) as never
const baseJob = { jobType: "mail", jobVersion: 1, payload: { a: 1 }, executionScope: { kind: "system", systemKey: "framework" }, maxAttempts: 3, runAt: RUN_AT }
const jobRow = (overrides: Record<string, unknown> = {}) => ({
  id: "j1", jobType: "mail", jobVersion: 1, tenantId: null, scope: "system", scopeKey: null, payload: '{"a":1}', status: "pending", priority: 0, attempts: 0, maxAttempts: 3,
  runAt: RUN_AT.getTime(), nextAttemptAt: RUN_AT.getTime(), leaseOwner: null, leaseExpiresAt: null, claimToken: null, idempotencyKey: null, fingerprint: "v1:abc", correlationId: null,
  lastError: null, resultPayload: null, metadata: null, partitionKey: null, createdAt: RUN_AT.getTime(), startedAt: null, completedAt: null, ...overrides,
})

interface BuildOptions { history?: "best_effort" | "required"; atomic?: (request: Record<string, unknown>) => unknown; jobsMap?: Record<string, unknown>; execMap?: Record<string, unknown> }
function build(handler: ScriptedHandler, options: BuildOptions = {}) {
  const scripted = createScriptedDb("sqlite", handler, options.atomic ? { atomicJobTransition: options.atomic } : {})
  const store = createDrizzleJobStore(scripted.db as never, {
    jobsTable: jobs, executionsTable: executions,
    ...(options.history ? { executionHistory: options.history } : {}),
    columnMap: { jobs: (options.jobsMap ?? jobColumns) as never, executions: (options.execMap ?? execColumns) as never },
  })
  return { store, ops: scripted.ops }
}
const changes = (n: number) => ({ meta: { changes: n } })
const norm = (sql: string | undefined) => (sql ?? "").replace(/\s+/g, " ")
const whereOf = (op: ScriptedOp | undefined) => ({ sql: norm(op?.where?.sql), params: op?.where?.params })
const J = '"platform_jobs".'
const CUR = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)"
const sqlOf = (value: unknown) => { const r = renderSql("sqlite", value); return { sql: norm(r?.sql), params: r?.params } }
const nowMs = expect.any(Date)

describe("d1 job store construction messages", () => {
  it("reports exact configuration errors", () => {
    expect(() => build(() => [], { history: "required" })).toThrow(new ConfigurationError("executionHistory 'required' requires a session that provides atomicJobTransition"))
    const { id: _id, ...noId } = jobColumns
    expect(() => build(() => [], { jobsMap: noId })).toThrow(new ConfigurationError("Job store is missing the required 'id' column in its column map"))
    const { partitionKey: _p, ...noPartition } = jobColumns
    expect(() => build(() => [], { jobsMap: noPartition })).toThrow(new ConfigurationError("Job store is missing the required 'partitionKey' column in its column map"))
    const { finishedAt: _f, ...noFinished } = execColumns
    expect(() => build(() => [], { execMap: noFinished })).toThrow(new ConfigurationError("Job store is missing the required 'finishedAt' column in its executions column map"))
    const { id: _e, ...noExecId } = execColumns
    expect(() => build(() => [], { execMap: noExecId })).toThrow("required 'id' column in its executions column map")
  })

  it("accepts the required history mode when the session provides an atomic transition", () => {
    expect(() => build(() => [], { history: "required", atomic: () => ({ applied: true }) })).not.toThrow()
  })

  it("keys history inserts by the property that owns the column", async () => {
    const dupExec = sqliteTable("dup_exec", {
      first: text("dup"), id: text("id").primaryKey(), jobId: text("job_id"), attempt: integer("attempt"), workerId: text("worker_id"), status: text("status"), errorMessage: text("error_message"),
      startedAt: ts("started_at"), finishedAt: ts("finished_at"), second: text("dup"),
    })
    const scripted = createScriptedDb("sqlite", () => changes(1))
    const cols = getTableColumns(dupExec) as Record<string, unknown>
    const store = createDrizzleJobStore(scripted.db as never, {
      jobsTable: jobs, executionsTable: dupExec,
      columnMap: { jobs: jobColumns as never, executions: { ...cols, workerId: cols.second } as never },
    })
    await store.markSucceeded({ jobId: "j", workerId: "w", claimToken: "t", attempt: 1 })
    expect(scripted.ops[1]!.values).toMatchObject({ second: "w" })
    expect(scripted.ops[1]!.values).not.toHaveProperty("first")
    expect(scripted.ops[1]!.values).not.toHaveProperty("workerId")
    const lookalike = sqliteTable("lookalike", { id: text("id"), jobId: text("job_id") })
    const byName = build(() => changes(1), { execMap: { ...execColumns, id: lookalike.id, jobId: lookalike.jobId } })
    await byName.store.markSucceeded({ jobId: "j", workerId: "w", claimToken: "t", attempt: 1 })
    expect(byName.ops[1]!.values).toMatchObject({ id: expect.any(String), jobId: "j" })
  })
})

describe("d1 job store metadata and row decoding", () => {
  const read = async (overrides: Record<string, unknown>) => build(() => [jobRow(overrides)]).store.getById({ id: "j1", requester: system })

  it("accepts object and JSON-object metadata and treats absent metadata as null", async () => {
    expect((await read({ metadata: { m: 1 } }))?.metadata).toEqual({ m: 1 })
    expect((await read({ metadata: '{"m":2}' }))?.metadata).toEqual({ m: 2 })
    expect((await read({ metadata: null }))?.metadata).toBeNull()
    expect((await read({ metadata: "" }))?.metadata).toBeNull()
  })

  it.each([
    ["an array", [1], "Job metadata must be a JSON object"],
    ["a number", 5, "Job metadata must be a JSON object"],
    ["a boolean", true, "Job metadata must be a JSON object"],
    ["a JSON array", "[1]", "Job metadata is not valid JSON"],
    ["JSON null", "null", "Job metadata is not valid JSON"],
    ["a JSON number", "5", "Job metadata is not valid JSON"],
    ["unparsable text", "{nope", "Job metadata is not valid JSON"],
  ])("rejects metadata that is %s", async (_label, metadata, message) => {
    const error = await read({ metadata }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CorruptJobMetadataError)
    expect((error as Error).message).toBe(message)
  })

  it("keeps the parse failure as the cause", async () => {
    const error = (await read({ metadata: "[1]" }).catch((e: unknown) => e)) as Error
    expect(error.cause).toBeInstanceOf(Error)
    expect((error.cause as Error).message).toBe("metadata must be a JSON object")
    const syntax = (await read({ metadata: "{nope" }).catch((e: unknown) => e)) as Error
    expect(syntax.cause).toBeInstanceOf(SyntaxError)
  })

  it("rejects missing or unknown scopes with the job id and accepts the three valid scopes", async () => {
    await expect(read({ scope: undefined, id: "jx" })).rejects.toThrow(new ConfigurationError("Job jx has a missing or invalid scope"))
    await expect(read({ scope: "other" })).rejects.toThrow(ConfigurationError)
    expect((await read({ scope: "tenant", tenantId: "t1" }))?.scope).toBe("tenant")
    expect((await read({ scope: "platform", scopeKey: "ops" }))?.scope).toBe("platform")
    expect((await read({ scope: "system" }))?.scope).toBe("system")
  })

  it("decodes dates, nullable columns and numeric fields", async () => {
    const later = new Date("2026-02-02T00:00:00.000Z")
    const full = await read({
      nextAttemptAt: later.getTime(), leaseExpiresAt: later.getTime(), startedAt: later.getTime(), completedAt: later.getTime(), leaseOwner: "w", claimToken: "c", priority: 4, attempts: 3, maxAttempts: 5, jobVersion: 2,
      idempotencyKey: "ik", correlationId: "cid", lastError: "boom", resultPayload: "res", partitionKey: "pk",
    })
    expect(full).toMatchObject({
      nextAttemptAt: later, leaseExpiresAt: later, startedAt: later, completedAt: later, leaseOwner: "w", claimToken: "c", priority: 4, currentAttempt: 3, attemptsCompleted: 2, maxAttempts: 5, jobVersion: 2, runAt: RUN_AT,
      idempotencyKey: "ik", correlationId: "cid", lastError: "boom", resultPayload: "res", partitionKey: "pk", createdAt: RUN_AT,
    })
    const bare = await read({ nextAttemptAt: null, leaseExpiresAt: null, startedAt: null, completedAt: null, leaseOwner: undefined, claimToken: undefined, attempts: 0, idempotencyKey: undefined, correlationId: undefined, lastError: undefined, resultPayload: undefined, partitionKey: undefined })
    expect(bare).toMatchObject({
      nextAttemptAt: null, leaseExpiresAt: null, startedAt: null, completedAt: null, leaseOwner: null, claimToken: null, currentAttempt: 0, attemptsCompleted: 0,
      idempotencyKey: null, correlationId: null, lastError: null, resultPayload: null, partitionKey: null,
    })
  })
})

describe("d1 job store lookups apply exact filters", () => {
  it("getById filters by id plus scope (and tenant only for tenant requesters)", async () => {
    const f = build(() => [jobRow({ scope: "tenant", tenantId: "t1" })])
    await f.store.getById({ id: "j1", requester: tenant("t1") })
    await f.store.getById({ id: "j1", requester: system })
    await f.store.getById({ id: "j1", requester: platform })
    expect(whereOf(f.ops[0])).toEqual({ sql: `(${J}"id" = ? and ${J}"scope" = ? and ${J}"tenant_id" = ?)`, params: ["j1", "tenant", "t1"] })
    expect(whereOf(f.ops[1])).toEqual({ sql: `(${J}"id" = ? and ${J}"scope" = ?)`, params: ["j1", "system"] })
    expect(whereOf(f.ops[2])).toEqual({ sql: `(${J}"id" = ? and ${J}"scope" = ?)`, params: ["j1", "platform"] })
    expect(f.ops[0]).toMatchObject({ limit: 1 })
    expect(await build(() => []).store.getById({ id: "j1", requester: system })).toBeNull()
  })

  it("getByCorrelationId filters by correlation id, scope and tenant, newest first, and maps the rows", async () => {
    const f = build(() => [jobRow({ id: "a" }), jobRow({ id: "b" })])
    const found = await f.store.getByCorrelationId({ correlationId: "corr", requester: tenant("t1") })
    expect(found.map((job) => job.id)).toEqual(["a", "b"])
    expect(whereOf(f.ops[0])).toEqual({ sql: `(${J}"correlation_id" = ? and ${J}"scope" = ? and ${J}"tenant_id" = ?)`, params: ["corr", "tenant", "t1"] })
    expect(norm(f.ops[0]!.orderBy!.sql)).toBe(`${J}"created_at" desc`)
    expect(f.ops[0]).toMatchObject({ limit: 5, offset: 0 })
    await f.store.getByCorrelationId({ correlationId: "corr", requester: system })
    expect(whereOf(f.ops[1])).toEqual({ sql: `(${J}"correlation_id" = ? and ${J}"scope" = ?)`, params: ["corr", "system"] })
  })

  it("getByIdempotencyKey scopes the key by tenant or by scope name", async () => {
    const f = build(() => [jobRow()])
    await f.store.getByIdempotencyKey({ key: "k", requester: tenant("t1") })
    await f.store.getByIdempotencyKey({ key: "k", requester: platform })
    expect(whereOf(f.ops[0])).toEqual({ sql: `(${J}"idempotency_key" = ? and ${J}"idempotency_scope" = ? and ${J}"scope" = ? and ${J}"tenant_id" = ?)`, params: ["k", "tenant:t1", "tenant", "t1"] })
    expect(whereOf(f.ops[1])).toEqual({ sql: `(${J}"idempotency_key" = ? and ${J}"idempotency_scope" = ? and ${J}"scope" = ?)`, params: ["k", "platform", "platform"] })
    expect(await build(() => []).store.getByIdempotencyKey({ key: "k", requester: system })).toBeNull()
  })

  it("getLatestPriorScheduleExecution looks before the occurrence, newest first", async () => {
    const f = build(() => [jobRow()])
    const found = await f.store.getLatestPriorScheduleExecution({ scheduleId: "s1", beforeOccurrence: RUN_AT, requester: tenant("t1") } as never)
    expect(found?.id).toBe("j1")
    expect(whereOf(f.ops[0])).toEqual({
      sql: `(${J}"correlation_id" = ? and ${J}"run_at" < ? and ${J}"scope" = ? and ${J}"tenant_id" = ?)`,
      params: [expect.stringContaining("s1"), RUN_AT.getTime(), "tenant", "t1"],
    })
    expect(norm(f.ops[0]!.orderBy!.sql)).toBe(`${J}"run_at" desc`)
    expect(f.ops[0]).toMatchObject({ limit: 1, offset: 0 })
    expect(await build(() => []).store.getLatestPriorScheduleExecution({ scheduleId: "s1", beforeOccurrence: RUN_AT, requester: system } as never)).toBeNull()
  })

  it("findPending lists pending and retrying jobs in priority then age order", async () => {
    const f = build(() => [jobRow({ id: "a" }), jobRow({ id: "b" })])
    const all = await f.store.findPending({ requester: tenant("t1"), jobType: "mail", limit: 7 })
    expect(all.map((job) => job.id)).toEqual(["a", "b"])
    expect(whereOf(f.ops[0])).toEqual({ sql: `(${J}"status" in (?, ?) and ${J}"scope" = ? and ${J}"tenant_id" = ? and ${J}"job_type" = ?)`, params: ["pending", "retrying", "tenant", "t1", "mail"] })
    expect(norm(f.ops[0]!.orderBy!.sql)).toBe(`${J}"priority" asc, ${J}"created_at" asc`)
    expect(f.ops[0]).toMatchObject({ limit: 7, offset: 0 })
    await f.store.findPending({ requester: system })
    expect(whereOf(f.ops[1])).toEqual({ sql: `(${J}"status" in (?, ?) and ${J}"scope" = ?)`, params: ["pending", "retrying", "system"] })
    expect(f.ops[1]).toMatchObject({ limit: 100 })
  })
})

describe("d1 job store enqueue writes the exact row", () => {
  const fingerprintFor = (job: Record<string, unknown>) => fingerprintJob(buildJobFingerprintInput(job as never, RUN_AT))
  /** Answers the post-insert read with a row carrying the id the store just inserted. */
  const insertedRow = (overrides: Record<string, unknown> = {}): ScriptedHandler => {
    let id = ""
    return (op) => {
      if (op.kind === "insert") { id = (op.values as { id: string }).id; return changes(1) }
      return [jobRow({ ...overrides, id })]
    }
  }

  it("non-idempotent enqueue inserts every column and reads the row back by id", async () => {
    const f = build((op) => (op.kind === "select" ? [jobRow()] : changes(1)))
    const job = { ...baseJob, correlationId: "c", partitionKey: "p", metadata: { m: 1 }, priority: 3 }
    await f.store.enqueue({ job: job as never, requester: system })
    const values = f.ops[0]!.values as Record<string, unknown>
    expect(values).toEqual({
      id: expect.any(String), jobType: "mail", jobVersion: 1, tenantId: null, scope: "system",
      payload: '{"a":1}', status: "pending", priority: 3, attempts: 0, maxAttempts: 3, runAt: RUN_AT, nextAttemptAt: RUN_AT,
      idempotencyKey: null, idempotencyScope: "system", fingerprint: await fingerprintFor(job), correlationId: "c",
      metadata: '{"m":1}', claimToken: null, partitionKey: "p", createdAt: nowMs,
    })
    expect(f.ops[0]!.conflictDoNothing).toBe(false)
    expect(whereOf(f.ops[1])).toEqual({ sql: `${J}"id" = ?`, params: [values.id] })
    expect(f.ops[1]).toMatchObject({ limit: 1 })
    const defaults = build((op) => (op.kind === "select" ? [jobRow()] : changes(1)))
    await defaults.store.enqueue({ job: baseJob as never, requester: system })
    expect(defaults.ops[0]!.values).toMatchObject({ priority: 0, correlationId: null, metadata: null, partitionKey: null, idempotencyKey: null })
  })

  it("fails when the row cannot be read back", async () => {
    const f = build((op) => (op.kind === "select" ? [] : changes(1)))
    await expect(f.store.enqueue({ job: { ...baseJob, executionScope: { kind: "system", systemKey: "custom" } } as never, requester: system })).rejects.toThrow(/^Failed to read back enqueued job [0-9a-f-]+$/)
  })

  it("idempotent enqueue inserts with ON CONFLICT DO NOTHING and the same column set", async () => {
    const job = { ...baseJob, idempotencyKey: "k", correlationId: "c", partitionKey: "p", metadata: { m: 1 }, priority: 3 }
    const f = build(insertedRow({ idempotencyKey: "k" }))
    await f.store.enqueue({ job: job as never, requester: system })
    expect(f.ops[0]!.conflictDoNothing).toBe(true)
    expect(f.ops[0]!.values).toEqual({
      id: expect.any(String), jobType: "mail", jobVersion: 1, tenantId: null, scope: "system",
      payload: '{"a":1}', status: "pending", priority: 3, attempts: 0, maxAttempts: 3, runAt: RUN_AT, nextAttemptAt: RUN_AT,
      idempotencyKey: "k", idempotencyScope: "system", fingerprint: await fingerprintFor(job), correlationId: "c",
      metadata: '{"m":1}', claimToken: null, partitionKey: "p", createdAt: nowMs,
    })
    const bare = build(insertedRow())
    await bare.store.enqueue({ job: { ...baseJob, idempotencyKey: "k" } as never, requester: system })
    expect(bare.ops[0]!.values).toMatchObject({ priority: 0, correlationId: null, metadata: null, partitionKey: null })
  })

  it("a tenant job is keyed by tenant:<id>, stores the tenant and omits the default scope key", async () => {
    const f = build(insertedRow())
    await f.store.enqueue({ job: { ...baseJob, executionScope: { kind: "tenant", tenantId: "t1" }, idempotencyKey: "k" } as never, requester: tenant("t1") })
    expect(f.ops[0]!.values).toMatchObject({ tenantId: "t1", scope: "tenant", idempotencyScope: "tenant:t1" })
    expect(f.ops[0]!.values).not.toHaveProperty("scopeKey")
  })

  it("a default-key job enqueues even when the table has no scope-key column", async () => {
    const { scopeKey: _scopeKey, ...withoutScopeKey } = jobColumns
    const f = build(insertedRow(), { jobsMap: withoutScopeKey })
    await f.store.enqueue({ job: { ...baseJob, executionScope: { kind: "tenant", tenantId: "t1" } } as never, requester: tenant("t1") })
    expect(f.ops[0]!.values).not.toHaveProperty("scopeKey")
    await expect(f.store.enqueue({ job: { ...baseJob, executionScope: { kind: "system", systemKey: "custom" } } as never, requester: system })).rejects.toThrow(
      new ConfigurationError("Job store column map has no 'scopeKey' column; apply the scope-key migration to enqueue a platform/system job with a non-default key"),
    )
  })

  it("looks the existing row up by idempotency scope and key and replays a matching fingerprint", async () => {
    const job = { ...baseJob, idempotencyKey: "k" }
    const fingerprint = await fingerprintFor(job)
    const f = build((op) => (op.kind === "insert" ? changes(0) : [jobRow({ id: "existing", idempotencyKey: "k", fingerprint })]))
    expect((await f.store.enqueue({ job: job as never, requester: system })).id).toBe("existing")
    expect(whereOf(f.ops[1])).toEqual({ sql: `(${J}"idempotency_scope" = ? and ${J}"idempotency_key" = ?)`, params: ["system", "k"] })
    expect(f.ops[1]).toMatchObject({ limit: 1 })
  })

  it("reports a different fingerprint, a missing fingerprint and an unexplained conflict", async () => {
    const job = { ...baseJob, idempotencyKey: "k" }
    const other = build((op) => (op.kind === "insert" ? changes(0) : [jobRow({ id: "existing", idempotencyKey: "k", fingerprint: "v1:other" })]))
    await expect(other.store.enqueue({ job: job as never, requester: system })).rejects.toBeInstanceOf(JobIdempotencyConflictError)
    for (const fingerprint of [null, ""]) {
      const missing = build((op) => (op.kind === "insert" ? changes(0) : [jobRow({ id: "existing", idempotencyKey: "k", fingerprint })]))
      await expect(missing.store.enqueue({ job: job as never, requester: system })).rejects.toThrow(new Error("Stored job fingerprint is missing; migrate fingerprints before replaying jobs."))
    }
    const none = build(() => [])
    const conflict = (await none.store.enqueue({ job: job as never, requester: system }).catch((e: unknown) => e)) as ConflictError
    expect(conflict).toBeInstanceOf(ConflictError)
    expect(conflict.message).toBe("Job could not be enqueued because it conflicts with an existing record")
  })

  it("without conflict-clause support, swallows only unique violations and normalizes everything else", async () => {
    const job = { ...baseJob, idempotencyKey: "k" }
    const fingerprint = await fingerprintFor(job)
    const make = (failure: Error) => {
      const scripted = createScriptedDb("sqlite", () => [jobRow({ id: "existing", idempotencyKey: "k", fingerprint })])
      const db = { ...scripted.db, insert: () => ({ values: () => Promise.reject(failure) }) }
      return createDrizzleJobStore(db as never, { jobsTable: jobs, executionsTable: executions, columnMap: { jobs: jobColumns as never, executions: execColumns as never } })
    }
    expect((await make(new Error("UNIQUE constraint failed: platform_jobs.idempotency_key")).enqueue({ job: job as never, requester: system })).id).toBe("existing")
    const failure = await make(new Error("D1_ERROR: no such table: platform_jobs")).enqueue({ job: job as never, requester: system }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).not.toBe("Job could not be enqueued because it conflicts with an existing record")
  })

  it("normalizes non-idempotent insert failures", async () => {
    const failing = build(() => { throw new Error("UNIQUE constraint failed: platform_jobs.id") })
    const error = (await failing.store.enqueue({ job: baseJob as never, requester: system }).catch((e: unknown) => e)) as ConflictError
    expect(error).toBeInstanceOf(ConflictError)
    expect(error.details).toMatchObject({ dialect: "d1" })
  })
})

describe("d1 job store claiming", () => {
  const part = (alias: string) => `"${alias}"."partition_key" = ${J}"partition_key" AND "${alias}"."scope" = ${J}"scope" AND "${alias}"."tenant_id" IS ${J}"tenant_id" AND "${alias}"."scope_key" IS ${J}"scope_key" AND "${alias}"."id" <> ${J}"id"`
  const sibling = `NOT EXISTS (SELECT 1 FROM "platform_jobs" sibling WHERE ${part("sibling")} AND "sibling"."status" = 'running' AND "sibling"."lease_expires_at" > ${CUR})`
  const ahead = `NOT EXISTS (SELECT 1 FROM "platform_jobs" ahead WHERE ${part("ahead")} AND (("ahead"."status" IN ('pending', 'retrying') AND "ahead"."attempts" < "ahead"."max_attempts" AND "ahead"."next_attempt_at" <= ?) OR ("ahead"."status" = 'running' AND "ahead"."attempts" < "ahead"."max_attempts" AND "ahead"."lease_expires_at" < ${CUR})) AND ("ahead"."priority", "ahead"."run_at", "ahead"."id") < (${J}"priority", ${J}"run_at", ${J}"id"))`
  const due = `((${J}"status" in (?, ?) and ${J}"next_attempt_at" <= ? and ${J}"attempts" < ${J}"max_attempts") or (${J}"status" = ? and ${J}"attempts" < ${J}"max_attempts" and ${J}"lease_expires_at" < ${CUR}))`
  const scripted = (rows: unknown[] = []): ScriptedHandler => (op) => (op.kind === "select" && op.fields ? rows : op.kind === "select" ? [] : changes(1))

  it("claims for a tenant requester: dead-letters expired final attempts, selects heads, then claims each one", async () => {
    const f = build(scripted([{ id: "j1" }, { id: "j2" }]))
    await f.store.claimDue({ workerId: "w", leaseDurationMs: 5_000, limit: 3, requester: tenant("t1"), now: RUN_AT })
    const [dead, pick, claim1, claim2] = f.ops
    expect(whereOf(dead)).toEqual({
      sql: `(${J}"status" = ? and ${J}"lease_expires_at" < ${CUR} and ${J}"attempts" >= ${J}"max_attempts" and (${J}"scope" = ? and ${J}"tenant_id" = ?))`,
      params: ["running", "tenant", "t1"],
    })
    expect(Object.keys(dead!.set as object)).toEqual(["status", "lastError", "completedAt", "leaseOwner", "leaseExpiresAt", "claimToken"])
    expect(dead!.set).toMatchObject({ status: "dead_letter", lastError: "LEASE_EXPIRED_AFTER_FINAL_ATTEMPT", completedAt: RUN_AT, leaseOwner: null, leaseExpiresAt: null, claimToken: null })

    const scopeClause = `(${J}"scope" = ? and ${J}"tenant_id" = ?)`
    expect(whereOf(pick)).toEqual({
      sql: `(${due} and ${scopeClause} and ${sibling} and ${ahead})`,
      params: ["pending", "retrying", RUN_AT.getTime(), "running", "tenant", "t1", RUN_AT.getTime()],
    })
    expect(Object.keys(pick!.fields as object)).toEqual(["id"])
    expect(norm(pick!.orderBy!.sql)).toBe(`${J}"priority" asc, ${J}"run_at" asc, ${J}"id" asc`)
    expect(pick).toMatchObject({ limit: 3, offset: 0 })

    expect(whereOf(claim1)).toEqual({
      sql: `(${J}"id" = ? and ${due} and ${scopeClause} and ${sibling})`,
      params: ["j1", "pending", "retrying", RUN_AT.getTime(), "running", "tenant", "t1"],
    })
    expect(whereOf(claim2)!.params![0]).toBe("j2")
    expect(Object.keys(claim1!.set as object)).toEqual(["status", "leaseOwner", "leaseExpiresAt", "claimToken", "attempts", "startedAt", "nextAttemptAt"])
    const set = claim1!.set as Record<string, unknown>
    expect(set).toMatchObject({ status: "running", leaseOwner: "w", claimToken: expect.any(String), startedAt: RUN_AT, nextAttemptAt: null })
    expect(sqlOf(set.leaseExpiresAt)).toEqual({ sql: `CAST((julianday('now') - 2440587.5) * 86400000 + ? AS INTEGER)`, params: [5_000] })
    expect(sqlOf(set.attempts)).toEqual({ sql: "attempts + 1", params: [] })
    expect((claim2!.set as { claimToken: string }).claimToken).not.toBe(set.claimToken)
  })

  it("claims for a system requester with only the scope filter and reads back by the fresh tokens", async () => {
    const f = build(scripted([{ id: "j1" }]))
    await f.store.claimDue({ workerId: "w", leaseDurationMs: 1, limit: 2, requester: system, now: RUN_AT })
    expect(whereOf(f.ops[0])).toEqual({
      sql: `(${J}"status" = ? and ${J}"lease_expires_at" < ${CUR} and ${J}"attempts" >= ${J}"max_attempts" and ${J}"scope" = ?)`,
      params: ["running", "system"],
    })
    expect(whereOf(f.ops[1])).toEqual({
      sql: `(${due} and ${J}"scope" = ? and ${sibling} and ${ahead})`,
      params: ["pending", "retrying", RUN_AT.getTime(), "running", "system", RUN_AT.getTime()],
    })
    const token = (f.ops[2]!.set as { claimToken: string }).claimToken
    expect(whereOf(f.ops[2])).toEqual({ sql: `(${J}"id" = ? and ${due} and ${J}"scope" = ? and ${sibling})`, params: ["j1", "pending", "retrying", RUN_AT.getTime(), "running", "system"] })
    expect(whereOf(f.ops[3])).toEqual({ sql: `((${J}"id" = ? and ${J}"claim_token" = ?) and ${J}"lease_owner" = ?)`, params: ["j1", token, "w"] })
    expect(f.ops[3]).toMatchObject({ kind: "select", limit: 1 })
  })

  it("defaults the clock to the current time", async () => {
    const f = build(scripted([{ id: "j1" }]))
    const before = Date.now()
    await f.store.claimDue({ workerId: "w", leaseDurationMs: 1, limit: 1, requester: system })
    const stamp = (f.ops[2]!.set as { startedAt: unknown }).startedAt
    expect(stamp).toBeInstanceOf(Date)
    expect((stamp as Date).getTime()).toBeGreaterThanOrEqual(before)
    expect((stamp as Date).getTime()).toBeLessThanOrEqual(Date.now())
    expect(f.ops[1]!.where!.params[2]).toBe((stamp as Date).getTime())
  })

  it("claims nothing for a non-positive or fractional limit and when no claim update applies", async () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      const zero = build(() => [])
      expect(await zero.store.claimDue({ workerId: "w", leaseDurationMs: 1, limit, requester: system })).toEqual([])
      expect(zero.ops).toEqual([])
    }
    const one = build(scripted([{ id: "j1" }]))
    expect((await one.store.claimDue({ workerId: "w", leaseDurationMs: 1, limit: 1, requester: system })).length).toBe(0)
    const lost = build((op) => (op.kind === "select" ? (op.fields ? [{ id: "j1" }] : [jobRow({ status: "running" })]) : changes(0)))
    expect(await lost.store.claimDue({ workerId: "w", leaseDurationMs: 1, limit: 1, requester: system })).toEqual([])
    expect(lost.ops.map((op) => op.kind)).toEqual(["update", "select", "update"])
    const some = build((op) => (op.kind === "select" ? (op.fields ? [{ id: "j1" }, { id: "j2" }] : [jobRow({ id: "j2", status: "running" })]) : changes(op.where!.params[0] === "j2" ? 1 : 0)))
    const claimed = await some.store.claimDue({ workerId: "w", leaseDurationMs: 1, limit: 2, requester: system })
    expect(claimed.map((job) => job.id)).toEqual(["j2"])
    expect(some.ops[some.ops.length - 1]!.limit).toBe(1)
    expect(whereOf(some.ops[some.ops.length - 1]).params![0]).toBe("j2")
  })

  it("validates the worker id before touching the database", async () => {
    const f = build(() => [])
    await expect(f.store.claimDue({ workerId: "w".repeat(101), leaseDurationMs: 1, limit: 1, requester: system })).rejects.toThrow("workerId exceeds the maximum of 100 bytes")
    await expect(f.store.claimDue({ workerId: "\u00e9".repeat(51), leaseDurationMs: 1, limit: 1, requester: system })).rejects.toThrow("workerId exceeds the maximum of 100 bytes")
    await expect(f.store.renewLease({ jobId: "j", workerId: "w".repeat(101), claimToken: "t", extendByMs: 1 })).rejects.toThrow("workerId exceeds the maximum of 100 bytes")
    expect(f.ops).toEqual([])
    await expect(f.store.claimDue({ workerId: "w".repeat(100), leaseDurationMs: 1, limit: 1, requester: system })).resolves.toEqual([])
  })

  it("compares only the mapped partition columns when the table has no scope-key column", async () => {
    const { scopeKey: _scopeKey, ...withoutScopeKey } = jobColumns
    const f = build(scripted([]), { jobsMap: withoutScopeKey })
    await f.store.claimDue({ workerId: "w", leaseDurationMs: 1, limit: 1, requester: system, now: RUN_AT })
    const text = norm(f.ops[1]!.where!.sql)
    expect(text).not.toContain("scope_key")
    expect(text).not.toContain("Stryker")
    const partNoKey = (alias: string) => `"${alias}"."partition_key" = ${J}"partition_key" AND "${alias}"."scope" = ${J}"scope" AND "${alias}"."tenant_id" IS ${J}"tenant_id" AND "${alias}"."id" <> ${J}"id"`
    expect(text).toContain(`NOT EXISTS (SELECT 1 FROM "platform_jobs" sibling WHERE ${partNoKey("sibling")} AND "sibling"."status" = 'running'`)
    expect(text).toContain(`NOT EXISTS (SELECT 1 FROM "platform_jobs" ahead WHERE ${partNoKey("ahead")} AND ((`)
  })
})

describe("d1 job store lease renewal and release", () => {
  it("renewal only extends a live, owned, running claim and never shortens the lease", async () => {
    const f = build(() => changes(1))
    expect(await f.store.renewLease({ jobId: "j", workerId: "w", claimToken: "t", extendByMs: 100 })).toBe(true)
    expect(whereOf(f.ops[0])).toEqual({
      sql: `(${J}"id" = ? and ${J}"lease_owner" = ? and ${J}"claim_token" = ? and ${J}"status" = ? and ${J}"lease_expires_at" > ${CUR})`,
      params: ["j", "w", "t", "running"],
    })
    expect(Object.keys(f.ops[0]!.set as object)).toEqual(["leaseExpiresAt"])
    expect(sqlOf((f.ops[0]!.set as { leaseExpiresAt: unknown }).leaseExpiresAt)).toEqual({
      sql: `MAX(${J}"lease_expires_at", CAST((julianday('now') - 2440587.5) * 86400000 + ? AS INTEGER))`, params: [100],
    })
    expect(await f.store.renewLease({ jobId: "j", workerId: "w", claimToken: "t", extendByMs: 0 })).toBe(false)
    expect(await f.store.renewLease({ jobId: "j", workerId: "w", claimToken: "t", extendByMs: Number.POSITIVE_INFINITY })).toBe(false)
    expect(await f.store.renewLease({ jobId: "j", workerId: "w", claimToken: "t", extendByMs: Number.NaN })).toBe(false)
    expect(await f.store.renewLease({ jobId: "j", workerId: "w", claimToken: "t", extendByMs: -5 })).toBe(false)
    expect(f.ops).toHaveLength(1)
    expect(await build(() => changes(0)).store.renewLease({ jobId: "j", workerId: "w", claimToken: "t", extendByMs: 100 })).toBe(false)
  })

  it("release is fenced, restores the attempt and truncates the reason to 512 characters", async () => {
    const f = build(() => changes(1))
    expect(await f.store.release({ jobId: "j", workerId: "w", claimToken: "t", nextAttemptAt: RUN_AT, reason: "r".repeat(600) })).toEqual({ applied: true })
    expect(whereOf(f.ops[0])).toEqual({
      sql: `(${J}"id" = ? and ${J}"lease_owner" = ? and ${J}"claim_token" = ? and ${J}"status" = ? and ${J}"lease_expires_at" > ${CUR})`,
      params: ["j", "w", "t", "running"],
    })
    const set = f.ops[0]!.set as Record<string, unknown>
    expect(Object.keys(set)).toEqual(["status", "attempts", "nextAttemptAt", "lastError", "leaseOwner", "leaseExpiresAt", "claimToken"])
    expect(set).toMatchObject({ status: "retrying", nextAttemptAt: RUN_AT, lastError: "r".repeat(512), leaseOwner: null, leaseExpiresAt: null, claimToken: null })
    expect(sqlOf(set.attempts)).toEqual({ sql: "CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END", params: [] })
    expect(await build(() => changes(0)).store.release({ jobId: "j", workerId: "w", claimToken: "t", nextAttemptAt: RUN_AT, reason: "r" })).toEqual({ applied: false, reason: "LEASE_LOST" })
  })
})

describe("d1 job store best-effort transitions write exact fences, values and history", () => {
  const args = { jobId: "j", workerId: "w", claimToken: "t", attempt: 2 }
  const fence = `${J}"id" = ? and ${J}"lease_owner" = ? and ${J}"claim_token" = ? and ${J}"attempts" = ?`

  it("markSucceeded", async () => {
    const f = build(() => changes(1))
    const result = await f.store.markSucceeded({ ...args, result: { ok: 1 } })
    expect(result).toEqual({ applied: true, transitionToken: expect.any(String) })
    expect(whereOf(f.ops[0])).toEqual({ sql: `(${fence} and ${J}"status" = ? and ${J}"lease_expires_at" > ${CUR})`, params: ["j", "w", "t", 2, "running"] })
    expect(Object.keys(f.ops[0]!.set as object)).toEqual(["status", "resultPayload", "completedAt", "leaseOwner", "leaseExpiresAt", "claimToken"])
    expect(f.ops[0]!.set).toMatchObject({ status: "succeeded", resultPayload: '{"ok":1}', completedAt: nowMs, leaseOwner: null, claimToken: null, leaseExpiresAt: null })
    expect(f.ops[1]!.values).toEqual({ id: (result as { transitionToken: string }).transitionToken, jobId: "j", attempt: 2, workerId: "w", status: "succeeded", errorMessage: null, startedAt: nowMs, finishedAt: nowMs })
    await f.store.markSucceeded(args)
    expect((f.ops[2]!.set as { resultPayload: unknown }).resultPayload).toBeNull()
    expect(await build(() => changes(0)).store.markSucceeded(args)).toEqual({ applied: false, reason: "LEASE_LOST" })
  })

  it("markRetrying", async () => {
    const f = build(() => changes(1))
    const next = new Date("2026-03-03T00:00:00.000Z")
    const result = await f.store.markRetrying({ ...args, error: "oops", nextAttemptAt: next })
    expect(result).toEqual({ applied: true, transitionToken: expect.any(String) })
    expect(whereOf(f.ops[0])).toEqual({ sql: `(${fence} and ${J}"attempts" < ${J}"max_attempts" and ${J}"status" in (?) and ${J}"lease_expires_at" > ${CUR})`, params: ["j", "w", "t", 2, "running"] })
    expect(Object.keys(f.ops[0]!.set as object)).toEqual(["status", "nextAttemptAt", "lastError", "leaseOwner", "leaseExpiresAt", "claimToken"])
    expect(f.ops[0]!.set).toMatchObject({ status: "retrying", nextAttemptAt: next, lastError: "oops", leaseOwner: null, claimToken: null, leaseExpiresAt: null })
    expect(f.ops[1]!.values).toEqual({ id: (result as { transitionToken: string }).transitionToken, jobId: "j", attempt: 2, workerId: "w", status: "retrying", errorMessage: "oops", startedAt: nowMs, finishedAt: nowMs })
    expect(await build(() => changes(0)).store.markRetrying({ ...args, error: "e", nextAttemptAt: next })).toEqual({ applied: false, reason: "LEASE_LOST" })
  })

  it("markFailed", async () => {
    const f = build(() => changes(1))
    const result = await f.store.markFailed({ ...args, status: "dead_letter", error: "fatal" })
    expect(result).toEqual({ applied: true, transitionToken: expect.any(String) })
    expect(whereOf(f.ops[0])).toEqual({ sql: `(${fence} and ${J}"status" = ? and ${J}"lease_expires_at" > ${CUR})`, params: ["j", "w", "t", 2, "running"] })
    expect(Object.keys(f.ops[0]!.set as object)).toEqual(["status", "lastError", "completedAt", "leaseOwner", "leaseExpiresAt", "claimToken"])
    expect(f.ops[0]!.set).toMatchObject({ status: "dead_letter", lastError: "fatal", completedAt: nowMs, leaseOwner: null, claimToken: null, leaseExpiresAt: null })
    expect(f.ops[1]!.values).toMatchObject({ status: "dead_letter", errorMessage: "fatal", attempt: 2 })
    expect(await build(() => changes(0)).store.markFailed({ ...args, status: "failed", error: "e" })).toEqual({ applied: false, reason: "LEASE_LOST" })
  })

  it("a failing history insert still reports the applied transition with its token", async () => {
    const f = build((op) => { if (op.kind === "insert") throw new Error("history down"); return changes(1) })
    expect(await f.store.markSucceeded(args)).toEqual({ applied: true, transitionToken: expect.any(String) })
    expect(await f.store.markRetrying({ ...args, error: "e", nextAttemptAt: RUN_AT })).toEqual({ applied: true, transitionToken: expect.any(String) })
    expect(await f.store.markFailed({ ...args, status: "failed", error: "e" })).toEqual({ applied: true, transitionToken: expect.any(String) })
  })
})

describe("d1 job store cancel", () => {
  const live = (requesterParams: unknown[]) => ["j", "succeeded", "cancelled", "dead_letter", "failed", ...requesterParams]
  const liveSql = (requesterSql: string) => `(${J}"id" = ? and ${J}"status" <> ? and ${J}"status" <> ? and ${J}"status" <> ? and ${J}"status" <> ?${requesterSql})`

  it("best-effort: selects a cancellable job in the requester's scope, records history, then cancels", async () => {
    const f = build((op) => (op.kind === "select" ? [jobRow({ attempts: 2 })] : changes(1)))
    const result = await f.store.cancel({ jobId: "j", requester: tenant("t1"), reason: "stop" })
    expect(result).toEqual({ applied: true, transitionToken: expect.any(String) })
    const tail = ` and ${J}"scope" = ? and ${J}"tenant_id" = ?`
    expect(whereOf(f.ops[0])).toEqual({ sql: liveSql(tail), params: live(["tenant", "t1"]) })
    expect(whereOf(f.ops[2])).toEqual({ sql: liveSql(tail), params: live(["tenant", "t1"]) })
    expect(f.ops[0]).toMatchObject({ limit: 1 })
    expect(f.ops[1]!.values).toEqual({ id: (result as { transitionToken: string }).transitionToken, jobId: "j", attempt: 2, workerId: "cancellation", status: "cancelled", errorMessage: "stop", startedAt: nowMs, finishedAt: nowMs })
    expect(Object.keys(f.ops[2]!.set as object)).toEqual(["status", "completedAt", "lastError", "leaseOwner", "claimToken", "leaseExpiresAt"])
    expect(f.ops[2]!.set).toMatchObject({ status: "cancelled", completedAt: nowMs, lastError: "stop", leaseOwner: null, claimToken: null, leaseExpiresAt: null })
    const systemCancel = build((op) => (op.kind === "select" ? [jobRow()] : changes(1)))
    await systemCancel.store.cancel({ jobId: "j", requester: system })
    expect(whereOf(systemCancel.ops[0])).toEqual({ sql: liveSql(` and ${J}"scope" = ?`), params: live(["system"]) })
    expect(systemCancel.ops[1]!.values).toMatchObject({ errorMessage: null })
    expect(systemCancel.ops[2]!.set).toMatchObject({ lastError: null })
  })

  it("best-effort: reports INVALID_STATE for a missing job or a lost update, and a null attempt records zero", async () => {
    const missing = build((op) => (op.kind === "select" ? [] : changes(1)))
    expect(await missing.store.cancel({ jobId: "j", requester: system })).toEqual({ applied: false, reason: "INVALID_STATE" })
    expect(missing.ops.map((op) => op.kind)).toEqual(["select"])
    const lost = build((op) => (op.kind === "select" ? [jobRow()] : changes(0)))
    expect(await lost.store.cancel({ jobId: "j", requester: system })).toEqual({ applied: false, reason: "INVALID_STATE" })
    const nullAttempt = build((op) => (op.kind === "select" ? [jobRow({ attempts: null })] : changes(1)))
    await nullAttempt.store.cancel({ jobId: "j", requester: system })
    expect(nullAttempt.ops[1]!.values).toMatchObject({ attempt: 0 })
  })

  it("required history: cancels atomically and reads the attempt inside the transaction", async () => {
    const requests: Record<string, unknown>[] = []
    const f = build(() => [], { history: "required", atomic: (request) => { requests.push(request); return { applied: true, historyId: (request.historyValues as { id: string }).id } } })
    const result = await f.store.cancel({ jobId: "j", requester: tenant("t1"), reason: "stop" })
    const request = requests[0]!
    const historyValues = request.historyValues as Record<string, unknown>
    expect(result).toEqual({ applied: true, transitionToken: historyValues.id })
    expect(Object.keys(request).sort()).toEqual(["historyTable", "historyValues", "historyWhere", "updateSet", "updateTable", "updateWhere"])
    expect(request.updateTable).toBe(jobs)
    expect(request.historyTable).toBe(executions)
    expect(sqlOf(request.updateWhere)).toEqual({ sql: liveSql(` and ${J}"scope" = ? and ${J}"tenant_id" = ?`), params: live(["tenant", "t1"]) })
    expect(request.updateSet).toEqual({ status: "cancelled", completedAt: nowMs, lastError: "stop", leaseOwner: null, claimToken: historyValues.id, leaseExpiresAt: null })
    expect(sqlOf(request.historyWhere)).toEqual({ sql: `${J}"claim_token" = ?`, params: [historyValues.id] })
    expect(sqlOf(historyValues.attempt)).toEqual({ sql: `"platform_jobs"."attempts"`, params: [] })
    expect(historyValues).toEqual({ id: expect.any(String), jobId: "j", attempt: historyValues.attempt, workerId: "cancellation", status: "cancelled", errorMessage: "stop", startedAt: nowMs, finishedAt: nowMs })
    await f.store.cancel({ jobId: "j", requester: system })
    expect((requests[1]!.historyValues as { errorMessage: unknown }).errorMessage).toBeNull()
    expect((requests[1]!.updateSet as { lastError: unknown }).lastError).toBeNull()
  })

  it("required history: an unapplied transition is INVALID_STATE and a failure is a coded HISTORY_FAILED", async () => {
    const unapplied = build(() => [], { history: "required", atomic: () => ({ applied: false, historyId: "x" }) })
    expect(await unapplied.store.cancel({ jobId: "j", requester: system })).toEqual({ applied: false, reason: "INVALID_STATE" })
    const failing = build(() => [], { history: "required", atomic: () => { throw new Error("UNIQUE constraint failed: platform_job_executions.id") } })
    const result = await failing.store.cancel({ jobId: "j", requester: system })
    expect(result).toMatchObject({ applied: false, reason: "HISTORY_FAILED" })
    expect((result as { historyError: string }).historyError).toMatch(/^Execution history persistence failed \([A-Z_]+\)$/)
  })
})

describe("d1 job store required-history transitions", () => {
  const args = { jobId: "j", workerId: "w", claimToken: "t", attempt: 2 }
  const fence = `${J}"id" = ? and ${J}"lease_owner" = ? and ${J}"claim_token" = ? and ${J}"attempts" = ?`

  it("hands the exact update, fence and history row to the atomic transition", async () => {
    const requests: Record<string, unknown>[] = []
    const f = build(() => [], { history: "required", atomic: (request) => { requests.push(request); return { applied: true, historyId: (request.historyValues as { id: string }).id } } })
    const succeeded = await f.store.markSucceeded({ ...args, result: { ok: 1 } })
    const [first] = requests
    const id = (first!.historyValues as { id: string }).id
    expect(succeeded).toEqual({ applied: true, transitionToken: id })
    expect(first!.updateTable).toBe(jobs)
    expect(first!.historyTable).toBe(executions)
    expect(sqlOf(first!.updateWhere)).toEqual({ sql: `(${fence} and ${J}"status" = ? and ${J}"lease_expires_at" > ${CUR})`, params: ["j", "w", "t", 2, "running"] })
    expect(sqlOf(first!.historyWhere)).toEqual({ sql: `${J}"claim_token" = ?`, params: [id] })
    expect(first!.updateSet).toEqual({ status: "succeeded", resultPayload: '{"ok":1}', completedAt: nowMs, leaseOwner: null, claimToken: id, leaseExpiresAt: null })
    expect(first!.historyValues).toEqual({ id, jobId: "j", attempt: 2, workerId: "w", status: "succeeded", errorMessage: null, startedAt: nowMs, finishedAt: nowMs })

    const next = new Date("2026-03-03T00:00:00.000Z")
    await f.store.markRetrying({ ...args, error: "e", nextAttemptAt: next })
    const retry = requests[1]!
    const retryId = (retry.historyValues as { id: string }).id
    expect(sqlOf(retry.updateWhere)).toEqual({ sql: `(${fence} and ${J}"attempts" < ${J}"max_attempts" and ${J}"status" in (?) and ${J}"lease_expires_at" > ${CUR})`, params: ["j", "w", "t", 2, "running"] })
    expect(retry.updateSet).toEqual({ status: "retrying", nextAttemptAt: next, lastError: "e", leaseOwner: null, leaseExpiresAt: null, claimToken: retryId })
    expect(retry.historyValues).toEqual({ id: retryId, jobId: "j", attempt: 2, workerId: "w", status: "retrying", errorMessage: "e", startedAt: nowMs, finishedAt: nowMs })

    await f.store.markFailed({ ...args, status: "dead_letter", error: "fatal" })
    const failed = requests[2]!
    const failedId = (failed.historyValues as { id: string }).id
    expect(sqlOf(failed.updateWhere)).toEqual({ sql: `(${fence} and ${J}"status" = ? and ${J}"lease_expires_at" > ${CUR})`, params: ["j", "w", "t", 2, "running"] })
    expect(failed.updateSet).toEqual({ status: "dead_letter", lastError: "fatal", completedAt: nowMs, leaseOwner: null, leaseExpiresAt: null, claimToken: failedId })
    expect(failed.historyValues).toEqual({ id: failedId, jobId: "j", attempt: 2, workerId: "w", status: "dead_letter", errorMessage: "fatal", startedAt: nowMs, finishedAt: nowMs })
    expect(f.ops).toEqual([])
  })

  it("an unapplied atomic transition is LEASE_LOST and an atomic failure is a coded HISTORY_FAILED", async () => {
    const unapplied = build(() => [], { history: "required", atomic: () => ({ applied: false, historyId: "x" }) })
    expect(await unapplied.store.markSucceeded(args)).toEqual({ applied: false, reason: "LEASE_LOST" })
    expect(await unapplied.store.markRetrying({ ...args, error: "e", nextAttemptAt: RUN_AT })).toEqual({ applied: false, reason: "LEASE_LOST" })
    expect(await unapplied.store.markFailed({ ...args, status: "failed", error: "e" })).toEqual({ applied: false, reason: "LEASE_LOST" })
    const failing = build(() => [], { history: "required", atomic: () => { throw new Error("secret table dx_jobs") } })
    for (const result of [
      await failing.store.markSucceeded(args),
      await failing.store.markRetrying({ ...args, error: "e", nextAttemptAt: RUN_AT }),
      await failing.store.markFailed({ ...args, status: "failed", error: "e" }),
    ]) {
      expect(result).toMatchObject({ applied: false, reason: "HISTORY_FAILED" })
      const message = (result as { historyError: string }).historyError
      expect(message).toMatch(/^Execution history persistence failed \([A-Z_]+\)$/)
      expect(message).not.toContain("secret")
    }
  })
})
