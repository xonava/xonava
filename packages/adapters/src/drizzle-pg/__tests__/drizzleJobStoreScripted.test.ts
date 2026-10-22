import { describe, expect, it } from "vitest"
import { getTableColumns } from "drizzle-orm"
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { ConfigurationError, ConflictError, PersistenceError } from "@xonava/core/domain"
import { buildJobFingerprintInput, CorruptJobMetadataError, fingerprintJob, JobIdempotencyConflictError } from "@xonava/core/execution"
import { createDrizzleJobStore, LEASE_EXPIRED_ON_FINAL_ATTEMPT } from "../drizzleJobStore"
import { createScriptedDb, type ScriptedHandler, type ScriptedOp } from "../../__tests__/support/scriptedDb"

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
const maps = (withScopeKey = true) => {
  const { scopeKey, ...rest } = getTableColumns(jobs)
  return { jobs: (withScopeKey ? { ...rest, scopeKey } : rest) as never, executions: getTableColumns(executions) as never }
}

const RUN_AT = new Date("2026-01-01T00:00:00.000Z")
const system = { scope: "system" } as never
const tenant = (tenantId: string) => ({ scope: "tenant", tenantId, actorId: "u" }) as never
const baseJob = { jobType: "mail", jobVersion: 1, payload: { a: 1 }, executionScope: { kind: "system", systemKey: "framework" }, maxAttempts: 3, runAt: RUN_AT } as never
const jobRow = (overrides: Record<string, unknown> = {}) => ({
  id: "j1", jobType: "mail", jobVersion: 1, tenantId: null, scope: "system", scopeKey: null, payload: '{"a":1}', status: "pending", priority: 0, attempts: 0, maxAttempts: 3,
  runAt: RUN_AT, nextAttemptAt: RUN_AT, leaseOwner: null, leaseExpiresAt: null, claimToken: null, idempotencyKey: null, fingerprint: "v1:abc", correlationId: null,
  lastError: null, resultPayload: null, metadata: null, partitionKey: null, createdAt: RUN_AT, startedAt: null, completedAt: null, ...overrides,
})

function build(handler: ScriptedHandler, options: { history?: "best_effort" | "required"; atomic?: (request: Record<string, unknown>) => unknown; withScopeKey?: boolean } = {}) {
  const scripted = createScriptedDb("pg", handler, options.atomic ? { atomicJobTransition: options.atomic } : {})
  const store = createDrizzleJobStore(scripted.db as never, { jobsTable: jobs, executionsTable: executions, ...(options.history ? { executionHistory: options.history } : {}), columnMap: maps(options.withScopeKey ?? true) })
  return { store, ops: scripted.ops }
}
const affected = (rowCount: number) => ({ rowCount })
const kindOf = (op: ScriptedOp) => op.kind

describe("PostgreSQL job store: construction", () => {
  it("validates required history support and column maps", () => {
    expect(() => build(() => [], { history: "required" })).toThrow(ConfigurationError)
    expect(() => build(() => [], { history: "required", atomic: () => ({ applied: true, historyId: "x" }) })).not.toThrow()
    const scripted = createScriptedDb("pg", () => [])
    const { id: _id, ...noId } = getTableColumns(jobs)
    expect(() => createDrizzleJobStore(scripted.db as never, { jobsTable: jobs, executionsTable: executions, columnMap: { jobs: noId as never, executions: getTableColumns(executions) as never } })).toThrow("required 'id' column")
    const { jobId: _jobId, ...noJobId } = getTableColumns(executions)
    expect(() => createDrizzleJobStore(scripted.db as never, { jobsTable: jobs, executionsTable: executions, columnMap: { jobs: getTableColumns(jobs) as never, executions: noJobId as never } })).toThrow("executions column map")
    const foreign = pgTable("other", { x: text("x") })
    const mismatched = { ...getTableColumns(executions), id: foreign.x }
    expect(() => createDrizzleJobStore(scripted.db as never, { jobsTable: jobs, executionsTable: executions, columnMap: { jobs: getTableColumns(jobs) as never, executions: mismatched as never } })).toThrow("does not belong to the executions table")
  })
})

