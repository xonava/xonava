import { describe, expect, it } from "vitest"
import { getTableColumns } from "drizzle-orm"
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { ConfigurationError, ConflictError } from "@xonava/core/domain"
import { buildJobFingerprintInput, CorruptJobMetadataError, fingerprintJob } from "@xonava/core/execution"
import { createDrizzleJobStore, LEASE_EXPIRED_ON_FINAL_ATTEMPT } from "../drizzleJobStore"
import { createScriptedDb, renderSql, type ScriptedHandler, type ScriptedOp } from "../../__tests__/support/scriptedDb"

const jobs = pgTable("platform_jobs", {
  id: text("id").primaryKey(), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), scopeKey: text("scope_key"), payload: text("payload"),
  status: text("status"), priority: integer("priority"), attempts: integer("attempts"), maxAttempts: integer("max_attempts"), runAt: timestamp("run_at"), nextAttemptAt: timestamp("next_attempt_at"),
  leaseOwner: text("lease_owner"), leaseExpiresAt: timestamp("lease_expires_at"), claimToken: text("claim_token"), idempotencyKey: text("idempotency_key"), idempotencyScope: text("idempotency_scope"),
  fingerprint: text("fingerprint"), correlationId: text("correlation_id"), lastError: text("last_error"), resultPayload: text("result_payload"), metadata: text("metadata"),
  createdAt: timestamp("created_at"), startedAt: timestamp("started_at"), completedAt: timestamp("completed_at"), partitionKey: text("partition_key"),
})
const executions = pgTable("platform_job_executions", {
  id: text("id").primaryKey(), jobId: text("job_id"), attempt: integer("attempt"), workerId: text("worker_id"), status: text("status"), errorMessage: text("error_message"),
  startedAt: timestamp("started_at"), finishedAt: timestamp("finished_at"),
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
  runAt: RUN_AT, nextAttemptAt: RUN_AT, leaseOwner: null, leaseExpiresAt: null, claimToken: null, idempotencyKey: null, fingerprint: "v1:abc", correlationId: null,
  lastError: null, resultPayload: null, metadata: null, partitionKey: null, createdAt: RUN_AT, startedAt: null, completedAt: null, ...overrides,
})

interface BuildOptions { history?: "best_effort" | "required"; atomic?: (request: Record<string, unknown>) => unknown; jobsMap?: Record<string, unknown>; execMap?: Record<string, unknown> }
function build(handler: ScriptedHandler, options: BuildOptions = {}) {
  const scripted = createScriptedDb("pg", handler, options.atomic ? { atomicJobTransition: options.atomic } : {})
  const store = createDrizzleJobStore(scripted.db as never, {
    jobsTable: jobs, executionsTable: executions,
    ...(options.history ? { executionHistory: options.history } : {}),
    columnMap: { jobs: (options.jobsMap ?? jobColumns) as never, executions: (options.execMap ?? execColumns) as never },
  })
  return { store, ops: scripted.ops }
}
const affected = (rowCount: number) => ({ rowCount })
const norm = (sql: string | undefined) => (sql ?? "").replace(/\s+/g, " ")
const whereOf = (op: ScriptedOp | undefined) => ({ sql: norm(op?.where?.sql), params: op?.where?.params })
const J = '"platform_jobs".'
const sqlOf = (value: unknown) => { const r = renderSql("pg", value); return { sql: norm(r?.sql), params: r?.params } }

describe("job store construction messages", () => {
  it("reports exact configuration errors", () => {
    expect(() => build(() => [], { history: "required" })).toThrow("executionHistory 'required' requires a session that provides atomicJobTransition")
    const { id: _id, ...noId } = jobColumns
    expect(() => build(() => [], { jobsMap: noId })).toThrow(new ConfigurationError("Job store is missing the required 'id' column in its column map"))
    const { partitionKey: _p, ...noPartition } = jobColumns
    expect(() => build(() => [], { jobsMap: noPartition })).toThrow("required 'partitionKey' column")
    const { finishedAt: _f, ...noFinished } = execColumns
    expect(() => build(() => [], { execMap: noFinished })).toThrow(new ConfigurationError("Job store is missing the required 'finishedAt' column in its executions column map"))
    const foreign = pgTable("other", { x: text("x") })
    expect(() => build(() => [], { execMap: { ...execColumns, workerId: foreign.x } })).toThrow(new ConfigurationError("Job store 'workerId' column does not belong to the executions table"))
  })

  it("keys history inserts by the property that owns the column, by identity first and by physical name second", async () => {
    // Two properties share the physical name "dup": identity must pick the mapped one, not the first with that name.
    const dupExec = pgTable("dup_exec", {
      first: text("dup"), id: text("id").primaryKey(), jobId: text("job_id"), attempt: integer("attempt"), workerId: text("worker_id"), status: text("status"), errorMessage: text("error_message"),
      startedAt: timestamp("started_at"), finishedAt: timestamp("finished_at"), second: text("dup"),
    })
    const scripted = createScriptedDb("pg", () => affected(1))
    const cols = getTableColumns(dupExec) as Record<string, unknown>
    const store = createDrizzleJobStore(scripted.db as never, {
      jobsTable: jobs, executionsTable: dupExec,
      columnMap: { jobs: jobColumns as never, executions: { ...cols, workerId: cols.second } as never },
    })
    await store.markSucceeded({ jobId: "j", workerId: "w", claimToken: "t", attempt: 1 })
    expect(scripted.ops[1]!.values).toMatchObject({ second: "w" })
    expect(scripted.ops[1]!.values).not.toHaveProperty("first")
    expect(scripted.ops[1]!.values).not.toHaveProperty("workerId")

    // A column object that is not the table's own is matched by physical name.
    const lookalike = pgTable("lookalike", { id: text("id"), jobId: text("job_id") })
    const byName = build(() => affected(1), { execMap: { ...execColumns, id: lookalike.id, jobId: lookalike.jobId } })
    await byName.store.markSucceeded({ jobId: "j", workerId: "w", claimToken: "t", attempt: 1 })
    expect(byName.ops[1]!.values).toMatchObject({ id: expect.any(String), jobId: "j" })
  })
})

