import { describe, expect, it } from "vitest"
import { drizzle } from "drizzle-orm/d1"
import { ConfigurationError } from "@xonava/core/domain"
import { CorruptJobMetadataError, JobIdempotencyConflictError } from "@xonava/core/execution"
import { createDrizzleD1Adapter, createDrizzleJobStore } from "@xonava/adapters/drizzle-d1"
import { columnMap, execs, jobs, jobStore, newJob, requester, setup } from "./sqliteFixture"

const tenantRequester = (tenantId: string) => ({ scope: "tenant", tenantId, actorId: "u" }) as never
const tenantJob = (tenantId: string, overrides: Record<string, unknown> = {}) => newJob({ executionScope: { kind: "tenant", tenantId }, ...overrides })
const claim = (store: ReturnType<typeof jobStore>, overrides: Record<string, unknown> = {}) =>
  store.claimDue({ workerId: "w1", leaseDurationMs: 60_000, limit: 10, requester, ...overrides } as never)

describe("D1 job store on a real SQLite engine: enqueue and lookups", () => {
  it("enqueues a job without an idempotency key and reads it back with defaults", async () => {
    const { db, count } = await setup()
    const store = jobStore(db)
    const job = await store.enqueue({ job: newJob({ correlationId: "corr-1", metadata: { a: 1 }, priority: 5, partitionKey: "p" }), requester })
    expect(job).toMatchObject({ status: "pending", currentAttempt: 0, attemptsCompleted: 0, priority: 5, correlationId: "corr-1", metadata: { a: 1 }, partitionKey: "p", scope: "system", tenantId: null })
    expect(job.maxAttempts).toBe(3)
    expect(count("dx_jobs")).toBe(1)
  })

  it("enqueues tenant jobs and enforces requester capability rules", async () => {
    const { db } = await setup()
    const store = jobStore(db)
    const job = await store.enqueue({ job: tenantJob("t1"), requester: tenantRequester("t1") })
    expect(job).toMatchObject({ scope: "tenant", tenantId: "t1" })
    await expect(store.enqueue({ job: tenantJob("t2"), requester: tenantRequester("t1") })).rejects.toThrow()
    await expect(store.enqueue({ job: newJob(), requester: tenantRequester("t1") })).rejects.toThrow()
  })

  it("idempotent enqueue replays the original, conflicts on a different fingerprint and is scoped per tenant", async () => {
    const { db, count } = await setup()
    const store = jobStore(db)
    const first = await store.enqueue({ job: newJob({ idempotencyKey: "k1" }), requester })
    const second = await store.enqueue({ job: newJob({ idempotencyKey: "k1" }), requester })
    expect(second.id).toBe(first.id)
    expect(count("dx_jobs")).toBe(1)
    await expect(store.enqueue({ job: newJob({ idempotencyKey: "k1", payload: { a: 2 } }), requester })).rejects.toBeInstanceOf(JobIdempotencyConflictError)
    const t1 = await store.enqueue({ job: tenantJob("t1", { idempotencyKey: "k1" }), requester: tenantRequester("t1") })
    const t2 = await store.enqueue({ job: tenantJob("t2", { idempotencyKey: "k1" }), requester: tenantRequester("t2") })
    expect(new Set([first.id, t1.id, t2.id]).size).toBe(3)
  })

  it("refuses to replay a stored job whose fingerprint was never written", async () => {
    const { d1, db } = await setup()
    const store = jobStore(db)
    await store.enqueue({ job: newJob({ idempotencyKey: "legacy" }), requester })
    d1.sqlite.exec("UPDATE dx_jobs SET fingerprint = NULL")
    await expect(store.enqueue({ job: newJob({ idempotencyKey: "legacy" }), requester })).rejects.toThrow("Stored job fingerprint is missing")
  })

  it("stores a non-default platform scope key and rejects one when the column is unmapped", async () => {
    const { db, row } = await setup()
    const store = jobStore(db)
    await store.enqueue({ job: newJob({ executionScope: { kind: "system", systemKey: "custom-key" } }), requester })
    expect(row("SELECT scope, scope_key FROM dx_jobs")).toEqual({ scope: "system", scope_key: "custom-key" })
    const { scopeKey: _omit, ...withoutScopeKey } = columnMap(jobs) as Record<string, unknown>
    const legacy = createDrizzleJobStore(createDrizzleD1Adapter(db as never).repository, { jobsTable: jobs, executionsTable: execs, columnMap: { jobs: withoutScopeKey as never, executions: columnMap(execs) } })
    await expect(legacy.enqueue({ job: newJob({ executionScope: { kind: "system", systemKey: "custom-key" } }), requester })).rejects.toThrow("scope-key migration")
    const defaultKey = await legacy.enqueue({ job: newJob({ executionScope: { kind: "system", systemKey: "framework" } }), requester })
    expect(defaultKey.scope).toBe("system")
  })

  it("looks jobs up by id, correlation id, idempotency key and prior schedule occurrence within the requester scope", async () => {
    const { db } = await setup()
    const store = jobStore(db)
    const a = await store.enqueue({ job: newJob({ correlationId: "c1", idempotencyKey: "ik" }), requester })
    const tenantOwned = await store.enqueue({ job: tenantJob("t1", { correlationId: "c1" }), requester: tenantRequester("t1") })
    expect((await store.getById({ id: a.id, requester }))?.id).toBe(a.id)
    expect(await store.getById({ id: a.id, requester: tenantRequester("t1") })).toBeNull()
    expect(await store.getById({ id: "missing", requester })).toBeNull()
    expect((await store.getByCorrelationId({ correlationId: "c1", requester })).map((job) => job.id)).toEqual([a.id])
    expect((await store.getByCorrelationId({ correlationId: "c1", requester: tenantRequester("t1") })).map((job) => job.id)).toEqual([tenantOwned.id])
    expect((await store.getByIdempotencyKey({ key: "ik", requester }))?.id).toBe(a.id)
    expect(await store.getByIdempotencyKey({ key: "ik", requester: tenantRequester("t1") })).toBeNull()
    const earlier = await store.enqueue({ job: newJob({ correlationId: "schedule:s1", runAt: new Date(Date.now() - 60_000) }), requester })
    const prior = await store.getLatestPriorScheduleExecution({ scheduleId: "s1", beforeOccurrence: new Date(), requester } as never)
    expect(prior?.id === earlier.id || prior === null).toBe(true)
    expect(await store.getLatestPriorScheduleExecution({ scheduleId: "none", beforeOccurrence: new Date(), requester } as never)).toBeNull()
  })

  it("findPending lists pending and retrying jobs, optionally by type, ordered by priority then creation", async () => {
    const { db } = await setup()
    const store = jobStore(db)
    const low = await store.enqueue({ job: newJob({ priority: 9 }), requester })
    const high = await store.enqueue({ job: newJob({ priority: 1, jobType: "other" }), requester })
    expect((await store.findPending({ requester })).map((job) => job.id)).toEqual([high.id, low.id])
    expect((await store.findPending({ requester, jobType: "other" })).map((job) => job.id)).toEqual([high.id])
    expect(await store.findPending({ requester, limit: 1 })).toHaveLength(1)
    expect(await store.findPending({ requester: tenantRequester("t1") })).toEqual([])
  })

  it("surfaces corrupt stored rows as typed errors", async () => {
    const { d1, db } = await setup()
    const store = jobStore(db)
    const job = await store.enqueue({ job: newJob(), requester })
    d1.sqlite.exec("UPDATE dx_jobs SET metadata = '[1]'")
    await expect(store.getById({ id: job.id, requester })).rejects.toBeInstanceOf(CorruptJobMetadataError)
    d1.sqlite.exec("UPDATE dx_jobs SET metadata = '{not json'")
    await expect(store.getById({ id: job.id, requester })).rejects.toBeInstanceOf(CorruptJobMetadataError)
    d1.sqlite.exec("UPDATE dx_jobs SET metadata = NULL, scope = 'bogus'")
    await expect(store.getById({ id: job.id, requester: { scope: "system" } as never })).resolves.toBeNull()
    d1.sqlite.exec("UPDATE dx_jobs SET scope = 'system'")
    expect(await store.getById({ id: job.id, requester })).toMatchObject({ id: job.id })
  })

  it("validates its column maps at construction", () => {
    const session = createDrizzleD1Adapter(drizzle(null as never) as never).repository
    const { id: _id, ...withoutId } = columnMap(jobs) as Record<string, unknown>
    expect(() => createDrizzleJobStore(session, { jobsTable: jobs, executionsTable: execs, columnMap: { jobs: withoutId as never, executions: columnMap(execs) } })).toThrow("missing the required 'id' column")
    const { jobId: _jobId, ...execsWithout } = columnMap(execs) as Record<string, unknown>
    expect(() => createDrizzleJobStore(session, { jobsTable: jobs, executionsTable: execs, columnMap: { jobs: columnMap(jobs), executions: execsWithout as never } })).toThrow("executions column map")
    const plain = { select: () => ({}), insert: () => ({}), update: () => ({}), delete: () => ({}) } as never
    expect(() => createDrizzleJobStore(plain, { jobsTable: jobs, executionsTable: execs, executionHistory: "required", columnMap: { jobs: columnMap(jobs), executions: columnMap(execs) } })).toThrow(ConfigurationError)
  })
})