describe("PostgreSQL job store: enqueue", () => {
  it("inserts without an idempotency key and reads the row back", async () => {
    const { store, ops } = build((op) => (op.kind === "select" ? [jobRow({ payload: '{"a":1}', metadata: { m: 1 } })] : affected(1)))
    const job = await store.enqueue({ job: { ...(baseJob as object), correlationId: "c", partitionKey: "p", metadata: { m: 1 }, priority: 3 } as never, requester: system })
    expect(job).toMatchObject({ id: "j1", metadata: { m: 1 } })
    expect(ops.map(kindOf)).toEqual(["insert", "select"])
    expect(ops[0]!.values).toMatchObject({ jobType: "mail", scope: "system", status: "pending", priority: 3, attempts: 0, correlationId: "c", partitionKey: "p", idempotencyKey: null, idempotencyScope: "system" })
    const missing = build((op) => (op.kind === "select" ? [] : affected(1)))
    await expect(missing.store.enqueue({ job: baseJob, requester: system })).rejects.toThrow("Failed to read back enqueued job")
  })

  it("stores non-default scope keys only when the column is mapped", async () => {
    const scoped = { ...(baseJob as object), executionScope: { kind: "platform", platformKey: "ops" } } as never
    const ok = build((op) => (op.kind === "select" ? [jobRow()] : affected(1)))
    await ok.store.enqueue({ job: scoped, requester: { scope: "platform", actorId: "p" } as never })
    expect(ok.ops[0]!.values).toMatchObject({ scope: "platform", scopeKey: "ops" })
    const legacy = build(() => [], { withScopeKey: false })
    await expect(legacy.store.enqueue({ job: scoped, requester: system })).rejects.toThrow("scope-key migration")
  })

  it("returns the inserted row of an idempotent enqueue and replays an identical existing row", async () => {
    const inserted = build((op) => (op.returning ? [jobRow({ idempotencyKey: "k" })] : []))
    expect((await inserted.store.enqueue({ job: { ...(baseJob as object), idempotencyKey: "k" } as never, requester: system })).idempotencyKey).toBe("k")
    expect(inserted.ops[0]).toMatchObject({ conflictDoNothing: true, returning: true })
    const fingerprint = await fingerprintJob(buildJobFingerprintInput({ ...(baseJob as object), idempotencyKey: "k" } as never, RUN_AT))
    const replay = build((op) => (op.kind === "insert" ? [] : [jobRow({ id: "existing", idempotencyKey: "k", fingerprint })]))
    expect((await replay.store.enqueue({ job: { ...(baseJob as object), idempotencyKey: "k" } as never, requester: system })).id).toBe("existing")
    const different = build((op) => (op.kind === "insert" ? [] : [jobRow({ id: "existing", idempotencyKey: "k", fingerprint: "v1:other" })]))
    await expect(different.store.enqueue({ job: { ...(baseJob as object), idempotencyKey: "k" } as never, requester: system })).rejects.toBeInstanceOf(JobIdempotencyConflictError)
    const legacy = build((op) => (op.kind === "insert" ? [] : [jobRow({ fingerprint: "" })]))
    await expect(legacy.store.enqueue({ job: { ...(baseJob as object), idempotencyKey: "k" } as never, requester: system })).rejects.toThrow("fingerprint is missing")
    const other = build(() => [])
    await expect(other.store.enqueue({ job: { ...(baseJob as object), idempotencyKey: "k" } as never, requester: system })).rejects.toBeInstanceOf(ConflictError)
    const failing = build(() => { throw Object.assign(new Error("db down"), { code: "XX000" }) })
    await expect(failing.store.enqueue({ job: { ...(baseJob as object), idempotencyKey: "k" } as never, requester: system })).rejects.toBeInstanceOf(PersistenceError)
  })

  it("rejects an unauthorized or malformed job before any SQL", async () => {
    const { store, ops } = build(() => [])
    await expect(store.enqueue({ job: { ...(baseJob as object), executionScope: { kind: "tenant", tenantId: "t1" } } as never, requester: tenant("t2") })).rejects.toThrow()
    await expect(store.enqueue({ job: { ...(baseJob as object), maxAttempts: 0 } as never, requester: system })).rejects.toThrow()
    expect(ops).toEqual([])
  })
})