describe("job store metadata and row decoding", () => {
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
    await expect(read({ scope: undefined, id: "jx" })).rejects.toThrow("Job jx has a missing or invalid scope")
    await expect(read({ scope: "other" })).rejects.toThrow(ConfigurationError)
    expect((await read({ scope: "tenant", tenantId: "t1" }))?.scope).toBe("tenant")
    expect((await read({ scope: "platform", scopeKey: "ops" }))?.scope).toBe("platform")
    expect((await read({ scope: "system" }))?.scope).toBe("system")
  })

  it("decodes dates, nullable columns and numeric fields", async () => {
    const later = new Date("2026-02-02T00:00:00.000Z")
    const full = await read({ nextAttemptAt: later, leaseExpiresAt: later, startedAt: later, completedAt: later, leaseOwner: "w", claimToken: "c", priority: 4, attempts: 3, maxAttempts: 5, jobVersion: 2 })
    expect(full).toMatchObject({ nextAttemptAt: later, leaseExpiresAt: later, startedAt: later, completedAt: later, leaseOwner: "w", claimToken: "c", priority: 4, currentAttempt: 3, attemptsCompleted: 2, maxAttempts: 5, jobVersion: 2, runAt: RUN_AT, createdAt: RUN_AT })
    const bare = await read({ nextAttemptAt: null, leaseExpiresAt: null, startedAt: null, completedAt: null, leaseOwner: undefined, claimToken: undefined, attempts: 0 })
    expect(bare).toMatchObject({ nextAttemptAt: null, leaseExpiresAt: null, startedAt: null, completedAt: null, leaseOwner: null, claimToken: null, currentAttempt: 0, attemptsCompleted: 0 })
    expect(bare?.nextAttemptAt).toBeNull()
  })
})

describe("job store lookups apply exact filters", () => {
  it("getById filters by id plus scope (and tenant only for tenant requesters)", async () => {
    const f = build(() => [jobRow({ scope: "tenant", tenantId: "t1" })])
    await f.store.getById({ id: "j1", requester: tenant("t1") })
    await f.store.getById({ id: "j1", requester: system })
    await f.store.getById({ id: "j1", requester: platform })
    expect(whereOf(f.ops[0])).toEqual({ sql: `(${J}"id" = $1 and ${J}"scope" = $2 and ${J}"tenant_id" = $3)`, params: ["j1", "tenant", "t1"] })
    expect(whereOf(f.ops[1])).toEqual({ sql: `(${J}"id" = $1 and ${J}"scope" = $2)`, params: ["j1", "system"] })
    expect(whereOf(f.ops[2])).toEqual({ sql: `(${J}"id" = $1 and ${J}"scope" = $2)`, params: ["j1", "platform"] })
    expect(f.ops[0]).toMatchObject({ limit: 1 })
  })

  it("getByCorrelationId filters by correlation id, scope and tenant, newest first, and maps the rows", async () => {
    const f = build(() => [jobRow({ id: "a" }), jobRow({ id: "b" })])
    const found = await f.store.getByCorrelationId({ correlationId: "corr", requester: tenant("t1") })
    expect(found.map((job) => job.id)).toEqual(["a", "b"])
    expect(whereOf(f.ops[0])).toEqual({ sql: `(${J}"correlation_id" = $1 and ${J}"scope" = $2 and ${J}"tenant_id" = $3)`, params: ["corr", "tenant", "t1"] })
    expect(norm(f.ops[0]!.orderBy!.sql)).toBe(`${J}"created_at" desc`)
    expect(f.ops[0]).toMatchObject({ limit: 5, offset: 0 })
    await f.store.getByCorrelationId({ correlationId: "corr", requester: system })
    expect(whereOf(f.ops[1])).toEqual({ sql: `(${J}"correlation_id" = $1 and ${J}"scope" = $2)`, params: ["corr", "system"] })
  })

  it("getByIdempotencyKey scopes the key by tenant or by scope name", async () => {
    const f = build(() => [jobRow()])
    await f.store.getByIdempotencyKey({ key: "k", requester: tenant("t1") })
    await f.store.getByIdempotencyKey({ key: "k", requester: platform })
    expect(whereOf(f.ops[0])).toEqual({ sql: `(${J}"idempotency_key" = $1 and ${J}"idempotency_scope" = $2 and ${J}"scope" = $3 and ${J}"tenant_id" = $4)`, params: ["k", "tenant:t1", "tenant", "t1"] })
    expect(whereOf(f.ops[1])).toEqual({ sql: `(${J}"idempotency_key" = $1 and ${J}"idempotency_scope" = $2 and ${J}"scope" = $3)`, params: ["k", "platform", "platform"] })
  })

  it("getLatestPriorScheduleExecution looks before the occurrence, newest first", async () => {
    const f = build(() => [jobRow()])
    const found = await f.store.getLatestPriorScheduleExecution({ scheduleId: "s1", beforeOccurrence: RUN_AT, requester: tenant("t1") } as never)
    expect(found?.id).toBe("j1")
    const where = whereOf(f.ops[0])
    expect(where.sql).toBe(`(${J}"correlation_id" = $1 and ${J}"run_at" < $2 and ${J}"scope" = $3 and ${J}"tenant_id" = $4)`)
    expect(where.params?.[0]).toContain("s1")
    expect(where.params?.slice(1)).toEqual([RUN_AT.toISOString(), "tenant", "t1"])
    expect(norm(f.ops[0]!.orderBy!.sql)).toBe(`${J}"run_at" desc`)
    expect(f.ops[0]).toMatchObject({ limit: 1, offset: 0 })
  })

  it("findPending lists pending and retrying jobs in priority then age order", async () => {
    const f = build(() => [jobRow({ id: "a" }), jobRow({ id: "b" })])
    const all = await f.store.findPending({ requester: tenant("t1"), jobType: "mail", limit: 7 })
    expect(all.map((job) => job.id)).toEqual(["a", "b"])
    expect(whereOf(f.ops[0])).toEqual({ sql: `(${J}"status" in ($1, $2) and ${J}"scope" = $3 and ${J}"tenant_id" = $4 and ${J}"job_type" = $5)`, params: ["pending", "retrying", "tenant", "t1", "mail"] })
    expect(norm(f.ops[0]!.orderBy!.sql)).toBe(`${J}"priority" asc, ${J}"created_at" asc`)
    expect(f.ops[0]).toMatchObject({ limit: 7, offset: 0 })
    await f.store.findPending({ requester: system })
    expect(whereOf(f.ops[1])).toEqual({ sql: `(${J}"status" in ($1, $2) and ${J}"scope" = $3)`, params: ["pending", "retrying", "system"] })
    expect(f.ops[1]).toMatchObject({ limit: 100 })
  })
})

