import { describe, expect, it } from "vitest"
import { jobStore, newJob, requester, setup } from "./sqliteFixture"

describe("d1 job store enqueue validation on a real SQLite engine", () => {
  it("validates the job and the requester before writing anything", async () => {
    const { db, count } = await setup()
    const store = jobStore(db)
    await expect(store.enqueue({ job: newJob({ jobType: "  " }), requester })).rejects.toThrow("Job type must be non-empty")
    await expect(store.enqueue({ job: newJob({ jobVersion: 0 }), requester })).rejects.toThrow("Job version must be a positive integer")
    await expect(store.enqueue({ job: newJob({ maxAttempts: 0 }), requester })).rejects.toThrow("Job maxAttempts must be a positive integer")
    await expect(store.enqueue({ job: newJob({ priority: 1.5 }), requester })).rejects.toThrow("Job priority must be a safe integer")
    expect(count("dx_jobs")).toBe(0)
  })

  it("wraps insert failures as framework errors carrying the d1 dialect", async () => {
    const { db, d1 } = await setup()
    const store = jobStore(db)
    d1.sqlite.exec("DROP TABLE dx_jobs")
    const plain = await store.enqueue({ job: newJob(), requester }).catch((e: unknown) => e) as { details?: Record<string, unknown> }
    expect(plain.details).toMatchObject({ dialect: "d1" })
    const keyed = await store.enqueue({ job: newJob({ idempotencyKey: "k" }), requester }).catch((e: unknown) => e) as { details?: Record<string, unknown> }
    expect(keyed.details).toMatchObject({ dialect: "d1" })
  })
})