describe("PostgreSQL job store: lookups and row decoding", () => {
  it("applies requester scoping to every read", async () => {
    const { store, ops } = build(() => [jobRow({ tenantId: "t1", scope: "tenant" })])
    expect(await store.getById({ id: "j1", requester: tenant("t1") })).toMatchObject({ tenantId: "t1" })
    expect(ops[0]!.where!.params).toEqual(["j1", "tenant", "t1"])
    await store.getById({ id: "j1", requester: system })
    expect(ops[1]!.where!.sql).toContain('"scope" =')
    expect(await store.getByCorrelationId({ correlationId: "c", requester: system })).toHaveLength(1)
    expect(ops[2]).toMatchObject({ limit: 5, offset: 0 })
    await store.getByIdempotencyKey({ key: "k", requester: tenant("t1") })
    expect(ops[3]!.where!.params).toContain("tenant:t1")
    await store.getByIdempotencyKey({ key: "k", requester: system })
    expect(ops[4]!.where!.params).toContain("system")
    await store.getLatestPriorScheduleExecution({ scheduleId: "s1", beforeOccurrence: RUN_AT, requester: system } as never)
    expect(ops[5]).toMatchObject({ limit: 1, offset: 0 })
    expect(ops[5]!.where!.params.some((param) => String(param).includes("s1"))).toBe(true)
    const none = build(() => [])
    expect(await none.store.getById({ id: "x", requester: system })).toBeNull()
    expect(await none.store.getByIdempotencyKey({ key: "x", requester: system })).toBeNull()
    expect(await none.store.getLatestPriorScheduleExecution({ scheduleId: "x", beforeOccurrence: RUN_AT, requester: system } as never)).toBeNull()
  })

  it("decodes optional columns and rejects corrupt rows", async () => {
    const full = build(() => [jobRow({ leaseOwner: "w", leaseExpiresAt: RUN_AT, claimToken: "t", idempotencyKey: "k", correlationId: "c", lastError: "e", resultPayload: "{}", metadata: '{"m":1}', partitionKey: "p", startedAt: RUN_AT, completedAt: RUN_AT, attempts: 2, scopeKey: "ops", scope: "platform" })])
    expect(await full.store.getById({ id: "j1", requester: { scope: "platform", actorId: "p" } as never })).toMatchObject({
      leaseOwner: "w", claimToken: "t", idempotencyKey: "k", correlationId: "c", lastError: "e", resultPayload: "{}", metadata: { m: 1 }, partitionKey: "p", currentAttempt: 2, attemptsCompleted: 1,
      executionScope: { kind: "platform", platformKey: "ops" },
    })
    const badScope = build(() => [jobRow({ scope: "bogus" })])
    await expect(badScope.store.getById({ id: "j1", requester: system })).rejects.toThrow("missing or invalid scope")
    for (const metadata of ["[1]", "{nope", 5]) {
      const bad = build(() => [jobRow({ metadata })])
      await expect(bad.store.getById({ id: "j1", requester: system })).rejects.toBeInstanceOf(CorruptJobMetadataError)
    }
    const noFingerprint = build(() => [jobRow({ fingerprint: null })])
    await expect(noFingerprint.store.getById({ id: "j1", requester: system })).rejects.toBeInstanceOf(CorruptJobMetadataError)
  })

  it("lists pending jobs by type and limit", async () => {
    const { store, ops } = build(() => [jobRow()])
    expect(await store.findPending({ requester: system })).toHaveLength(1)
    expect(ops[0]).toMatchObject({ limit: 100, offset: 0 })
    await store.findPending({ requester: tenant("t1"), jobType: "mail", limit: 7 })
    expect(ops[1]).toMatchObject({ limit: 7 })
    expect(ops[1]!.where!.params).toContain("mail")
  })
})