describe("job store enqueue writes the exact row", () => {
  const fingerprintFor = (job: Record<string, unknown>) => fingerprintJob(buildJobFingerprintInput(job as never, RUN_AT))

  it("non-idempotent enqueue inserts every column and reads the row back by id", async () => {
    const f = build((op) => (op.kind === "select" ? [jobRow()] : affected(1)))
    const job = { ...baseJob, correlationId: "c", partitionKey: "p", metadata: { m: 1 }, priority: 3 }
    await f.store.enqueue({ job: job as never, requester: system })
    const values = f.ops[0]!.values as Record<string, unknown>
    expect(values).toEqual({
      id: expect.any(String), jobType: "mail", jobVersion: 1, tenantId: null, scope: "system",
      payload: '{"a":1}', status: "pending", priority: 3, attempts: 0, maxAttempts: 3, runAt: RUN_AT, nextAttemptAt: RUN_AT,
      idempotencyKey: null, idempotencyScope: "system", fingerprint: await fingerprintFor(job), correlationId: "c",
      metadata: '{"m":1}', partitionKey: "p", createdAt: expect.any(Date),
    })
    expect(whereOf(f.ops[1])).toEqual({ sql: `${J}"id" = $1`, params: [values.id] })
    expect(f.ops[1]).toMatchObject({ limit: 1 })
    const defaults = build((op) => (op.kind === "select" ? [jobRow()] : affected(1)))
    await defaults.store.enqueue({ job: baseJob as never, requester: system })
    expect(defaults.ops[0]!.values).toMatchObject({ priority: 0, correlationId: null, metadata: null, partitionKey: null, idempotencyKey: null })
  })

  it("idempotent enqueue inserts with ON CONFLICT DO NOTHING and the same column set", async () => {
    const job = { ...baseJob, idempotencyKey: "k", correlationId: "c", partitionKey: "p", metadata: { m: 1 }, priority: 3 }
    const f = build((op) => (op.returning ? [jobRow({ idempotencyKey: "k" })] : []))
    await f.store.enqueue({ job: job as never, requester: system })
    expect(f.ops[0]!.values).toEqual({
      id: expect.any(String), jobType: "mail", jobVersion: 1, tenantId: null, scope: "system",
      payload: '{"a":1}', status: "pending", priority: 3, attempts: 0, maxAttempts: 3, runAt: RUN_AT, nextAttemptAt: RUN_AT,
      idempotencyKey: "k", idempotencyScope: "system", fingerprint: await fingerprintFor(job), correlationId: "c",
      metadata: '{"m":1}', partitionKey: "p", createdAt: expect.any(Date),
    })
    const bare = build((op) => (op.returning ? [jobRow()] : []))
    await bare.store.enqueue({ job: { ...baseJob, idempotencyKey: "k" } as never, requester: system })
    expect(bare.ops[0]!.values).toMatchObject({ priority: 0, correlationId: null, metadata: null, partitionKey: null })
  })

  it("a tenant job is keyed by tenant:<id> and stores the tenant", async () => {
    const f = build((op) => (op.returning ? [jobRow()] : []))
    await f.store.enqueue({ job: { ...baseJob, executionScope: { kind: "tenant", tenantId: "t1" }, idempotencyKey: "k" } as never, requester: tenant("t1") })
    expect(f.ops[0]!.values).toMatchObject({ tenantId: "t1", scope: "tenant", idempotencyScope: "tenant:t1" })
    expect(f.ops[0]!.values).not.toHaveProperty("scopeKey")
  })

  it("looks the existing row up by idempotency scope and key when the insert conflicts", async () => {
    const job = { ...baseJob, idempotencyKey: "k" }
    const fingerprint = await fingerprintFor(job)
    const f = build((op) => (op.kind === "insert" ? [] : [jobRow({ id: "existing", idempotencyKey: "k", fingerprint })]))
    expect((await f.store.enqueue({ job: job as never, requester: system })).id).toBe("existing")
    expect(whereOf(f.ops[1])).toEqual({ sql: `(${J}"idempotency_scope" = $1 and ${J}"idempotency_key" = $2)`, params: ["system", "k"] })
    expect(f.ops[1]).toMatchObject({ limit: 1 })
  })

  it("normalizes insert failures with the postgresql dialect and reports an unexplained conflict", async () => {
    const job = { ...baseJob, idempotencyKey: "k" }
    const failing = build(() => { throw Object.assign(new Error("fk"), { code: "23503" }) })
    const error = (await failing.store.enqueue({ job: job as never, requester: system }).catch((e: unknown) => e)) as { message: string; details?: Record<string, unknown> }
    expect(error.message).toBe("Referenced record not found")
    expect(error.details).toEqual({ dialect: "postgresql", providerCode: "23503" })
    const none = build(() => [])
    const conflict = (await none.store.enqueue({ job: job as never, requester: system }).catch((e: unknown) => e)) as ConflictError
    expect(conflict).toBeInstanceOf(ConflictError)
    expect(conflict.message).toBe("A record with this value already exists")
    expect(conflict.details).toEqual({ dialect: "postgresql" })
  })
})

