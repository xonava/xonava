import { describe, expect, it } from "vitest"
import { DrizzleMySqlJobStore } from "adapters/drizzle-mysql"
import { createJobRegistry, dispatchDueJobs } from "core/execution"
import { openMySqlFixture } from "./database.js"

const requester = { scope: "tenant" as const, tenantId: "t1", actorId: "user-1" }

describe("MYSQL1 job release", () => {
  it("hands an unknown job type back without consuming an attempt (rolling deploys)", async () => {
    const fixture = await openMySqlFixture()
    try {
      const store = new DrizzleMySqlJobStore(fixture.pool)
      const job = await store.enqueue({ requester, job: { executionScope: { kind: "tenant", tenantId: "t1" }, jobType: "added-in-next-release", jobVersion: 1, payload: {}, idempotencyKey: "release-1", runAt: new Date(Date.now() - 1_000), maxAttempts: 2 } })
      const result = await dispatchDueJobs({ store, registry: createJobRegistry(), workerId: "old-worker", leaseDurationMs: 60_000, claimLimit: 5, requester })
      expect(result).toMatchObject({ claimed: 1, retried: 1, failed: 0, deadLettered: 0 })
      const [rows] = await fixture.pool.query("SELECT status, attempt, worker_id, claim_token, last_error, next_attempt_at FROM jobs WHERE id=?", [job.id])
      const row = (rows as Record<string, unknown>[])[0]!
      expect(row).toMatchObject({ status: "retrying", attempt: 0, worker_id: null, claim_token: null })
      // The reason carries the first-deferral marker that bounds repeated hand-backs.
      expect(row.last_error).toMatch(/^Unknown job definition: added-in-next-release@1 \(unrunnable since \S+Z\)$/)
      expect(new Date(row.next_attempt_at as string).getTime()).toBeGreaterThan(Date.now() + 30_000)
    } finally {
      await fixture.pool.end()
    }
  }, 30_000)

  it("refuses to release a claim it does not hold", async () => {
    const fixture = await openMySqlFixture()
    try {
      const store = new DrizzleMySqlJobStore(fixture.pool)
      await store.enqueue({ requester, job: { executionScope: { kind: "tenant", tenantId: "t1" }, jobType: "email", jobVersion: 1, payload: {}, idempotencyKey: "release-2", runAt: new Date(Date.now() - 1_000) } })
      const [claimed] = await store.claimDue({ requester, workerId: "w", limit: 1, leaseDurationMs: 60_000 })
      await expect(store.release({ jobId: claimed!.id, workerId: "w", claimToken: "stale", nextAttemptAt: new Date(), reason: "x" })).resolves.toEqual({ applied: false, reason: "LEASE_LOST" })
      await expect(store.release({ jobId: claimed!.id, workerId: "w", claimToken: claimed!.claimToken!, nextAttemptAt: new Date(), reason: "x" })).resolves.toEqual({ applied: true })
    } finally {
      await fixture.pool.end()
    }
  }, 30_000)
})
