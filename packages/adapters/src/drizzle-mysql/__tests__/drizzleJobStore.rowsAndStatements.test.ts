import { describe, expect, it } from "vitest"
import { ConfigurationError, PersistenceError } from "@xonava/core/domain"
import { buildJobFingerprintInput, fingerprintJob } from "@xonava/core/execution"
import { DrizzleMySqlJobStore, MYSQL_JOB_LEASE_EXHAUSTED_REASON } from "../drizzleJobStore"
import { createScriptedMySqlPool, type PoolCall } from "../../__tests__/support/scriptedPool"

const RUN_AT = new Date("2026-01-01T00:00:00.000Z")
const LATER = new Date("2026-01-02T00:00:00.000Z")
const system = { scope: "system" } as never
const tenant = (tenantId: string) => ({ scope: "tenant", tenantId, actorId: "u" }) as never
const baseJob = { jobType: "mail", jobVersion: 1, payload: { a: 1 }, executionScope: { kind: "system", systemKey: "framework" }, maxAttempts: 3, runAt: RUN_AT } as never
const header = (affectedRows: number) => ({ affectedRows })
const isSelect = (call: PoolCall) => /^\s*SELECT/i.test(call.sql)
const lockError = (errno: number) => Object.assign(new Error("lock text"), { errno })
const jobRow = (overrides: Record<string, unknown> = {}) => ({
  id: "j1", job_type: "mail", job_version: 1, tenant_id: null, scope: "system", scope_key: null, payload: '{"a":1}', status: "pending", priority: 0, attempt: 0, max_attempts: 3,
  run_at: RUN_AT, next_attempt_at: RUN_AT, worker_id: null, lease_expires_at: null, claim_token: null, idempotency_key: null, fingerprint: "v1:abc", correlation_id: null,
  last_error: null, result_payload: null, metadata: null, partition_key: null, created_at: RUN_AT, started_at: null, completed_at: null, ...overrides,
})
const HISTORY_INSERT = "INSERT INTO `job_executions`(id,job_id,attempt,worker_id,status,error_message,started_at,finished_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))"
const transitionSql = (set: string, guard = "") => `UPDATE \`jobs\` SET ${set} WHERE id=? AND worker_id=? AND claim_token=? AND attempt=? AND status='running' AND lease_expires_at>CURRENT_TIMESTAMP(3)${guard}`
const ENQUEUE_INSERT = "INSERT INTO `jobs`(id,job_type,job_version,tenant_id,scope,scope_key,payload,status,priority,attempt,max_attempts,run_at,next_attempt_at,idempotency_key,idempotency_scope,fingerprint,correlation_id,metadata,partition_key) VALUES(?,?,?,?,?,?,?,'pending',?,0,?,?,?,?,?,?,?,?,?)"
const CLAIM_SELECT = "SELECT j.* FROM `jobs` j WHERE scope=? AND tenant_id IS NULL AND ((status IN ('pending','retrying') AND attempt<max_attempts AND COALESCE(next_attempt_at,run_at)<=?) OR (status='running' AND attempt<max_attempts AND lease_expires_at<CURRENT_TIMESTAMP(3))) AND (partition_key IS NULL OR (NOT EXISTS(SELECT 1 FROM `jobs` sibling WHERE sibling.partition_key=j.partition_key AND sibling.scope=j.scope AND sibling.tenant_id<=>j.tenant_id AND sibling.scope_key<=>j.scope_key AND sibling.status='running' AND sibling.lease_expires_at>CURRENT_TIMESTAMP(3) AND sibling.id<>j.id) AND NOT EXISTS(SELECT 1 FROM `jobs` ahead WHERE ahead.partition_key=j.partition_key AND ahead.scope=j.scope AND ahead.tenant_id<=>j.tenant_id AND ahead.scope_key<=>j.scope_key AND ahead.id<>j.id AND ((ahead.status IN ('pending','retrying') AND ahead.attempt<ahead.max_attempts AND COALESCE(ahead.next_attempt_at,ahead.run_at)<=?) OR (ahead.status='running' AND ahead.attempt<ahead.max_attempts AND ahead.lease_expires_at<CURRENT_TIMESTAMP(3))) AND ((ahead.status='running')>(j.status='running') OR ((ahead.status='running')=(j.status='running') AND (ahead.priority,ahead.run_at,ahead.id)<(j.priority,j.run_at,j.id)))))) ORDER BY priority,run_at,id LIMIT ? FOR UPDATE SKIP LOCKED"
const CLAIM_UPDATE = "UPDATE `jobs` SET status='running',worker_id=?,claim_token=?,lease_expires_at=TIMESTAMPADD(MICROSECOND,?*1000,CURRENT_TIMESTAMP(3)),attempt=attempt+1,started_at=?,next_attempt_at=NULL WHERE id=? AND (status<>'running' OR lease_expires_at<CURRENT_TIMESTAMP(3))"
const SWEEP_SELECT = "SELECT id,attempt,worker_id FROM `jobs` WHERE scope=? AND tenant_id IS NULL AND status='running' AND attempt>=max_attempts AND lease_expires_at<CURRENT_TIMESTAMP(3) LIMIT ? FOR UPDATE SKIP LOCKED"
const DEAD_LETTER_UPDATE = "UPDATE `jobs` SET status='dead_letter',last_error=?,completed_at=CURRENT_TIMESTAMP(3),worker_id=NULL,claim_token=NULL,lease_expires_at=NULL WHERE id=? AND status='running' AND attempt>=max_attempts AND lease_expires_at<CURRENT_TIMESTAMP(3)"
const RENEW_UPDATE = "UPDATE `jobs` SET lease_expires_at=GREATEST(lease_expires_at,TIMESTAMPADD(MICROSECOND,?*1000,CURRENT_TIMESTAMP(3))) WHERE id=? AND worker_id=? AND claim_token=? AND status='running' AND lease_expires_at>CURRENT_TIMESTAMP(3)"
const RELEASE_UPDATE = "UPDATE `jobs` SET status='retrying',attempt=GREATEST(attempt-1,0),next_attempt_at=?,last_error=?,worker_id=NULL,claim_token=NULL,lease_expires_at=NULL WHERE id=? AND worker_id=? AND claim_token=? AND status='running' AND lease_expires_at>CURRENT_TIMESTAMP(3)"
const CANCEL_UPDATE = "UPDATE `jobs` SET status='cancelled',completed_at=CURRENT_TIMESTAMP(3),last_error=?,worker_id=NULL,claim_token=NULL,lease_expires_at=NULL WHERE id=? AND scope=? AND tenant_id IS NULL AND status NOT IN ('succeeded','failed','cancelled','dead_letter')"
const CANCEL_SELECT_LOCK = "SELECT attempt FROM `jobs` WHERE id=? AND scope=? AND tenant_id IS NULL AND status NOT IN ('succeeded','failed','cancelled','dead_letter') FOR UPDATE"
const PENDING_SELECT = (filter: string) => "SELECT * FROM `jobs` WHERE status IN ('pending','retrying') AND scope=? AND tenant_id IS NULL" + filter + " ORDER BY priority,created_at LIMIT ?"