describe("job store claiming", () => {
  const part = (alias: string) => `"${alias}"."partition_key" = ${J}"partition_key" AND "${alias}"."scope" = ${J}"scope" AND "${alias}"."tenant_id" IS NOT DISTINCT FROM ${J}"tenant_id" AND "${alias}"."scope_key" IS NOT DISTINCT FROM ${J}"scope_key" AND "${alias}"."id" <> ${J}"id"`
  const sibling = `NOT EXISTS (SELECT 1 FROM "platform_jobs" sibling WHERE ${part("sibling")} AND "sibling"."status" = 'running' AND "sibling"."lease_expires_at" > now())`
  const ahead = `NOT EXISTS (SELECT 1 FROM "platform_jobs" ahead WHERE ${part("ahead")} AND (("ahead"."status" IN ('pending', 'retrying') AND "ahead"."attempts" < "ahead"."max_attempts" AND "ahead"."next_attempt_at" <= $X) OR ("ahead"."status" = 'running' AND "ahead"."attempts" < "ahead"."max_attempts" AND "ahead"."lease_expires_at" < now())) AND ("ahead"."priority", "ahead"."run_at", "ahead"."id") < (${J}"priority", ${J}"run_at", ${J}"id"))`
  const dueClause = (first: number) => `((${J}"status" in ($${first}, $${first + 1}) and ${J}"attempts" < ${J}"max_attempts" and ${J}"next_attempt_at" <= $${first + 2}) or (${J}"status" = $${first + 3} and ${J}"attempts" < ${J}"max_attempts" and ${J}"lease_expires_at" < now()))`

  it("claims for a tenant requester: dead-letters expired final attempts, then locks and claims the head of each partition", async () => {
    const f = build((op) => (op.returning ? [] : affected(0)))
    await f.store.claimDue({ workerId: "w", leaseDurationMs: 5_000, limit: 3, requester: tenant("t1"), now: RUN_AT })
    const [dead, claim] = f.ops
    expect(whereOf(dead)).toEqual({
      sql: `(${J}"status" = $1 and ${J}"lease_expires_at" < now() and ${J}"attempts" >= ${J}"max_attempts" and (${J}"scope" = $2 and ${J}"tenant_id" = $3))`,
      params: ["running", "tenant", "t1"],
    })
    expect(Object.keys(dead!.set as object)).toEqual(["status", "lastError", "completedAt", "leaseOwner", "claimToken", "leaseExpiresAt"])
    expect(dead!.set).toMatchObject({ status: "dead_letter", lastError: LEASE_EXPIRED_ON_FINAL_ATTEMPT, leaseOwner: null, claimToken: null, leaseExpiresAt: null })
    expect(sqlOf((dead!.set as { completedAt: unknown }).completedAt)).toEqual({ sql: "now()", params: [] })

    const scopeClause = `(${J}"scope" = $5 and ${J}"tenant_id" = $6)`
    const expectedWhere = `(${J}"id" = ANY(ARRAY(SELECT ${J}"id" FROM "platform_jobs" WHERE (${dueClause(1)} and ${scopeClause} and ${sibling} and ${ahead.replace("$X", "$7")}) ORDER BY ${J}"priority" ASC, ${J}"run_at" ASC, ${J}"id" ASC LIMIT $8 FOR UPDATE SKIP LOCKED)) and ${dueClause(9)} and (${J}"scope" = $13 and ${J}"tenant_id" = $14) and ${sibling})`
    expect(whereOf(claim)).toEqual({
      sql: expectedWhere,
      params: ["pending", "retrying", RUN_AT.toISOString(), "running", "tenant", "t1", RUN_AT, 3, "pending", "retrying", RUN_AT.toISOString(), "running", "tenant", "t1"],
    })
    expect(Object.keys(claim!.set as object)).toEqual(["status", "leaseOwner", "claimToken", "leaseExpiresAt", "attempts", "startedAt", "nextAttemptAt"])
    const set = claim!.set as Record<string, unknown>
    expect(set).toMatchObject({ status: "running", leaseOwner: "w", startedAt: RUN_AT, nextAttemptAt: null })
    expect(sqlOf(set.claimToken)).toEqual({ sql: "gen_random_uuid()::text", params: [] })
    expect(sqlOf(set.leaseExpiresAt)).toEqual({ sql: "now() + ($1 * interval '1 millisecond')", params: [5_000] })
    expect(sqlOf(set.attempts)).toEqual({ sql: `${J}"attempts" + 1`, params: [] })
    expect(claim!.returning).toBe(true)
  })

  it("claims for a system requester with only the scope filter", async () => {
    const f = build((op) => (op.returning ? [] : affected(0)))
    await f.store.claimDue({ workerId: "w", leaseDurationMs: 1, limit: 2, requester: system, now: RUN_AT })
    expect(whereOf(f.ops[0])).toEqual({
      sql: `(${J}"status" = $1 and ${J}"lease_expires_at" < now() and ${J}"attempts" >= ${J}"max_attempts" and ${J}"scope" = $2)`,
      params: ["running", "system"],
    })
    const claim = whereOf(f.ops[1])
    expect(claim.sql).toBe(`(${J}"id" = ANY(ARRAY(SELECT ${J}"id" FROM "platform_jobs" WHERE (${dueClause(1)} and ${J}"scope" = $5 and ${sibling} and ${ahead.replace("$X", "$6")}) ORDER BY ${J}"priority" ASC, ${J}"run_at" ASC, ${J}"id" ASC LIMIT $7 FOR UPDATE SKIP LOCKED)) and ${dueClause(8)} and ${J}"scope" = $12 and ${sibling})`)
    expect(claim.params).toEqual(["pending", "retrying", RUN_AT.toISOString(), "running", "system", RUN_AT, 2, "pending", "retrying", RUN_AT.toISOString(), "running", "system"])
  })

  it("defaults the clock to the current time", async () => {
    const f = build((op) => (op.returning ? [] : affected(0)))
    const before = Date.now()
    await f.store.claimDue({ workerId: "w", leaseDurationMs: 1, limit: 1, requester: system })
    const stamp = (f.ops[1]!.set as { startedAt: unknown }).startedAt
    expect(stamp).toBeInstanceOf(Date)
    expect((stamp as Date).getTime()).toBeGreaterThanOrEqual(before)
    expect((stamp as Date).getTime()).toBeLessThanOrEqual(Date.now())
    expect(f.ops[1]!.where!.params[2]).toBe((stamp as Date).toISOString())
  })

  it("claims nothing for a zero limit and keeps duplicate ids in input order", async () => {
    const zero = build(() => [])
    expect(await zero.store.claimDue({ workerId: "w", leaseDurationMs: 1, limit: 0, requester: system })).toEqual([])
    expect(zero.ops).toEqual([])
    const dupes = build((op) => (op.returning ? [jobRow({ id: "same", payload: "first" }), jobRow({ id: "same", payload: "second" })] : affected(0)))
    const claimed = await dupes.store.claimDue({ workerId: "w", leaseDurationMs: 1, limit: 2, requester: system })
    expect(claimed.map((job) => job.payload)).toEqual(["first", "second"])
    const mixed = build((op) => (op.returning ? [
      jobRow({ id: "b", priority: 1 }), jobRow({ id: "a", priority: 1, runAt: new Date(RUN_AT.getTime() + 1) }), jobRow({ id: "c", priority: 0, runAt: new Date(RUN_AT.getTime() + 5) }), jobRow({ id: "a", priority: 1 }),
    ] : affected(0)))
    expect((await mixed.store.claimDue({ workerId: "w", leaseDurationMs: 1, limit: 4, requester: system })).map((job) => job.id)).toEqual(["c", "a", "b", "a"])
  })
})

