import { describe, expect, it } from "vitest"
import { ConfigurationError } from "@xonava/core/domain"
import { buildJobFingerprintInput, fingerprintJob, JobIdempotencyConflictError } from "@xonava/core/execution"
import { DrizzleMySqlJobStore, MYSQL_JOB_LEASE_EXHAUSTED_REASON, MYSQL_JOB_STORE_TABLES } from "../drizzleJobStore"
import { createScriptedMySqlPool, type PoolCall } from "../../__tests__/support/scriptedPool"

const RUN_AT = new Date("2026-01-01T00:00:00.000Z")
const system = { scope: "system" } as never
const tenant = (tenantId: string) => ({ scope: "tenant", tenantId, actorId: "u" }) as never
const platform = { scope: "platform", actorId: "p" } as never
const baseJob = { jobType: "mail", jobVersion: 1, payload: { a: 1 }, executionScope: { kind: "system", systemKey: "framework" }, maxAttempts: 3, runAt: RUN_AT } as never

const jobRow = (overrides: Record<string, unknown> = {}) => ({
  id: "j1", job_type: "mail", job_version: 1, tenant_id: null, scope: "system", scope_key: null, payload: '{"a":1}', status: "pending", priority: 0, attempt: 0, max_attempts: 3,
  run_at: RUN_AT, next_attempt_at: RUN_AT, worker_id: null, lease_expires_at: null, claim_token: null, idempotency_key: null, fingerprint: "v1:abc", correlation_id: null,
  last_error: null, result_payload: null, metadata: null, partition_key: null, created_at: RUN_AT, started_at: null, completed_at: null, ...overrides,
})
const header = (affectedRows: number) => ({ affectedRows })
const isSelect = (call: PoolCall) => /^\s*SELECT/i.test(call.sql)
const lockError = (errno = 1213) => Object.assign(new Error("deadlock text"), { errno })