describe("MySQL job store: row decoding", () => {
  const read = async (row: Record<string, unknown>) => new DrizzleMySqlJobStore(createScriptedMySqlPool(() => [row]).pool as never).getById({ id: "j1", requester: row.tenant_id ? tenant(String(row.tenant_id)) : system })

  it("decodes a fully populated row", async () => {
    const stamp = (n: number) => new Date(RUN_AT.getTime() + n * 1000)
    const job = await read(jobRow({
      tenant_id: "t1", scope: "tenant", status: "running", priority: 7, attempt: 3, max_attempts: 5, next_attempt_at: stamp(1), worker_id: "w1", lease_expires_at: stamp(2), claim_token: "tok", idempotency_key: "ik",
      correlation_id: "corr", last_error: "boom", result_payload: { r: 1 }, metadata: { m: 1 }, partition_key: "pk", started_at: stamp(3), completed_at: stamp(4), job_version: "2", payload: { a: 2 },
    }))
    expect(job).toEqual({
      id: "j1", jobType: "mail", jobVersion: 2, tenantId: "t1", scope: "tenant", executionScope: { kind: "tenant", tenantId: "t1" }, payload: '{"a":2}', status: "running", priority: 7, currentAttempt: 3, attemptsCompleted: 2, maxAttempts: 5,
      runAt: RUN_AT, nextAttemptAt: stamp(1), leaseOwner: "w1", leaseExpiresAt: stamp(2), claimToken: "tok", idempotencyKey: "ik", fingerprint: "v1:abc", correlationId: "corr", lastError: "boom", resultPayload: '{"r":1}',
      metadata: { m: 1 }, partitionKey: "pk", createdAt: RUN_AT, startedAt: stamp(3), completedAt: stamp(4),
    })
  })

  it("decodes string payload, result and metadata as stored text or JSON", async () => {
    const job = await read(jobRow({ result_payload: '{"r":2}', metadata: '{"m":2}' }))
    expect(job).toMatchObject({ payload: '{"a":1}', resultPayload: '{"r":2}', metadata: { m: 2 } })
    const objects = await read(jobRow({ metadata: { m: 3 } }))
    expect(objects?.metadata).toEqual({ m: 3 })
  })

  it("decodes a sparse row with nulls and undefined as null", async () => {
    for (const missing of [null, undefined]) {
      const job = await read(jobRow({
        tenant_id: missing, next_attempt_at: missing, worker_id: missing, lease_expires_at: missing, claim_token: missing, idempotency_key: missing, correlation_id: missing, last_error: missing,
        result_payload: missing, metadata: missing, partition_key: missing, started_at: missing, completed_at: missing, attempt: 0, max_attempts: missing,
      }))
      expect(job).toMatchObject({
        tenantId: null, nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null, claimToken: null, idempotencyKey: null, correlationId: null, lastError: null, resultPayload: null, metadata: null,
        partitionKey: null, startedAt: null, completedAt: null, currentAttempt: 0, attemptsCompleted: 0,
      })
      expect(job?.maxAttempts).toBeUndefined()
    }
  })

  it("counts completed attempts as attempt minus one, never below zero", async () => {
    expect((await read(jobRow({ attempt: 1 })))?.attemptsCompleted).toBe(0)
    expect((await read(jobRow({ attempt: 4 })))?.attemptsCompleted).toBe(3)
  })

  it("keeps an empty worker id, claim token and string zero values", async () => {
    const job = await read(jobRow({ worker_id: "", claim_token: "", last_error: "", partition_key: "", correlation_id: "", idempotency_key: "" }))
    expect(job).toMatchObject({ leaseOwner: "", claimToken: "", lastError: "", partitionKey: "", correlationId: "", idempotencyKey: "" })
  })
})