describe("job store claim ordering and partition SQL without a scope-key column", () => {
  it("orders claims that tie on priority and run time by id, whatever the input order", async () => {
    for (const ids of [["d", "b", "a", "c", "e"], ["e", "d", "c", "b", "a"], ["a", "b", "c", "d", "e"], ["c", "a", "e", "b", "d"]]) {
      const f = build((op) => (op.returning ? ids.map((id) => jobRow({ id })) : affected(0)))
      const claimed = await f.store.claimDue({ workerId: "w", leaseDurationMs: 1, limit: 5, requester: system })
      expect(claimed.map((job) => job.id)).toEqual(["a", "b", "c", "d", "e"])
    }
  })

  it("compares only the mapped partition columns when the table has no scope-key column", async () => {
    const { scopeKey: _scopeKey, ...withoutScopeKey } = jobColumns
    const f = build((op) => (op.returning ? [] : affected(0)), { jobsMap: withoutScopeKey })
    await f.store.claimDue({ workerId: "w", leaseDurationMs: 1, limit: 1, requester: system, now: RUN_AT })
    const text = norm(f.ops[1]!.where!.sql)
    expect(text).not.toContain("scope_key")
    expect(text).not.toContain("Stryker")
    const part = (alias: string) => `"${alias}"."partition_key" = ${J}"partition_key" AND "${alias}"."scope" = ${J}"scope" AND "${alias}"."tenant_id" IS NOT DISTINCT FROM ${J}"tenant_id" AND "${alias}"."id" <> ${J}"id"`
    expect(text).toContain(`NOT EXISTS (SELECT 1 FROM "platform_jobs" sibling WHERE ${part("sibling")} AND "sibling"."status" = 'running'`)
    expect(text).toContain(`NOT EXISTS (SELECT 1 FROM "platform_jobs" ahead WHERE ${part("ahead")} AND ((`)
  })
})

