import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DrizzlePgJobProgressStore } from "@xonava/adapters/drizzle-pg"
import { openPgFixture, pgCertificationUrl } from "./database.js"

describe("J1 PostgreSQL durable progress", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl() })
  beforeAll(async () => { const fixture = await openPgFixture(); await fixture.end() })
  afterAll(() => pool.end())
  it("persists checkpoints and rejects stale fences and sequences", async () => {
    await pool.query("INSERT INTO framework_test.j1_jobs VALUES ($1,$2,$3,$4,clock_timestamp()+interval '1 minute')", ["job-pg", "worker", "token", 2])
    const store = new DrizzlePgJobProgressStore(pool, { schema: "framework_test", jobsTable: "j1_jobs" })
    expect(await store.write({ jobId: "job-pg", workerId: "worker", claimToken: "token", attempt: 2 }, 0, { percent: 25, checkpoint: { cursor: 4 } })).toMatchObject({ sequence: 1, percent: 25, checkpoint: { cursor: 4 } })
    await expect(store.write({ jobId: "job-pg", workerId: "worker", claimToken: "token", attempt: 2 }, 0, { percent: 50 })).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(store.write({ jobId: "job-pg", workerId: "worker", claimToken: "stale", attempt: 2 }, 1, { percent: 50 })).rejects.toMatchObject({ code: "STALE_CLAIM" })
  })
})