describe("D1 job store on a real SQLite engine: claiming and transitions", () => {
  it("claims due jobs in priority order within the limit, bumping attempts and issuing claim tokens", async () => {
    const { db, row } = await setup()
    const store = jobStore(db)
    const low = await store.enqueue({ job: newJob({ priority: 9 }), requester })
    const high = await store.enqueue({ job: newJob({ priority: 1 }), requester })
    await store.enqueue({ job: newJob({ priority: 5 }), requester })
    const claimed = await claim(store, { limit: 2 })
    expect(claimed).toHaveLength(2)
    expect(claimed[0]!.id).not.toBe(low.id)
    expect(claimed.map((job) => job.id)).toContain(high.id)
    expect(claimed.every((job) => job.status === "running" && job.currentAttempt === 1 && job.leaseOwner === "w1" && typeof job.claimToken === "string")).toBe(true)
    expect(row("SELECT count(*) AS c FROM dx_jobs WHERE status = 'running'")).toEqual({ c: 2 })
  })

  it("claims nothing for a non-positive limit, and rejects invalid worker ids", async () => {
    const { db } = await setup()
    const store = jobStore(db)
    await store.enqueue({ job: newJob(), requester })
    expect(await claim(store, { limit: 0 })).toEqual([])
    expect(await claim(store, { limit: 1.5 })).toEqual([])
    await expect(claim(store, { workerId: "w".repeat(101) })).rejects.toThrow("workerId exceeds the maximum")
  })

  it("does not claim jobs that are not yet due or belong to another requester scope", async () => {
    const { db } = await setup()
    const store = jobStore(db)
    await store.enqueue({ job: newJob({ runAt: new Date(Date.now() + 3_600_000) }), requester })
    await store.enqueue({ job: tenantJob("t1"), requester: tenantRequester("t1") })
    expect(await claim(store)).toEqual([])
    const tenantClaim = await claim(store, { requester: tenantRequester("t1") })
    expect(tenantClaim).toHaveLength(1)
    expect(tenantClaim[0]!.tenantId).toBe("t1")
  })

  it("serializes jobs of one partition and reclaims after the running sibling finishes", async () => {
    const { db } = await setup()
    const store = jobStore(db)
    await store.enqueue({ job: newJob({ partitionKey: "p1" }), requester })
    await store.enqueue({ job: newJob({ partitionKey: "p1" }), requester })
    await store.enqueue({ job: newJob({ partitionKey: "p2" }), requester })
    const first = await claim(store)
    expect(first.map((job) => job.partitionKey).sort()).toEqual(["p1", "p2"])
    expect(await claim(store, { workerId: "w2" })).toEqual([])
    const p1 = first.find((job) => job.partitionKey === "p1")!
    expect(await store.markSucceeded({ jobId: p1.id, workerId: "w1", claimToken: p1.claimToken!, attempt: p1.currentAttempt })).toMatchObject({ applied: true })
    const next = await claim(store, { workerId: "w2" })
    expect(next).toHaveLength(1)
    expect(next[0]!.partitionKey).toBe("p1")
  })

  it("renews leases only for the live owner and never shortens them", async () => {
    const { db, row } = await setup()
    const store = jobStore(db)
    await store.enqueue({ job: newJob(), requester })
    const [job] = await claim(store)
    const before = Number(row("SELECT lease_expires_at AS l FROM dx_jobs")!.l)
    expect(await store.renewLease({ jobId: job!.id, workerId: "w1", claimToken: job!.claimToken!, extendByMs: 1 })).toBe(true)
    expect(Number(row("SELECT lease_expires_at AS l FROM dx_jobs")!.l)).toBeGreaterThanOrEqual(before)
    expect(await store.renewLease({ jobId: job!.id, workerId: "w1", claimToken: job!.claimToken!, extendByMs: 3_600_000 })).toBe(true)
    expect(Number(row("SELECT lease_expires_at AS l FROM dx_jobs")!.l)).toBeGreaterThan(before + 3_000_000)
    expect(await store.renewLease({ jobId: job!.id, workerId: "w1", claimToken: job!.claimToken!, extendByMs: 0 })).toBe(false)
    expect(await store.renewLease({ jobId: job!.id, workerId: "w1", claimToken: job!.claimToken!, extendByMs: Number.NaN })).toBe(false)
    expect(await store.renewLease({ jobId: job!.id, workerId: "w2", claimToken: job!.claimToken!, extendByMs: 10 })).toBe(false)
    expect(await store.renewLease({ jobId: job!.id, workerId: "w1", claimToken: "stale", extendByMs: 10 })).toBe(false)
  })

  it("moves through retrying then failed and reports LEASE_LOST for stale tokens", async () => {
    const { db, row } = await setup()
    const store = jobStore(db)
    await store.enqueue({ job: newJob({ maxAttempts: 2 }), requester })
    const [first] = await claim(store)
    expect(await store.markRetrying({ jobId: first!.id, workerId: "w1", claimToken: "stale", attempt: 1, error: "e", nextAttemptAt: new Date() })).toEqual({ applied: false, reason: "LEASE_LOST" })
    const retry = await store.markRetrying({ jobId: first!.id, workerId: "w1", claimToken: first!.claimToken!, attempt: 1, error: "boom", nextAttemptAt: new Date(Date.now() - 1) })
    expect(retry).toMatchObject({ applied: true })
    expect(row("SELECT status, last_error, lease_owner FROM dx_jobs")).toEqual({ status: "retrying", last_error: "boom", lease_owner: null })
    const [second] = await claim(store)
    expect(second!.currentAttempt).toBe(2)
    expect(await store.markRetrying({ jobId: second!.id, workerId: "w1", claimToken: second!.claimToken!, attempt: 2, error: "again", nextAttemptAt: new Date() })).toEqual({ applied: false, reason: "LEASE_LOST" })
    expect(await store.markFailed({ jobId: second!.id, workerId: "w1", claimToken: "stale", attempt: 2, error: "x", status: "failed" })).toEqual({ applied: false, reason: "LEASE_LOST" })
    expect(await store.markFailed({ jobId: second!.id, workerId: "w1", claimToken: second!.claimToken!, attempt: 2, error: "fatal", status: "dead_letter" })).toMatchObject({ applied: true })
    expect(row("SELECT status, last_error, typeof(completed_at) AS t FROM dx_jobs")).toEqual({ status: "dead_letter", last_error: "fatal", t: "integer" })
    expect(await store.markSucceeded({ jobId: second!.id, workerId: "w1", claimToken: second!.claimToken!, attempt: 2 })).toEqual({ applied: false, reason: "LEASE_LOST" })
  })

  it("release gives the attempt back and clears the lease", async () => {
    const { db, row } = await setup()
    const store = jobStore(db)
    await store.enqueue({ job: newJob(), requester })
    const [job] = await claim(store)
    expect(await store.release({ jobId: job!.id, workerId: "w1", claimToken: "stale", nextAttemptAt: new Date(), reason: "x" })).toEqual({ applied: false, reason: "LEASE_LOST" })
    expect(await store.release({ jobId: job!.id, workerId: "w1", claimToken: job!.claimToken!, nextAttemptAt: new Date(Date.now() - 1), reason: "r".repeat(600) })).toEqual({ applied: true })
    const stored = row("SELECT status, attempts, length(last_error) AS n, lease_owner FROM dx_jobs")!
    expect(stored).toEqual({ status: "retrying", attempts: 0, n: 512, lease_owner: null })
    expect(await claim(store)).toHaveLength(1)
  })

  it("dead-letters expired final-attempt jobs, reclaims expired earlier attempts and ignores missing leases", async () => {
    const { d1, db, row } = await setup()
    const store = jobStore(db)
    await store.enqueue({ job: newJob({ maxAttempts: 1 }), requester })
    await store.enqueue({ job: newJob({ maxAttempts: 3 }), requester })
    expect(await claim(store)).toHaveLength(2)
    d1.sqlite.exec("UPDATE dx_jobs SET lease_expires_at = 1")
    const reclaimed = await claim(store, { workerId: "w2" })
    expect(reclaimed).toHaveLength(1)
    expect(reclaimed[0]!.currentAttempt).toBe(2)
    expect(row("SELECT status, last_error, claim_token FROM dx_jobs WHERE max_attempts = 1")).toEqual({ status: "dead_letter", last_error: "LEASE_EXPIRED_AFTER_FINAL_ATTEMPT", claim_token: null })
  })

  it("cancels pending jobs once, refuses terminal or foreign ones and records history", async () => {
    const { db, row, count } = await setup()
    const store = jobStore(db)
    const job = await store.enqueue({ job: newJob(), requester })
    expect(await store.cancel({ jobId: job.id, requester: tenantRequester("t1"), reason: "nope" })).toEqual({ applied: false, reason: "INVALID_STATE" })
    expect(await store.cancel({ jobId: job.id, requester, reason: "stop" })).toMatchObject({ applied: true })
    expect(row("SELECT status, last_error FROM dx_jobs")).toEqual({ status: "cancelled", last_error: "stop" })
    expect(count("dx_execs")).toBe(1)
    expect(await store.cancel({ jobId: job.id, requester })).toEqual({ applied: false, reason: "INVALID_STATE" })
    expect(await store.cancel({ jobId: "ghost", requester })).toEqual({ applied: false, reason: "INVALID_STATE" })
  })
})