describe("job store lease renewal and release", () => {
  it("renewal only extends a live, owned, running claim and never shortens the lease", async () => {
    const f = build(() => affected(1))
    expect(await f.store.renewLease({ jobId: "j", workerId: "w", claimToken: "t", extendByMs: 100 })).toBe(true)
    expect(whereOf(f.ops[0])).toEqual({
      sql: `(${J}"id" = $1 and ${J}"lease_owner" = $2 and ${J}"claim_token" = $3 and ${J}"status" = $4 and ${J}"lease_expires_at" > now())`,
      params: ["j", "w", "t", "running"],
    })
    expect(Object.keys(f.ops[0]!.set as object)).toEqual(["leaseExpiresAt"])
    expect(sqlOf((f.ops[0]!.set as { leaseExpiresAt: unknown }).leaseExpiresAt)).toEqual({ sql: `GREATEST(${J}"lease_expires_at", now() + ($1 * interval '1 millisecond'))`, params: [100] })
    expect(await f.store.renewLease({ jobId: "j", workerId: "w", claimToken: "t", extendByMs: 0 })).toBe(false)
    expect(await f.store.renewLease({ jobId: "j", workerId: "w", claimToken: "t", extendByMs: Number.POSITIVE_INFINITY })).toBe(false)
    expect(f.ops).toHaveLength(1)
  })

  it("release is fenced, restores the attempt and truncates the reason to 512 characters", async () => {
    const f = build(() => affected(1))
    expect(await f.store.release({ jobId: "j", workerId: "w", claimToken: "t", nextAttemptAt: RUN_AT, reason: "r".repeat(600) })).toEqual({ applied: true })
    expect(whereOf(f.ops[0])).toEqual({
      sql: `(${J}"id" = $1 and ${J}"lease_owner" = $2 and ${J}"claim_token" = $3 and ${J}"status" = $4 and ${J}"lease_expires_at" > now())`,
      params: ["j", "w", "t", "running"],
    })
    const set = f.ops[0]!.set as Record<string, unknown>
    expect(Object.keys(set)).toEqual(["status", "attempts", "nextAttemptAt", "lastError", "leaseOwner", "leaseExpiresAt", "claimToken"])
    expect(set).toMatchObject({ status: "retrying", nextAttemptAt: RUN_AT, lastError: "r".repeat(512), leaseOwner: null, leaseExpiresAt: null, claimToken: null })
    expect(sqlOf(set.attempts)).toEqual({ sql: "CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END", params: [] })
  })
})

describe("job store best-effort transitions write exact fences, values and history", () => {
  const args = { jobId: "j", workerId: "w", claimToken: "t", attempt: 2 }
  const fence = `${J}"id" = $1 and ${J}"lease_owner" = $2 and ${J}"claim_token" = $3 and ${J}"attempts" = $4`

  it("markSucceeded", async () => {
    const f = build(() => affected(1))
    const result = await f.store.markSucceeded({ ...args, result: { ok: 1 } })
    expect(result).toEqual({ applied: true, transitionToken: expect.any(String) })
    expect(whereOf(f.ops[0])).toEqual({ sql: `(${fence} and ${J}"status" = $5 and ${J}"lease_expires_at" > now())`, params: ["j", "w", "t", 2, "running"] })
    expect(Object.keys(f.ops[0]!.set as object)).toEqual(["status", "resultPayload", "completedAt", "leaseOwner", "claimToken", "leaseExpiresAt"])
    expect(f.ops[0]!.set).toMatchObject({ status: "succeeded", resultPayload: '{"ok":1}', completedAt: expect.any(Date), leaseOwner: null, claimToken: null, leaseExpiresAt: null })
    expect(f.ops[1]!.values).toEqual({ id: (result as { transitionToken: string }).transitionToken, jobId: "j", attempt: 2, workerId: "w", status: "succeeded", errorMessage: null, startedAt: expect.any(Date), finishedAt: expect.any(Date) })
    await f.store.markSucceeded(args)
    expect((f.ops[2]!.set as { resultPayload: unknown }).resultPayload).toBeNull()
  })

  it("markRetrying", async () => {
    const f = build(() => affected(1))
    const next = new Date("2026-03-03T00:00:00.000Z")
    const result = await f.store.markRetrying({ ...args, error: "oops\u0000", nextAttemptAt: next })
    expect(result).toEqual({ applied: true, transitionToken: expect.any(String) })
    expect(whereOf(f.ops[0])).toEqual({ sql: `(${fence} and ${J}"attempts" < ${J}"max_attempts" and ${J}"status" in ($5) and ${J}"lease_expires_at" > now())`, params: ["j", "w", "t", 2, "running"] })
    expect(Object.keys(f.ops[0]!.set as object)).toEqual(["status", "nextAttemptAt", "lastError", "leaseOwner", "claimToken", "leaseExpiresAt"])
    expect(f.ops[0]!.set).toMatchObject({ status: "retrying", nextAttemptAt: next, lastError: "oops�", leaseOwner: null, claimToken: null, leaseExpiresAt: null })
    expect(f.ops[1]!.values).toEqual({ id: (result as { transitionToken: string }).transitionToken, jobId: "j", attempt: 2, workerId: "w", status: "retrying", errorMessage: "oops�", startedAt: expect.any(Date), finishedAt: expect.any(Date) })
  })

  it("markFailed", async () => {
    const f = build(() => affected(1))
    const result = await f.store.markFailed({ ...args, status: "dead_letter", error: "fatal" })
    expect(result).toEqual({ applied: true, transitionToken: expect.any(String) })
    expect(whereOf(f.ops[0])).toEqual({ sql: `(${fence} and ${J}"status" = $5 and ${J}"lease_expires_at" > now())`, params: ["j", "w", "t", 2, "running"] })
    expect(Object.keys(f.ops[0]!.set as object)).toEqual(["status", "lastError", "completedAt", "leaseOwner", "claimToken", "leaseExpiresAt"])
    expect(f.ops[0]!.set).toMatchObject({ status: "dead_letter", lastError: "fatal", completedAt: expect.any(Date), leaseOwner: null, claimToken: null, leaseExpiresAt: null })
    expect(f.ops[1]!.values).toMatchObject({ status: "dead_letter", errorMessage: "fatal", attempt: 2 })
  })

  it("a failing history insert still reports the applied transition with its token", async () => {
    const f = build((op) => { if (op.kind === "insert") throw new Error("history down"); return affected(1) })
    expect(await f.store.markSucceeded(args)).toEqual({ applied: true, transitionToken: expect.any(String) })
    expect(await f.store.markRetrying({ ...args, error: "e", nextAttemptAt: RUN_AT })).toEqual({ applied: true, transitionToken: expect.any(String) })
    expect(await f.store.markFailed({ ...args, status: "failed", error: "e" })).toEqual({ applied: true, transitionToken: expect.any(String) })
  })
})