describe("MySQL job store: enqueue and lookups", () => {
  it("inserts a job with encoded scope columns and returns the stored row", async () => {
    const { pool, calls } = createScriptedMySqlPool((call) => (isSelect(call) ? [jobRow({ payload: { a: 1 }, metadata: '{"m":1}', result_payload: { r: 1 }, worker_id: "w", correlation_id: "c", partition_key: "p", started_at: RUN_AT, completed_at: RUN_AT, last_error: "e", idempotency_key: "k", claim_token: "t", lease_expires_at: RUN_AT })] : header(1)))
    const store = new DrizzleMySqlJobStore(pool as never)
    const job = await store.enqueue({ job: { ...(baseJob as object), executionScope: { kind: "system", systemKey: "custom" }, idempotencyKey: "k", metadata: { m: 1 }, partitionKey: "p", correlationId: "c", priority: 4 } as never, requester: system })
    expect(job).toMatchObject({ id: "j1", payload: '{"a":1}', metadata: { m: 1 }, resultPayload: '{"r":1}', leaseOwner: "w", partitionKey: "p", correlationId: "c", idempotencyKey: "k", claimToken: "t", lastError: "e" })
    const insert = calls[0]!
    expect(insert.sql).toContain("INSERT INTO `jobs`(")
    expect(insert.params).toEqual(expect.arrayContaining(["system", "custom", 4, "k", "system", "p", "c"]))
    expect(calls[1]!.sql).toBe("SELECT * FROM `jobs` WHERE id=?")
  })

  it("replays an identical idempotent enqueue and conflicts on a different fingerprint", async () => {
    const jobInput = buildJobFingerprintInput({ ...(baseJob as object), idempotencyKey: "k" } as never, RUN_AT)
    const fingerprint = await fingerprintJob(jobInput)
    const duplicate = Object.assign(new Error("dup"), { errno: 1062 })
    const respond = (stored: string | null) => (call: PoolCall) => {
      if (call.sql.startsWith("INSERT")) throw duplicate
      return [jobRow({ id: "existing", idempotency_key: "k", fingerprint: stored })]
    }
    const same = new DrizzleMySqlJobStore(createScriptedMySqlPool(respond(fingerprint)).pool as never)
    expect((await same.enqueue({ job: { ...(baseJob as object), idempotencyKey: "k" } as never, requester: system })).id).toBe("existing")
    const different = new DrizzleMySqlJobStore(createScriptedMySqlPool(respond("v1:other")).pool as never)
    await expect(different.enqueue({ job: { ...(baseJob as object), idempotencyKey: "k" } as never, requester: system })).rejects.toBeInstanceOf(JobIdempotencyConflictError)
    const vanished = new DrizzleMySqlJobStore(createScriptedMySqlPool((call) => { if (call.sql.startsWith("INSERT")) throw duplicate; return [] }).pool as never)
    await expect(vanished.enqueue({ job: { ...(baseJob as object), idempotencyKey: "k" } as never, requester: system })).rejects.toBe(duplicate)
    const noKey = new DrizzleMySqlJobStore(createScriptedMySqlPool(() => { throw duplicate }).pool as never)
    await expect(noKey.enqueue({ job: baseJob, requester: system })).rejects.toBe(duplicate)
    const other = Object.assign(new Error("boom"), { errno: 1 })
    await expect(new DrizzleMySqlJobStore(createScriptedMySqlPool(() => { throw other }).pool as never).enqueue({ job: { ...(baseJob as object), idempotencyKey: "k" } as never, requester: system })).rejects.toBe(other)
  })

  it("validates the requester before issuing any SQL", async () => {
    const { pool, calls } = createScriptedMySqlPool(() => header(1))
    const store = new DrizzleMySqlJobStore(pool as never)
    await expect(store.enqueue({ job: { ...(baseJob as object), executionScope: { kind: "tenant", tenantId: "t1" } } as never, requester: platform })).rejects.toThrow()
    await expect(store.enqueue({ job: { ...(baseJob as object), jobType: "" } as never, requester: system })).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it("scopes every lookup by the requester and decodes rows", async () => {
    const { pool, calls } = createScriptedMySqlPool(() => [jobRow({ tenant_id: "t1", scope: "tenant" })])
    const store = new DrizzleMySqlJobStore(pool as never)
    expect(await store.getById({ id: "j1", requester: tenant("t1") })).toMatchObject({ tenantId: "t1", scope: "tenant" })
    expect(calls[0]!.sql).toContain("scope=? AND tenant_id=?")
    expect(calls[0]!.params).toEqual(["j1", "tenant", "t1"])
    await store.getById({ id: "j1", requester: system })
    expect(calls[1]!.sql).toContain("scope=? AND tenant_id IS NULL")
    expect(await store.getByCorrelationId({ correlationId: "c", requester: system })).toHaveLength(1)
    expect(calls[2]!.sql).toContain("ORDER BY created_at DESC LIMIT 5")
    await store.getByIdempotencyKey({ key: "k", requester: tenant("t1") })
    expect(calls[3]!.params).toEqual(["tenant:t1", "k", "tenant", "t1"])
    await store.getByIdempotencyKey({ key: "k", requester: system })
    expect(calls[4]!.params).toEqual(["system", "k", "system"])
    await store.getLatestPriorScheduleExecution({ scheduleId: "s1", beforeOccurrence: RUN_AT, requester: system } as never)
    expect(calls[5]!.sql).toContain("run_at<?")
    expect(calls[5]!.params[0]).toContain("s1")
    const none = new DrizzleMySqlJobStore(createScriptedMySqlPool(() => []).pool as never)
    expect(await none.getById({ id: "x", requester: system })).toBeNull()
  })

  it("lists pending jobs by type with a limit", async () => {
    const { pool, calls } = createScriptedMySqlPool(() => [jobRow(), jobRow({ id: "j2" })])
    const store = new DrizzleMySqlJobStore(pool as never)
    expect((await store.findPending({ requester: system })).map((job) => job.id)).toEqual(["j1", "j2"])
    expect(calls[0]!.params).toEqual(["system", 100])
    await store.findPending({ requester: tenant("t1"), jobType: "mail", limit: 5 })
    expect(calls[1]!.sql).toContain("AND job_type=?")
    expect(calls[1]!.params).toEqual(["tenant", "t1", "mail", 5])
  })

  it("decodes platform scope keys and rejects invalid fingerprints", async () => {
    const platformRow = jobRow({ scope: "platform", scope_key: "ops", tenant_id: null })
    const store = new DrizzleMySqlJobStore(createScriptedMySqlPool(() => [platformRow]).pool as never)
    expect((await store.getById({ id: "j1", requester: platform }))?.executionScope).toEqual({ kind: "platform", platformKey: "ops" })
    const missing = new DrizzleMySqlJobStore(createScriptedMySqlPool(() => [jobRow({ fingerprint: null })]).pool as never)
    await expect(missing.getById({ id: "j1", requester: system })).rejects.toThrow("fingerprint is missing")
  })
})

describe("MySQL job store: configuration", () => {
  it("rejects unknown history modes and honours table overrides", async () => {
    const { pool } = createScriptedMySqlPool(() => [])
    expect(() => new DrizzleMySqlJobStore(pool as never, { executionHistory: "sometimes" as never })).toThrow(ConfigurationError)
    expect(MYSQL_JOB_STORE_TABLES).toEqual({ jobs: "jobs", jobExecutions: "job_executions" })
    const scripted = createScriptedMySqlPool(() => [])
    await new DrizzleMySqlJobStore(scripted.pool as never, { tables: { jobs: "app_jobs" } }).getById({ id: "x", requester: system })
    expect(scripted.calls[0]!.sql).toContain("FROM `app_jobs` ")
  })
})

describe("MySQL job store: claiming", () => {
  it("claims eligible jobs in one transaction and returns the fresh rows", async () => {
    const scripted = createScriptedMySqlPool((call) => {
      if (call.sql.startsWith("SELECT id,attempt,worker_id")) return []
      if (call.sql.startsWith("SELECT j.*")) return [jobRow({ id: "a" }), jobRow({ id: "b" }), jobRow({ id: "c" })]
      if (call.sql.startsWith("UPDATE")) return header(call.params[4] === "c" ? 0 : 1)
      return [jobRow({ id: String(call.params[0]), status: "running", attempt: 1, worker_id: "w" })]
    })
    const store = new DrizzleMySqlJobStore(scripted.pool as never)
    const claimed = await store.claimDue({ workerId: "w", leaseDurationMs: 1_000, limit: 5, requester: system, now: RUN_AT })
    expect(claimed.map((job) => job.id)).toEqual(["a", "b"])
    expect(scripted.events).toEqual(["begin", "commit", "release"])
    expect(scripted.calls.find((c) => c.sql.startsWith("SELECT j.*"))!.params).toEqual(["system", RUN_AT, RUN_AT, 5])
  })

  it("skips a row whose claim lost a unique-index race but fails on other errors", async () => {
    const race = createScriptedMySqlPool((call) => {
      if (call.sql.startsWith("SELECT id,attempt")) return []
      if (call.sql.startsWith("SELECT j.*")) return [jobRow({ id: "a" })]
      throw Object.assign(new Error("dup"), { errno: 1062 })
    })
    expect(await new DrizzleMySqlJobStore(race.pool as never).claimDue({ workerId: "w", leaseDurationMs: 1_000, limit: 5, requester: system })).toEqual([])
    const broken = createScriptedMySqlPool((call) => {
      if (call.sql.startsWith("SELECT id,attempt")) return []
      if (call.sql.startsWith("SELECT j.*")) return [jobRow({ id: "a" })]
      throw Object.assign(new Error("bad"), { errno: 1064 })
    })
    await expect(new DrizzleMySqlJobStore(broken.pool as never).claimDue({ workerId: "w", leaseDurationMs: 1_000, limit: 5, requester: system })).rejects.toThrow("bad")
    expect(broken.events).toEqual(["begin", "rollback", "release"])
  })

  it("retries lock conflicts up to three times and then gives up", async () => {
    let failures = 2
    const flaky = createScriptedMySqlPool((call) => {
      if (call.sql.startsWith("SELECT id,attempt") && failures-- > 0) throw lockError(1205)
      return []
    })
    expect(await new DrizzleMySqlJobStore(flaky.pool as never).claimDue({ workerId: "w", leaseDurationMs: 1_000, limit: 5, requester: system })).toEqual([])
    expect(flaky.events.filter((event) => event === "rollback")).toHaveLength(2)
    const hopeless = createScriptedMySqlPool((call) => { if (call.sql.startsWith("SELECT id,attempt")) throw lockError(1213); return [] })
    await expect(new DrizzleMySqlJobStore(hopeless.pool as never).claimDue({ workerId: "w", leaseDurationMs: 1_000, limit: 5, requester: system })).rejects.toMatchObject({ errno: 1213 })
    expect(hopeless.events.filter((event) => event === "begin")).toHaveLength(4)
  })

  it("rejects overlong worker ids and non-positive limits without touching the pool", async () => {
    const { pool, calls } = createScriptedMySqlPool(() => [])
    const store = new DrizzleMySqlJobStore(pool as never)
    await expect(store.claimDue({ workerId: "w".repeat(101), leaseDurationMs: 1, limit: 1, requester: system })).rejects.toThrow("workerId exceeds")
    expect(await store.claimDue({ workerId: "w", leaseDurationMs: 1, limit: 0, requester: system })).toEqual([])
    expect(calls).toEqual([])
  })

  const exhausted = (call: PoolCall) => {
    if (call.sql.startsWith("SELECT id,attempt,worker_id")) return [{ id: "dead", attempt: 3, worker_id: null }, { id: "dead2", attempt: 3, worker_id: "w9" }]
    if (call.sql.startsWith("SELECT j.*")) return []
    return header(1)
  }

  it("dead-letters final-attempt expiries with a history row on a savepoint in required mode", async () => {
    const scripted = createScriptedMySqlPool(exhausted)
    await new DrizzleMySqlJobStore(scripted.pool as never).claimDue({ workerId: "w", leaseDurationMs: 1_000, limit: 5, requester: system })
    const sqls = scripted.calls.map((call) => call.sql)
    expect(sqls.filter((sql) => sql === "SAVEPOINT framework_dead_letter")).toHaveLength(2)
    expect(sqls.filter((sql) => sql === "RELEASE SAVEPOINT framework_dead_letter")).toHaveLength(2)
    const deadLetter = scripted.calls.find((call) => call.sql.includes("SET status='dead_letter'"))!
    expect(deadLetter.params[0]).toBe(MYSQL_JOB_LEASE_EXHAUSTED_REASON)
    const history = scripted.calls.find((call) => call.sql.startsWith("INSERT INTO `job_executions`"))!
    expect(history.params.slice(1)).toEqual(["dead", 3, "lease-expiry", "dead_letter", MYSQL_JOB_LEASE_EXHAUSTED_REASON])
  })

  it("rolls the savepoint back when the history write fails, but propagates lock conflicts", async () => {
    const failingHistory = createScriptedMySqlPool((call) => { if (call.sql.startsWith("INSERT INTO `job_executions`")) throw new Error("history down"); return exhausted(call) })
    await new DrizzleMySqlJobStore(failingHistory.pool as never).claimDue({ workerId: "w", leaseDurationMs: 1_000, limit: 5, requester: system })
    expect(failingHistory.calls.filter((call) => call.sql === "ROLLBACK TO SAVEPOINT framework_dead_letter")).toHaveLength(2)
    const locked = createScriptedMySqlPool((call) => { if (call.sql.startsWith("INSERT INTO `job_executions`")) throw lockError(1213); return exhausted(call) })
    await expect(new DrizzleMySqlJobStore(locked.pool as never).claimDue({ workerId: "w", leaseDurationMs: 1_000, limit: 5, requester: system })).rejects.toMatchObject({ errno: 1213 })
  })

  it("records dead-letter history after commit in best-effort mode, skipping rows that changed", async () => {
    let first = true
    const scripted = createScriptedMySqlPool((call) => {
      if (call.sql.includes("SET status='dead_letter'")) { const applied = first; first = false; return header(applied ? 1 : 0) }
      return exhausted(call)
    })
    await new DrizzleMySqlJobStore(scripted.pool as never, { executionHistory: "best_effort" }).claimDue({ workerId: "w", leaseDurationMs: 1_000, limit: 5, requester: system })
    const order = scripted.calls.map((call) => (call.sql.startsWith("INSERT INTO `job_executions`") ? "history" : call.sql.includes("dead_letter") ? "dead" : ""))
    expect(order.filter(Boolean)).toEqual(["dead", "dead", "history"])
    expect(scripted.events).toEqual(["begin", "commit", "release"])
  })
})

describe("MySQL job store: transitions", () => {
  const completion = { jobId: "j1", workerId: "w", claimToken: "t", attempt: 1 }

  it("best-effort transitions update first and then report history failures without failing", async () => {
    const ok = createScriptedMySqlPool(() => header(1))
    const store = new DrizzleMySqlJobStore(ok.pool as never, { executionHistory: "best_effort" })
    const result = await store.markSucceeded({ ...completion, result: { ok: true } })
    expect(result).toMatchObject({ applied: true })
    expect(ok.calls[0]!.params[0]).toBe('{"ok":true}')
    expect(ok.calls[1]!.sql).toContain("INSERT INTO `job_executions`")
    const lost = createScriptedMySqlPool(() => header(0))
    expect(await new DrizzleMySqlJobStore(lost.pool as never, { executionHistory: "best_effort" }).markFailed({ ...completion, status: "failed", error: "x" })).toEqual({ applied: false, reason: "LEASE_LOST" })
    const noHistory = createScriptedMySqlPool((call) => { if (call.sql.startsWith("INSERT INTO `job_executions`")) throw Object.assign(new Error("secret table text"), { code: "ER_NO_SUCH_TABLE", errno: 1146 }); return header(1) })
    const degraded = await new DrizzleMySqlJobStore(noHistory.pool as never, { executionHistory: "best_effort" }).markRetrying({ ...completion, error: "e", nextAttemptAt: RUN_AT })
    expect(degraded).toMatchObject({ applied: true, historyError: "Execution history persistence failed (provider code ER_NO_SUCH_TABLE)" })
    expect(JSON.stringify(degraded)).not.toContain("secret")
    const withCode = createScriptedMySqlPool((call) => { if (call.sql.startsWith("INSERT INTO `job_executions`")) throw Object.assign(new Error("x"), { code: "ER_LOCK_DEADLOCK", errno: 1213 }); return header(1) })
    expect(await new DrizzleMySqlJobStore(withCode.pool as never, { executionHistory: "best_effort" }).markSucceeded(completion)).toMatchObject({ applied: true, historyError: "Execution history persistence failed (provider code ER_LOCK_DEADLOCK)" })
    const plainFailure = createScriptedMySqlPool((call) => { if (call.sql.startsWith("INSERT INTO `job_executions`")) throw new Error("no machine code"); return header(1) })
    expect(await new DrizzleMySqlJobStore(plainFailure.pool as never, { executionHistory: "best_effort" }).markSucceeded(completion)).toMatchObject({ applied: true, historyError: "Execution history persistence failed" })
  })

  it("required transitions commit the update and its history row together", async () => {
    const scripted = createScriptedMySqlPool(() => header(1))
    const store = new DrizzleMySqlJobStore(scripted.pool as never)
    expect(await store.markSucceeded(completion)).toMatchObject({ applied: true })
    expect(await store.markRetrying({ ...completion, error: "e", nextAttemptAt: RUN_AT })).toMatchObject({ applied: true })
    expect(await store.markFailed({ ...completion, status: "dead_letter", error: "fatal" })).toMatchObject({ applied: true })
    expect(scripted.events).toEqual(["begin", "commit", "release", "begin", "commit", "release", "begin", "commit", "release"])
    expect(scripted.calls.filter((call) => call.sql.startsWith("INSERT INTO `job_executions`"))).toHaveLength(3)
    expect(scripted.calls.find((call) => call.sql.includes("status='retrying'"))!.sql).toContain("attempt<max_attempts")
  })

  it("required transitions roll back and report LEASE_LOST or a sanitized HISTORY_FAILED", async () => {
    const lost = createScriptedMySqlPool(() => header(0))
    expect(await new DrizzleMySqlJobStore(lost.pool as never).markSucceeded(completion)).toEqual({ applied: false, reason: "LEASE_LOST" })
    expect(lost.events).toEqual(["begin", "rollback", "release"])
    const failing = createScriptedMySqlPool((call) => { if (call.sql.startsWith("INSERT INTO `job_executions`")) throw Object.assign(new Error("secret"), { errno: 1146 }); return header(1) })
    const result = await new DrizzleMySqlJobStore(failing.pool as never).markSucceeded(completion)
    expect(result).toMatchObject({ applied: false, reason: "HISTORY_FAILED" })
    expect(JSON.stringify(result)).not.toContain("secret")
    expect(failing.events).toEqual(["begin", "rollback", "release"])
  })

  it("renews a lease only for positive finite extensions", async () => {
    const scripted = createScriptedMySqlPool(() => header(1))
    const store = new DrizzleMySqlJobStore(scripted.pool as never)
    expect(await store.renewLease({ jobId: "j1", workerId: "w", claimToken: "t", extendByMs: 500 })).toBe(true)
    expect(await store.renewLease({ jobId: "j1", workerId: "w", claimToken: "t", extendByMs: 0 })).toBe(false)
    expect(await store.renewLease({ jobId: "j1", workerId: "w", claimToken: "t", extendByMs: Number.POSITIVE_INFINITY })).toBe(false)
    await expect(store.renewLease({ jobId: "j1", workerId: "x".repeat(101), claimToken: "t", extendByMs: 1 })).rejects.toThrow("workerId exceeds")
    expect(scripted.calls).toHaveLength(1)
    const lost = new DrizzleMySqlJobStore(createScriptedMySqlPool(() => header(0)).pool as never)
    expect(await lost.renewLease({ jobId: "j1", workerId: "w", claimToken: "t", extendByMs: 500 })).toBe(false)
  })

  it("releases a live claim, truncating the reason", async () => {
    const scripted = createScriptedMySqlPool(() => header(1))
    const store = new DrizzleMySqlJobStore(scripted.pool as never)
    expect(await store.release({ jobId: "j1", workerId: "w", claimToken: "t", nextAttemptAt: RUN_AT, reason: "r".repeat(600) })).toEqual({ applied: true })
    expect((scripted.calls[0]!.params[1] as string).length).toBe(512)
    const lost = new DrizzleMySqlJobStore(createScriptedMySqlPool(() => header(0)).pool as never)
    expect(await lost.release({ jobId: "j1", workerId: "w", claimToken: "t", nextAttemptAt: RUN_AT, reason: "x" })).toEqual({ applied: false, reason: "LEASE_LOST" })
  })
})

describe("MySQL job store: cancel", () => {
  it("best-effort cancel updates, reads the attempt and records history", async () => {
    const scripted = createScriptedMySqlPool((call) => (isSelect(call) ? [{ attempt: 2 }] : header(1)))
    const store = new DrizzleMySqlJobStore(scripted.pool as never, { executionHistory: "best_effort" })
    expect(await store.cancel({ jobId: "j1", requester: system, reason: "stop" })).toMatchObject({ applied: true })
    expect(scripted.calls[2]!.params.slice(1, 5)).toEqual(["j1", 2, "cancellation", "cancelled"])
    const noRow = createScriptedMySqlPool((call) => (isSelect(call) ? [] : header(1)))
    await new DrizzleMySqlJobStore(noRow.pool as never, { executionHistory: "best_effort" }).cancel({ jobId: "j1", requester: system })
    expect(noRow.calls[2]!.params[2]).toBe(0)
    const terminal = new DrizzleMySqlJobStore(createScriptedMySqlPool(() => header(0)).pool as never, { executionHistory: "best_effort" })
    expect(await terminal.cancel({ jobId: "j1", requester: system })).toEqual({ applied: false, reason: "INVALID_STATE" })
  })

  it("required cancel locks the row, updates and writes history in one transaction", async () => {
    const scripted = createScriptedMySqlPool((call) => (isSelect(call) ? [{ attempt: 1 }] : header(1)))
    const store = new DrizzleMySqlJobStore(scripted.pool as never)
    expect(await store.cancel({ jobId: "j1", requester: tenant("t1"), reason: "stop" })).toMatchObject({ applied: true })
    expect(scripted.events).toEqual(["begin", "commit", "release"])
    expect(scripted.calls[0]!.sql).toContain("FOR UPDATE")
    const none = createScriptedMySqlPool(() => [])
    expect(await new DrizzleMySqlJobStore(none.pool as never).cancel({ jobId: "j1", requester: system })).toEqual({ applied: false, reason: "INVALID_STATE" })
    expect(none.events).toEqual(["begin", "rollback", "release"])
    const failing = createScriptedMySqlPool((call) => { if (call.sql.startsWith("INSERT INTO `job_executions`")) throw Object.assign(new Error("secret"), { errno: 1146 }); return isSelect(call) ? [{ attempt: 1 }] : header(1) })
    expect(await new DrizzleMySqlJobStore(failing.pool as never).cancel({ jobId: "j1", requester: system })).toMatchObject({ applied: false, reason: "HISTORY_FAILED" })
  })
})