describe("MySQL job store: configuration and history failures", () => {
  it("names the accepted history modes", () => {
    const { pool } = createScriptedMySqlPool(() => [])
    expect(() => new DrizzleMySqlJobStore(pool as never, { executionHistory: "sometimes" as never })).toThrow(new ConfigurationError("executionHistory must be 'best_effort' or 'required'"))
    expect(() => new DrizzleMySqlJobStore(pool as never, { executionHistory: "required" })).not.toThrow()
    expect(() => new DrizzleMySqlJobStore(pool as never, { executionHistory: "best_effort" })).not.toThrow()
  })

  const failingHistory = (error: unknown) => createScriptedMySqlPool((call) => { if (call.sql === HISTORY_INSERT) throw error; return header(1) })
  const completion = { jobId: "j1", workerId: "w", claimToken: "t", attempt: 1 }

  it("reports only well-formed provider codes", async () => {
    const report = async (error: unknown) => {
      const result = await new DrizzleMySqlJobStore(failingHistory(error).pool as never, { executionHistory: "best_effort" }).markSucceeded(completion)
      return (result as { historyError?: string }).historyError
    }
    expect(await report(Object.assign(new Error("x"), { code: "ER_LOCK_DEADLOCK" }))).toBe("Execution history persistence failed (provider code ER_LOCK_DEADLOCK)")
    expect(await report(Object.assign(new Error("x"), { code: "A".repeat(64) }))).toBe(`Execution history persistence failed (provider code ${"A".repeat(64)})`)
    expect(await report(Object.assign(new Error("x"), { code: "A".repeat(65) }))).toBe("Execution history persistence failed")
    expect(await report(Object.assign(new Error("x"), { code: "!ER_X" }))).toBe("Execution history persistence failed")
    expect(await report(Object.assign(new Error("x"), { code: "ER_X!" }))).toBe("Execution history persistence failed")
    expect(await report(Object.assign(new Error("x"), { code: "bad code" }))).toBe("Execution history persistence failed")
    expect(await report(new Error("no code"))).toBe("Execution history persistence failed")
    expect(await report(new PersistenceError("framework error without details"))).toBe("Execution history persistence failed")
  })
})