describe("PostgreSQL job store: claiming and leases", () => {
  it("dead-letters expired final attempts, claims with row locks and orders the result", async () => {
    const { store, ops } = build((op) => (op.returning ? [jobRow({ id: "b", priority: 2, attempts: 1 }), jobRow({ id: "a", priority: 1, attempts: 1 }), jobRow({ id: "c", priority: 1, attempts: 1, runAt: new Date(RUN_AT.getTime() - 1000) })] : affected(0)))
    const claimed = await store.claimDue({ workerId: "w", leaseDurationMs: 5_000, limit: 3, requester: tenant("t1"), now: RUN_AT })
    expect(claimed.map((job) => job.id)).toEqual(["c", "a", "b"])
    expect(ops[0]!.set).toMatchObject({ status: "dead_letter", lastError: LEASE_EXPIRED_ON_FINAL_ATTEMPT })
    expect(ops[0]!.where!.params).toEqual(expect.arrayContaining(["running", "tenant", "t1"]))
    const claim = ops[1]!
    expect(claim.where!.sql).toContain("FOR UPDATE SKIP LOCKED")
    expect(claim.where!.sql).toContain("NOT EXISTS")
    expect(claim.where!.params).toContain(3)
    expect(claim.set).toMatchObject({ status: "running", leaseOwner: "w", nextAttemptAt: null })
  })

  it("sorts claimed jobs with equal priority and run time by id", async () => {
    const same = [jobRow({ id: "z" }), jobRow({ id: "m" }), jobRow({ id: "a" })]
    const { store } = build((op) => (op.returning ? same : affected(0)))
    expect((await store.claimDue({ workerId: "w", leaseDurationMs: 1, limit: 3, requester: system })).map((job) => job.id)).toEqual(["a", "m", "z"])
  })

  it("rejects bad worker ids and claims nothing for non-positive limits", async () => {
    const { store, ops } = build(() => [])
    await expect(store.claimDue({ workerId: "w".repeat(101), leaseDurationMs: 1, limit: 1, requester: system })).rejects.toThrow("workerId exceeds")
    expect(await store.claimDue({ workerId: "w", leaseDurationMs: 1, limit: -1, requester: system })).toEqual([])
    expect(await store.claimDue({ workerId: "w", leaseDurationMs: 1, limit: 1.5, requester: system })).toEqual([])
    expect(ops).toEqual([])
  })

  it("renews leases only for positive finite extensions and live owners", async () => {
    const { store, ops } = build(() => affected(1))
    expect(await store.renewLease({ jobId: "j", workerId: "w", claimToken: "t", extendByMs: 100 })).toBe(true)
    expect(ops[0]!.set).toBeDefined()
    expect(await store.renewLease({ jobId: "j", workerId: "w", claimToken: "t", extendByMs: -1 })).toBe(false)
    expect(await store.renewLease({ jobId: "j", workerId: "w", claimToken: "t", extendByMs: Number.NaN })).toBe(false)
    await expect(store.renewLease({ jobId: "j", workerId: "x".repeat(101), claimToken: "t", extendByMs: 1 })).rejects.toThrow("workerId exceeds")
    expect(ops).toHaveLength(1)
    expect(await build(() => affected(0)).store.renewLease({ jobId: "j", workerId: "w", claimToken: "t", extendByMs: 100 })).toBe(false)
  })

  it("releases a claim without consuming the attempt and strips NUL characters", async () => {
    const { store, ops } = build(() => affected(1))
    expect(await store.release({ jobId: "j", workerId: "w", claimToken: "t", nextAttemptAt: RUN_AT, reason: "bad\u0000reason" })).toEqual({ applied: true })
    expect((ops[0]!.set as Record<string, unknown>).lastError).toBe("bad�reason")
    expect(await build(() => affected(0)).store.release({ jobId: "j", workerId: "w", claimToken: "t", nextAttemptAt: RUN_AT, reason: "x" })).toEqual({ applied: false, reason: "LEASE_LOST" })
  })
})

describe("PostgreSQL job store: best-effort transitions", () => {
  const args = { jobId: "j", workerId: "w", claimToken: "t", attempt: 1 }

  it("updates under the fence and then records history", async () => {
    const { store, ops } = build(() => affected(1))
    expect(await store.markSucceeded({ ...args, result: { ok: 1 } })).toMatchObject({ applied: true })
    expect(ops[0]!.set).toMatchObject({ status: "succeeded", resultPayload: '{"ok":1}', claimToken: null })
    expect(ops[1]).toMatchObject({ kind: "insert" })
    expect(ops[1]!.values).toMatchObject({ jobId: "j", status: "succeeded", workerId: "w", attempt: 1, errorMessage: null })
    expect(await store.markRetrying({ ...args, error: "e\u0000x", nextAttemptAt: RUN_AT })).toMatchObject({ applied: true })
    expect(ops[2]!.set).toMatchObject({ status: "retrying", lastError: "e�x" })
    expect(await store.markFailed({ ...args, status: "dead_letter", error: "fatal" })).toMatchObject({ applied: true })
    expect(ops[4]!.set).toMatchObject({ status: "dead_letter", lastError: "fatal" })
  })

  it("reports LEASE_LOST when the fence matches nothing and tolerates a failing history insert", async () => {
    const lost = build(() => affected(0))
    expect(await lost.store.markSucceeded(args)).toEqual({ applied: false, reason: "LEASE_LOST" })
    expect(await lost.store.markRetrying({ ...args, error: "e", nextAttemptAt: RUN_AT })).toEqual({ applied: false, reason: "LEASE_LOST" })
    expect(await lost.store.markFailed({ ...args, status: "failed", error: "e" })).toEqual({ applied: false, reason: "LEASE_LOST" })
    expect(lost.ops.every((op) => op.kind === "update")).toBe(true)
    const degraded = build((op) => { if (op.kind === "insert") throw new Error("history down"); return affected(1) })
    expect(await degraded.store.markSucceeded(args)).toMatchObject({ applied: true })
  })

  it("cancels live jobs once, recording history with the observed attempt", async () => {
    const { store, ops } = build((op) => (op.kind === "select" ? [jobRow({ attempts: 2 })] : affected(1)))
    expect(await store.cancel({ jobId: "j", requester: system, reason: "stop\u0000" })).toMatchObject({ applied: true })
    expect(ops.map(kindOf)).toEqual(["select", "insert", "update"])
    expect(ops[1]!.values).toMatchObject({ attempt: 2, workerId: "cancellation", status: "cancelled" })
    expect(ops[2]!.set).toMatchObject({ status: "cancelled", lastError: "stop�" })
    const noReason = build((op) => (op.kind === "select" ? [jobRow({ attempts: null })] : affected(1)))
    await noReason.store.cancel({ jobId: "j", requester: system })
    expect(noReason.ops[1]!.values).toMatchObject({ attempt: 0, errorMessage: null })
    expect(noReason.ops[2]!.set).toMatchObject({ lastError: null })
    expect(await build(() => []).store.cancel({ jobId: "j", requester: system })).toEqual({ applied: false, reason: "INVALID_STATE" })
    const raced = build((op) => (op.kind === "select" ? [jobRow()] : affected(0)))
    expect(await raced.store.cancel({ jobId: "j", requester: system })).toEqual({ applied: false, reason: "INVALID_STATE" })
  })
})