describe("job store cancel", () => {
  const live = (requesterParams: unknown[]) => ["j", "succeeded", "cancelled", "dead_letter", "failed", ...requesterParams]
  const liveSql = (requesterSql: string) => `(${J}"id" = $1 and ${J}"status" <> $2 and ${J}"status" <> $3 and ${J}"status" <> $4 and ${J}"status" <> $5${requesterSql})`

  it("best-effort: selects a cancellable job in the requester's scope, records history, then cancels", async () => {
    const f = build((op) => (op.kind === "select" ? [jobRow({ attempts: 2 })] : affected(1)))
    const result = await f.store.cancel({ jobId: "j", requester: tenant("t1"), reason: "stop\u0000" })
    expect(result).toEqual({ applied: true, transitionToken: expect.any(String) })
    const sqlTail = ` and ${J}"scope" = $6 and ${J}"tenant_id" = $7`
    expect(whereOf(f.ops[0])).toEqual({ sql: liveSql(sqlTail), params: live(["tenant", "t1"]) })
    expect(whereOf(f.ops[2])).toEqual({ sql: liveSql(sqlTail), params: live(["tenant", "t1"]) })
    expect(f.ops[0]).toMatchObject({ limit: 1 })
    expect(f.ops[1]!.values).toEqual({ id: (result as { transitionToken: string }).transitionToken, jobId: "j", attempt: 2, workerId: "cancellation", status: "cancelled", errorMessage: "stop�", startedAt: expect.any(Date), finishedAt: expect.any(Date) })
    expect(Object.keys(f.ops[2]!.set as object)).toEqual(["status", "completedAt", "lastError", "leaseOwner", "claimToken", "leaseExpiresAt"])
    expect(f.ops[2]!.set).toMatchObject({ status: "cancelled", completedAt: expect.any(Date), lastError: "stop�", leaseOwner: null, claimToken: null, leaseExpiresAt: null })
    const systemCancel = build((op) => (op.kind === "select" ? [jobRow()] : affected(1)))
    await systemCancel.store.cancel({ jobId: "j", requester: system })
    expect(whereOf(systemCancel.ops[0])).toEqual({ sql: liveSql(` and ${J}"scope" = $6`), params: live(["system"]) })
  })

  it("required history: cancels atomically and reads the attempt inside the transaction", async () => {
    const requests: Record<string, unknown>[] = []
    const f = build(() => [], { history: "required", atomic: (request) => { requests.push(request); return { applied: true, historyId: (request.historyValues as { id: string }).id } } })
    const result = await f.store.cancel({ jobId: "j", requester: tenant("t1"), reason: "stop\u0000" })
    const request = requests[0]!
    const historyValues = request.historyValues as Record<string, unknown>
    expect(result).toEqual({ applied: true, transitionToken: historyValues.id })
    expect(Object.keys(request).sort()).toEqual(["historyTable", "historyValues", "historyWhere", "updateSet", "updateTable", "updateWhere"])
    expect(request.updateTable).toBe(jobs)
    expect(request.historyTable).toBe(executions)
    expect(sqlOf(request.updateWhere)).toEqual({ sql: liveSql(` and ${J}"scope" = $6 and ${J}"tenant_id" = $7`), params: live(["tenant", "t1"]) })
    expect(request.updateSet).toEqual({ status: "cancelled", completedAt: expect.any(Date), lastError: "stop�", leaseOwner: null, claimToken: historyValues.id, leaseExpiresAt: null })
    expect(sqlOf(request.historyWhere)).toEqual({ sql: `${J}"claim_token" = $1`, params: [historyValues.id] })
    expect(sqlOf(historyValues.attempt)).toEqual({ sql: `(SELECT ${J}"attempts" FROM "platform_jobs" WHERE ${J}"id" = $1)`, params: ["j"] })
    expect(historyValues).toEqual({ id: expect.any(String), jobId: "j", attempt: historyValues.attempt, workerId: "cancellation", status: "cancelled", errorMessage: "stop�", startedAt: expect.any(Date), finishedAt: expect.any(Date) })
    await f.store.cancel({ jobId: "j", requester: system })
    expect((requests[1]!.historyValues as { errorMessage: unknown }).errorMessage).toBeNull()
  })
})