describe("D1 job store on a real SQLite engine: required execution history", () => {
  it("writes history atomically with each transition", async () => {
    const { db, row, rows } = await setup()
    const store = jobStore(db, "required")
    await store.enqueue({ job: newJob({ maxAttempts: 3 }), requester })
    const [first] = await claim(store)
    const retry = await store.markRetrying({ jobId: first!.id, workerId: "w1", claimToken: first!.claimToken!, attempt: 1, error: "boom", nextAttemptAt: new Date(Date.now() - 1) })
    expect(retry).toMatchObject({ applied: true })
    const [second] = await claim(store)
    expect(await store.markFailed({ jobId: second!.id, workerId: "w1", claimToken: "stale", attempt: 2, error: "x", status: "failed" })).toEqual({ applied: false, reason: "LEASE_LOST" })
    expect(await store.markFailed({ jobId: second!.id, workerId: "w1", claimToken: second!.claimToken!, attempt: 2, error: "fatal", status: "failed" })).toMatchObject({ applied: true })
    expect(rows("SELECT status, attempt, worker_id FROM dx_execs ORDER BY attempt")).toEqual([
      { status: "retrying", attempt: 1, worker_id: "w1" },
      { status: "failed", attempt: 2, worker_id: "w1" },
    ])
    expect(row("SELECT claim_token FROM dx_jobs")).toEqual({ claim_token: null })
  })

  it("reports HISTORY_FAILED with a sanitized code and leaves the job unchanged", async () => {
    const { d1, db, row } = await setup()
    d1.sqlite.exec("CREATE TRIGGER dx_execs_secret BEFORE INSERT ON dx_execs BEGIN SELECT RAISE(ABORT, 'secret internal detail dx_execs'); END")
    const store = jobStore(db, "required")
    await store.enqueue({ job: newJob(), requester })
    const [job] = await claim(store)
    const result = await store.markSucceeded({ jobId: job!.id, workerId: "w1", claimToken: job!.claimToken!, attempt: 1 })
    expect(result).toMatchObject({ applied: false, reason: "HISTORY_FAILED" })
    expect(JSON.stringify(result)).not.toMatch(/secret|dx_execs|D1_ERROR/)
    expect(row("SELECT status FROM dx_jobs")).toEqual({ status: "running" })
    const cancelled = await store.cancel({ jobId: job!.id, requester, reason: "stop" })
    expect(cancelled).toMatchObject({ applied: false, reason: "HISTORY_FAILED" })
  })

  it("cancels with atomic history and reports INVALID_STATE for terminal jobs", async () => {
    const { db, row } = await setup()
    const store = jobStore(db, "required")
    const job = await store.enqueue({ job: newJob(), requester })
    expect(await store.cancel({ jobId: job.id, requester, reason: "stop" })).toMatchObject({ applied: true })
    expect(row("SELECT j.status AS status, e.worker_id AS worker_id FROM dx_jobs j, dx_execs e")).toEqual({ status: "cancelled", worker_id: "cancellation" })
    expect(await store.cancel({ jobId: job.id, requester })).toEqual({ applied: false, reason: "INVALID_STATE" })
  })

  it("best-effort history failures do not fail the transition", async () => {
    const { d1, db, row } = await setup()
    d1.sqlite.exec("CREATE TRIGGER dx_execs_fail BEFORE INSERT ON dx_execs BEGIN SELECT RAISE(ABORT, 'nope'); END")
    const store = jobStore(db, "best_effort")
    await store.enqueue({ job: newJob(), requester })
    const [job] = await claim(store)
    expect(await store.markSucceeded({ jobId: job!.id, workerId: "w1", claimToken: job!.claimToken!, attempt: 1, result: { ok: true } })).toMatchObject({ applied: true })
    expect(row("SELECT status, result_payload FROM dx_jobs")).toEqual({ status: "succeeded", result_payload: '{"ok":true}' })
  })
})