describe("PostgreSQL job store: required history", () => {
  const args = { jobId: "j", workerId: "w", claimToken: "t", attempt: 1 }
  const atomicOk = (request: Record<string, unknown>) => ({ applied: true, historyId: (request.historyValues as Record<string, unknown>).id })

  it("hands the update and history to the atomic transition and returns its token", async () => {
    const requests: Record<string, unknown>[] = []
    const { store } = build(() => [], { history: "required", atomic: (request) => { requests.push(request); return atomicOk(request) } })
    const success = await store.markSucceeded({ ...args, result: { ok: 1 } })
    expect(success).toMatchObject({ applied: true })
    expect((requests[0]!.updateSet as Record<string, unknown>)).toMatchObject({ status: "succeeded", resultPayload: '{"ok":1}' })
    expect((requests[0]!.historyValues as Record<string, unknown>)).toMatchObject({ jobId: "j", status: "succeeded", workerId: "w" })
    expect((success as { transitionToken: string }).transitionToken).toBe((requests[0]!.historyValues as { id: string }).id)
    expect(await store.markRetrying({ ...args, error: "e", nextAttemptAt: RUN_AT })).toMatchObject({ applied: true })
    expect(await store.markFailed({ ...args, status: "failed", error: "e" })).toMatchObject({ applied: true })
    expect(requests.map((request) => (request.updateSet as { status: string }).status)).toEqual(["succeeded", "retrying", "failed"])
  })

  it("reports LEASE_LOST for unapplied transitions and a coded HISTORY_FAILED for failures", async () => {
    const unapplied = build(() => [], { history: "required", atomic: () => ({ applied: false, historyId: "x" }) })
    expect(await unapplied.store.markSucceeded(args)).toEqual({ applied: false, reason: "LEASE_LOST" })
    const failing = build(() => [], { history: "required", atomic: () => { throw Object.assign(new Error("secret table text"), { code: "23505" }) } })
    const result = await failing.store.markFailed({ ...args, status: "failed", error: "x" })
    expect(result).toMatchObject({ applied: false, reason: "HISTORY_FAILED", historyError: "Execution history persistence failed (CONFLICT)" })
    expect(JSON.stringify(result)).not.toContain("secret")
  })

  it("cancels atomically with the attempt read inside the transaction", async () => {
    const requests: Record<string, unknown>[] = []
    const { store } = build(() => [], { history: "required", atomic: (request) => { requests.push(request); return atomicOk(request) } })
    expect(await store.cancel({ jobId: "j", requester: system, reason: "stop" })).toMatchObject({ applied: true })
    expect(requests[0]!.updateSet).toMatchObject({ status: "cancelled", lastError: "stop" })
    await store.cancel({ jobId: "j", requester: system })
    expect(requests[1]!.updateSet).toMatchObject({ lastError: null })
    const unapplied = build(() => [], { history: "required", atomic: () => ({ applied: false, historyId: "x" }) })
    expect(await unapplied.store.cancel({ jobId: "j", requester: system })).toEqual({ applied: false, reason: "INVALID_STATE" })
    const failing = build(() => [], { history: "required", atomic: () => { throw new Error("history down") } })
    expect(await failing.store.cancel({ jobId: "j", requester: system })).toMatchObject({ applied: false, reason: "HISTORY_FAILED" })
  })
})