describe("job store required-history transitions", () => {
  const args = { jobId: "j", workerId: "w", claimToken: "t", attempt: 2 }
  const fence = `${J}"id" = $1 and ${J}"lease_owner" = $2 and ${J}"claim_token" = $3 and ${J}"attempts" = $4`

  it("hands the exact update, fence and history row to the atomic transition", async () => {
    const requests: Record<string, unknown>[] = []
    const f = build(() => [], { history: "required", atomic: (request) => { requests.push(request); return { applied: true, historyId: (request.historyValues as { id: string }).id } } })
    const succeeded = await f.store.markSucceeded({ ...args, result: { ok: 1 } })
    const [first] = requests
    const id = (first!.historyValues as { id: string }).id
    expect(succeeded).toEqual({ applied: true, transitionToken: id })
    expect(first!.updateTable).toBe(jobs)
    expect(first!.historyTable).toBe(executions)
    expect(sqlOf(first!.updateWhere)).toEqual({ sql: `(${fence} and ${J}"status" = $5 and ${J}"lease_expires_at" > now())`, params: ["j", "w", "t", 2, "running"] })
    expect(sqlOf(first!.historyWhere)).toEqual({ sql: `${J}"claim_token" = $1`, params: [id] })
    expect(first!.updateSet).toEqual({ status: "succeeded", resultPayload: '{"ok":1}', completedAt: expect.any(Date), leaseOwner: null, claimToken: id, leaseExpiresAt: null })
    expect(first!.historyValues).toEqual({ id, jobId: "j", attempt: 2, workerId: "w", status: "succeeded", errorMessage: null, startedAt: expect.any(Date), finishedAt: expect.any(Date) })

    const next = new Date("2026-03-03T00:00:00.000Z")
    await f.store.markRetrying({ ...args, error: "e\u0000", nextAttemptAt: next })
    const retry = requests[1]!
    const retryId = (retry.historyValues as { id: string }).id
    expect(sqlOf(retry.updateWhere)).toEqual({ sql: `(${fence} and ${J}"attempts" < ${J}"max_attempts" and ${J}"status" in ($5) and ${J}"lease_expires_at" > now())`, params: ["j", "w", "t", 2, "running"] })
    expect(retry.updateSet).toEqual({ status: "retrying", nextAttemptAt: next, lastError: "e�", leaseOwner: null, claimToken: retryId, leaseExpiresAt: null })
    expect(retry.historyValues).toEqual({ id: retryId, jobId: "j", attempt: 2, workerId: "w", status: "retrying", errorMessage: "e�", startedAt: expect.any(Date), finishedAt: expect.any(Date) })

    await f.store.markFailed({ ...args, status: "dead_letter", error: "fatal" })
    const failed = requests[2]!
    const failedId = (failed.historyValues as { id: string }).id
    expect(sqlOf(failed.updateWhere)).toEqual({ sql: `(${fence} and ${J}"status" = $5 and ${J}"lease_expires_at" > now())`, params: ["j", "w", "t", 2, "running"] })
    expect(failed.updateSet).toEqual({ status: "dead_letter", lastError: "fatal", completedAt: expect.any(Date), leaseOwner: null, claimToken: failedId, leaseExpiresAt: null })
    expect(failed.historyValues).toEqual({ id: failedId, jobId: "j", attempt: 2, workerId: "w", status: "dead_letter", errorMessage: "fatal", startedAt: expect.any(Date), finishedAt: expect.any(Date) })
    expect(f.ops).toEqual([])
  })

  it("an unapplied atomic transition is LEASE_LOST and an atomic failure is a coded HISTORY_FAILED", async () => {
    const unapplied = build(() => [], { history: "required", atomic: () => ({ applied: false, historyId: "x" }) })
    expect(await unapplied.store.markRetrying({ ...args, error: "e", nextAttemptAt: RUN_AT })).toEqual({ applied: false, reason: "LEASE_LOST" })
    expect(await unapplied.store.markFailed({ ...args, status: "failed", error: "e" })).toEqual({ applied: false, reason: "LEASE_LOST" })
    const failing = build(() => [], { history: "required", atomic: () => { throw Object.assign(new Error("secret"), { code: "40001" }) } })
    for (const result of [
      await failing.store.markSucceeded(args),
      await failing.store.markRetrying({ ...args, error: "e", nextAttemptAt: RUN_AT }),
      await failing.store.markFailed({ ...args, status: "failed", error: "e" }),
      await failing.store.cancel({ jobId: "j", requester: system }),
    ]) {
      expect(result).toEqual({ applied: false, reason: "HISTORY_FAILED", historyError: "Execution history persistence failed (RETRYABLE_PERSISTENCE_ERROR)" })
    }
  })
})
