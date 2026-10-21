import { afterAll, beforeAll, describe } from "vitest"
import { DrizzleD1JobProgressStore } from "@xonava/adapters/drizzle-d1"
import { openD1Fixture, type D1Fixture } from "./database.js"
import {
  defineConcurrentReporters, defineJobProgressDifferential, defineJobProgressRegressions, defineSequenceRace, type JobProgressStoreDifferentialDriver,
} from "../shared/jobProgressStoreDifferential.js"

describe("D1 job progress store differential", () => {
  let fixture: D1Fixture
  const db = () => fixture.db
  const NOW_MS = "CAST(unixepoch('subsec')*1000 AS INTEGER)"
  const leaseMs = (live: boolean): number => (live ? 3_600_000 : -60_000)
  // The store is created lazily so the Miniflare database exists by the time a property runs.
  const store = () => new DrizzleD1JobProgressStore(db() as never)
  const driver: JobProgressStoreDifferentialDriver = {
    label: "d1",
    store: { read: (jobId) => store().read(jobId), write: (fence, expected, progress) => store().write(fence, expected, progress) },
    lifecycleRuns: 50,
    concurrencyRuns: 50,
    light: true,
    maxWorkers: 4,
    reset: async () => { await db().prepare("DELETE FROM framework_job_progress").run(); await db().prepare("DELETE FROM framework_j1_jobs").run() },
    claim: async (job, claim) => {
      await db().prepare(`INSERT INTO framework_j1_jobs(id,worker_id,claim_token,attempt,lease_expires_at_ms) VALUES(?,?,?,?,${NOW_MS}+?)
        ON CONFLICT(id) DO UPDATE SET worker_id=excluded.worker_id,claim_token=excluded.claim_token,attempt=excluded.attempt,lease_expires_at_ms=excluded.lease_expires_at_ms`)
        .bind(job, claim.worker, claim.token, claim.attempt, leaseMs(claim.live)).run()
    },
    setLease: async (job, live) => { await db().prepare(`UPDATE framework_j1_jobs SET lease_expires_at_ms=${NOW_MS}+? WHERE id=?`).bind(leaseMs(live), job).run() },
    dump: async () => (((await db().prepare("SELECT job_id, attempt, sequence, percent, checkpoint FROM framework_job_progress").all()).results ?? []) as Record<string, unknown>[]).map((r) => ({
      jobId: r.job_id as string, attempt: Number(r.attempt), sequence: Number(r.sequence), percent: r.percent === null ? null : Number(r.percent),
      checkpoint: r.checkpoint === null ? null : JSON.parse(r.checkpoint as string) as Record<string, unknown>,
    })),
  }

  beforeAll(async () => { fixture = await openD1Fixture() })
  afterAll(async () => { await fixture?.close() })

  defineJobProgressRegressions(driver)
  defineJobProgressDifferential(driver)
  defineConcurrentReporters(driver)
  defineSequenceRace(driver)
})