describe("MySQL job store: exact statements", () => {
  it("enqueues with the exact insert and reads the row back by id", async () => {
    const scripted = createScriptedMySqlPool((call) => (isSelect(call) ? [jobRow()] : header(1)))
    const plain = new DrizzleMySqlJobStore(scripted.pool as never)
    const job = { ...(baseJob as object), idempotencyKey: "ik", correlationId: "corr", metadata: { m: 1 }, partitionKey: "pk", priority: 4, executionScope: { kind: "tenant", tenantId: "t1" } } as never
    await plain.enqueue({ job, requester: tenant("t1") })
    const fingerprint = await fingerprintJob(buildJobFingerprintInput(job, RUN_AT))
    expect(scripted.calls[0]!.sql).toBe(ENQUEUE_INSERT)
    expect(scripted.calls[0]!.params).toEqual([expect.any(String), "mail", 1, "t1", "tenant", null, '{"a":1}', 4, 3, RUN_AT, RUN_AT, "ik", "tenant:t1", fingerprint, "corr", '{"m":1}', "pk"])
    expect(scripted.calls[1]!.sql).toBe("SELECT * FROM `jobs` WHERE id=?")
    expect(scripted.calls[1]!.params).toEqual([scripted.calls[0]!.params[0]])
  })

  it("defaults priority, optional columns and the idempotency scope for system jobs", async () => {
    const scripted = createScriptedMySqlPool((call) => (isSelect(call) ? [jobRow()] : header(1)))
    await new DrizzleMySqlJobStore(scripted.pool as never).enqueue({ job: baseJob, requester: system })
    expect(scripted.calls[0]!.params.slice(3)).toEqual([null, "system", null, '{"a":1}', 0, 3, RUN_AT, RUN_AT, null, "system", expect.any(String), null, null, null])
  })

  it("on a duplicate key looks the existing job up by idempotency scope and key", async () => {
    const duplicate = Object.assign(new Error("dup"), { errno: 1062 })
    const job = { ...(baseJob as object), idempotencyKey: "ik" } as never
    const fingerprint = await fingerprintJob(buildJobFingerprintInput(job, RUN_AT))
    const scripted = createScriptedMySqlPool((call) => { if (call.sql.startsWith("INSERT")) throw duplicate; return [jobRow({ id: "existing", fingerprint })] })
    expect((await new DrizzleMySqlJobStore(scripted.pool as never).enqueue({ job, requester: system }))?.id).toBe("existing")
    expect(scripted.calls[1]).toMatchObject({ sql: "SELECT * FROM `jobs` WHERE idempotency_scope=? AND idempotency_key=?", params: ["system", "ik"] })
    const tenantScripted = createScriptedMySqlPool((call) => { if (call.sql.startsWith("INSERT")) throw duplicate; return [jobRow({ id: "existing", fingerprint: "v1:other" })] })
    const tenantJob = { ...(job as object), executionScope: { kind: "tenant", tenantId: "t9" } } as never
    await expect(new DrizzleMySqlJobStore(tenantScripted.pool as never).enqueue({ job: tenantJob, requester: tenant("t9") })).rejects.toThrow()
    expect(tenantScripted.calls[1]!.params).toEqual(["tenant:t9", "ik"])
  })

  it("rethrows a duplicate error that is not a unique-key violation or has no idempotency key", async () => {
    const other = Object.assign(new Error("other"), { errno: 1063 })
    const keyed = createScriptedMySqlPool(() => { throw other })
    await expect(new DrizzleMySqlJobStore(keyed.pool as never).enqueue({ job: { ...(baseJob as object), idempotencyKey: "k" } as never, requester: system })).rejects.toBe(other)
    expect(keyed.calls).toHaveLength(1)
    const duplicate = Object.assign(new Error("dup"), { errno: 1062 })
    const unkeyed = createScriptedMySqlPool(() => { throw duplicate })
    await expect(new DrizzleMySqlJobStore(unkeyed.pool as never).enqueue({ job: baseJob, requester: system })).rejects.toBe(duplicate)
    expect(unkeyed.calls).toHaveLength(1)
  })

  it("scopes every lookup with exact SQL and parameters", async () => {
    const scripted = createScriptedMySqlPool(() => [jobRow()])
    const store = new DrizzleMySqlJobStore(scripted.pool as never)
    await store.getById({ id: "j1", requester: system })
    await store.getByCorrelationId({ correlationId: "c", requester: tenant("t1") })
    await store.getLatestPriorScheduleExecution({ scheduleId: "s1", beforeOccurrence: LATER, requester: system } as never)
    await store.getByIdempotencyKey({ key: "k", requester: tenant("t1") })
    await store.getByIdempotencyKey({ key: "k", requester: system })
    expect(scripted.calls.map((call) => [call.sql, call.params])).toEqual([
      ["SELECT * FROM `jobs` WHERE id=? AND scope=? AND tenant_id IS NULL", ["j1", "system"]],
      ["SELECT * FROM `jobs` WHERE correlation_id=? AND scope=? AND tenant_id=? ORDER BY created_at DESC LIMIT 5", ["c", "tenant", "t1"]],
      ["SELECT * FROM `jobs` WHERE correlation_id=? AND run_at<? AND scope=? AND tenant_id IS NULL ORDER BY run_at DESC LIMIT 1", [expect.stringContaining("s1"), LATER, "system"]],
      ["SELECT * FROM `jobs` WHERE idempotency_scope=? AND idempotency_key=? AND scope=? AND tenant_id=?", ["tenant:t1", "k", "tenant", "t1"]],
      ["SELECT * FROM `jobs` WHERE idempotency_scope=? AND idempotency_key=? AND scope=? AND tenant_id IS NULL", ["system", "k", "system"]],
    ])
  })

  it("lists pending jobs with exact SQL", async () => {
    const scripted = createScriptedMySqlPool(() => [jobRow()])
    const store = new DrizzleMySqlJobStore(scripted.pool as never)
    await store.findPending({ requester: system })
    await store.findPending({ requester: system, limit: 0 })
    await store.findPending({ requester: tenant("t1"), jobType: "mail", limit: 5 })
    await store.findPending({ requester: system, jobType: "" })
    expect(scripted.calls.map((call) => [call.sql, call.params])).toEqual([
      [PENDING_SELECT(""), ["system", 100]],
      [PENDING_SELECT(""), ["system", 0]],
      [PENDING_SELECT(" AND job_type=?").replace("tenant_id IS NULL", "tenant_id=?"), ["tenant", "t1", "mail", 5]],
      [PENDING_SELECT(""), ["system", 100]],
    ])
  })

  it("claims with the exact partition-aware queries", async () => {
    const scripted = createScriptedMySqlPool((call) => {
      if (call.sql.startsWith("SELECT id,attempt,worker_id")) return []
      if (call.sql.startsWith("SELECT j.*")) return [jobRow({ id: "a" })]
      if (call.sql.startsWith("UPDATE")) return header(1)
      return [jobRow({ id: "a", status: "running" })]
    })
    await new DrizzleMySqlJobStore(scripted.pool as never).claimDue({ workerId: "w", leaseDurationMs: 1_500, limit: 5, requester: system, now: LATER })
    expect(scripted.calls.map((call) => [call.sql, call.params])).toEqual([
      [SWEEP_SELECT, ["system", 100]],
      [CLAIM_SELECT, ["system", LATER, LATER, 5]],
      [CLAIM_UPDATE, ["w", expect.any(String), 1_500, LATER, "a"]],
      ["SELECT * FROM `jobs` WHERE id=?", ["a"]],
    ])
    expect(scripted.events).toEqual(["begin", "commit", "release"])
  })

  it("sweeps expired final attempts: only rows the update changed get history, with the right worker", async () => {
    const respond = (changed: (id: unknown) => number) => (call: PoolCall) => {
      if (call.sql.startsWith("SELECT id,attempt,worker_id")) return [{ id: "dead", attempt: 3, worker_id: null }, { id: "dead2", attempt: 4, worker_id: "w9" }]
      if (call.sql.startsWith("SELECT j.*")) return []
      if (call.sql === DEAD_LETTER_UPDATE) return header(changed(call.params[1]))
      return header(1)
    }
    const required = createScriptedMySqlPool(respond((id) => (id === "dead" ? 0 : 1)))
    await new DrizzleMySqlJobStore(required.pool as never).claimDue({ workerId: "w", leaseDurationMs: 1_000, limit: 5, requester: system })
    const requiredHistory = required.calls.filter((call) => call.sql === HISTORY_INSERT)
    expect(requiredHistory.map((call) => call.params.slice(1))).toEqual([["dead2", 4, "w9", "dead_letter", MYSQL_JOB_LEASE_EXHAUSTED_REASON]])
    expect(required.calls.filter((call) => call.sql === "RELEASE SAVEPOINT framework_dead_letter")).toHaveLength(2)
    expect(required.calls.filter((call) => call.sql === DEAD_LETTER_UPDATE).map((call) => call.params)).toEqual([[MYSQL_JOB_LEASE_EXHAUSTED_REASON, "dead"], [MYSQL_JOB_LEASE_EXHAUSTED_REASON, "dead2"]])
    const bestEffort = createScriptedMySqlPool(respond((id) => (id === "dead" ? 0 : 1)))
    await new DrizzleMySqlJobStore(bestEffort.pool as never, { executionHistory: "best_effort" }).claimDue({ workerId: "w", leaseDurationMs: 1_000, limit: 5, requester: system })
    expect(bestEffort.calls.filter((call) => call.sql === HISTORY_INSERT).map((call) => call.params.slice(1))).toEqual([["dead2", 4, "w9", "dead_letter", MYSQL_JOB_LEASE_EXHAUSTED_REASON]])
    const nullWorker = createScriptedMySqlPool(respond(() => 1))
    await new DrizzleMySqlJobStore(nullWorker.pool as never, { executionHistory: "best_effort" }).claimDue({ workerId: "w", leaseDurationMs: 1_000, limit: 5, requester: system })
    expect(nullWorker.calls.filter((call) => call.sql === HISTORY_INSERT).map((call) => call.params[3])).toEqual(["lease-expiry", "w9"])
  })

  it.each([1205, 1213])("propagates lock conflict %i from the dead-letter savepoint but swallows other failures", async (errno) => {
    const respond = (error: unknown) => (call: PoolCall) => {
      if (call.sql.startsWith("SELECT id,attempt,worker_id")) return [{ id: "dead", attempt: 3, worker_id: "w" }]
      if (call.sql.startsWith("SELECT j.*")) return []
      if (call.sql === HISTORY_INSERT) throw error
      return header(1)
    }
    await expect(new DrizzleMySqlJobStore(createScriptedMySqlPool(respond(lockError(errno))).pool as never).claimDue({ workerId: "w", leaseDurationMs: 1, limit: 1, requester: system })).rejects.toMatchObject({ errno })
    const other = createScriptedMySqlPool(respond(lockError(1064)))
    await expect(new DrizzleMySqlJobStore(other.pool as never).claimDue({ workerId: "w", leaseDurationMs: 1, limit: 1, requester: system })).resolves.toEqual([])
    expect(other.calls.some((call) => call.sql === "ROLLBACK TO SAVEPOINT framework_dead_letter")).toBe(true)
    const noCode = createScriptedMySqlPool(respond(new Error("plain")))
    await expect(new DrizzleMySqlJobStore(noCode.pool as never).claimDue({ workerId: "w", leaseDurationMs: 1, limit: 1, requester: system })).resolves.toEqual([])
  })

  it("renews and releases with exact statements", async () => {
    const scripted = createScriptedMySqlPool(() => header(1))
    const store = new DrizzleMySqlJobStore(scripted.pool as never)
    await store.renewLease({ jobId: "j1", workerId: "w", claimToken: "t", extendByMs: 500 })
    await store.release({ jobId: "j1", workerId: "w", claimToken: "t", nextAttemptAt: LATER, reason: "why" })
    expect(scripted.calls.map((call) => [call.sql, call.params])).toEqual([
      [RENEW_UPDATE, [500, "j1", "w", "t"]],
      [RELEASE_UPDATE, [LATER, "why", "j1", "w", "t"]],
    ])
  })

  it("transitions with exact update and history statements in required mode", async () => {
    const scripted = createScriptedMySqlPool(() => header(1))
    const store = new DrizzleMySqlJobStore(scripted.pool as never)
    const fence = { jobId: "j1", workerId: "w", claimToken: "t", attempt: 2 }
    const succeeded = await store.markSucceeded({ ...fence, result: { ok: true } } as never)
    await store.markSucceeded(fence as never)
    await store.markRetrying({ ...fence, error: "again", nextAttemptAt: LATER } as never)
    await store.markFailed({ ...fence, status: "dead_letter", error: "fatal" } as never)
    const sql = scripted.calls.map((call) => call.sql)
    const SUCCEEDED = "status='succeeded',result_payload=?,completed_at=CURRENT_TIMESTAMP(3),worker_id=NULL,claim_token=NULL,lease_expires_at=NULL"
    const RETRYING = "status='retrying',next_attempt_at=?,last_error=?,worker_id=NULL,claim_token=NULL,lease_expires_at=NULL"
    const FAILED = "status=?,last_error=?,completed_at=CURRENT_TIMESTAMP(3),worker_id=NULL,claim_token=NULL,lease_expires_at=NULL"
    expect(sql).toEqual([
      transitionSql(SUCCEEDED), HISTORY_INSERT,
      transitionSql(SUCCEEDED), HISTORY_INSERT,
      transitionSql(RETRYING, " AND attempt<max_attempts"), HISTORY_INSERT,
      transitionSql(FAILED), HISTORY_INSERT,
    ])
    expect(scripted.calls[0]!.params).toEqual(['{"ok":true}', "j1", "w", "t", 2])
    expect(scripted.calls[2]!.params).toEqual([null, "j1", "w", "t", 2])
    expect(scripted.calls[4]!.params).toEqual([LATER, "again", "j1", "w", "t", 2])
    expect(scripted.calls[6]!.params).toEqual(["dead_letter", "fatal", "j1", "w", "t", 2])
    const token = (succeeded as { transitionToken: string }).transitionToken
    expect(scripted.calls[1]!.params).toEqual([token, "j1", 2, "w", "succeeded", null])
    expect(scripted.calls[5]!.params.slice(2)).toEqual([2, "w", "retrying", "again"])
    expect(scripted.calls[7]!.params.slice(2)).toEqual([2, "w", "dead_letter", "fatal"])
  })

  it("transitions in best-effort mode with the same update statements", async () => {
    const scripted = createScriptedMySqlPool(() => header(1))
    const store = new DrizzleMySqlJobStore(scripted.pool as never, { executionHistory: "best_effort" })
    const fence = { jobId: "j1", workerId: "w", claimToken: "t", attempt: 2 }
    await store.markRetrying({ ...fence, error: "again", nextAttemptAt: LATER } as never)
    await store.markSucceeded(fence as never)
    expect(scripted.calls.map((call) => call.sql)).toEqual([
      transitionSql("status='retrying',next_attempt_at=?,last_error=?,worker_id=NULL,claim_token=NULL,lease_expires_at=NULL", " AND attempt<max_attempts"), HISTORY_INSERT,
      transitionSql("status='succeeded',result_payload=?,completed_at=CURRENT_TIMESTAMP(3),worker_id=NULL,claim_token=NULL,lease_expires_at=NULL"), HISTORY_INSERT,
    ])
    expect(scripted.calls[1]!.params.slice(1)).toEqual(["j1", 2, "w", "retrying", "again"])
    expect(scripted.calls[3]!.params.slice(1)).toEqual(["j1", 2, "w", "succeeded", null])
    expect(scripted.events).toEqual([])
  })

  it("cancels with exact statements in both history modes", async () => {
    const required = createScriptedMySqlPool((call) => (isSelect(call) ? [{ attempt: 2 }] : header(1)))
    const result = await new DrizzleMySqlJobStore(required.pool as never).cancel({ jobId: "j1", requester: system, reason: "stop" })
    expect(required.calls.map((call) => [call.sql, call.params])).toEqual([
      [CANCEL_SELECT_LOCK, ["j1", "system"]],
      [CANCEL_UPDATE, ["stop", "j1", "system"]],
      [HISTORY_INSERT, [(result as { transitionToken: string }).transitionToken, "j1", 2, "cancellation", "cancelled", "stop"]],
    ])
    const noReason = createScriptedMySqlPool((call) => (isSelect(call) ? [{ attempt: 1 }] : header(1)))
    await new DrizzleMySqlJobStore(noReason.pool as never).cancel({ jobId: "j1", requester: system })
    expect(noReason.calls[1]!.params).toEqual([null, "j1", "system"])
    expect(noReason.calls[2]!.params.slice(2)).toEqual([1, "cancellation", "cancelled", null])
    const best = createScriptedMySqlPool((call) => (isSelect(call) ? [{ attempt: 3 }] : header(1)))
    const bestResult = await new DrizzleMySqlJobStore(best.pool as never, { executionHistory: "best_effort" }).cancel({ jobId: "j1", requester: tenant("t1"), reason: "stop" })
    expect(best.calls.map((call) => [call.sql, call.params])).toEqual([
      [CANCEL_UPDATE.replace("tenant_id IS NULL", "tenant_id=?"), ["stop", "j1", "tenant", "t1"]],
      ["SELECT attempt FROM `jobs` WHERE id=?", ["j1"]],
      [HISTORY_INSERT, [(bestResult as { transitionToken: string }).transitionToken, "j1", 3, "cancellation", "cancelled", "stop"]],
    ])
    const bestNoReason = createScriptedMySqlPool((call) => (isSelect(call) ? [{ attempt: 3 }] : header(1)))
    await new DrizzleMySqlJobStore(bestNoReason.pool as never, { executionHistory: "best_effort" }).cancel({ jobId: "j1", requester: system })
    expect(bestNoReason.calls[0]!.params).toEqual([null, "j1", "system"])
    expect(bestNoReason.calls[2]!.params.slice(5)).toEqual([null])
  })
})
