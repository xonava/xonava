import { describe, expect, it } from "vitest"
import { DrizzleD1JobProgressStore } from "@xonava/adapters/drizzle-d1"
import { temporaryD1Fixture } from "./database.js"

describe("J1 D1 durable progress", () => {
  it("persists checkpoints and rejects stale fences and sequences", async () => {
    const fixture = await temporaryD1Fixture()
    try {
      await fixture.db.prepare("INSERT INTO framework_j1_jobs VALUES (?,?,?,?,CAST(unixepoch('subsec')*1000 AS INTEGER)+60000)").bind("job-d1", "worker", "token", 2).run()
      const store = new DrizzleD1JobProgressStore(fixture.db as never)
      expect(await store.write({ jobId: "job-d1", workerId: "worker", claimToken: "token", attempt: 2 }, 0, { percent: 25, checkpoint: { cursor: 4 } })).toMatchObject({ sequence: 1, percent: 25, checkpoint: { cursor: 4 } })
      await expect(store.write({ jobId: "job-d1", workerId: "worker", claimToken: "token", attempt: 2 }, 0, { percent: 50 })).rejects.toMatchObject({ code: "CONFLICT" })
      await expect(store.write({ jobId: "job-d1", workerId: "worker", claimToken: "stale", attempt: 2 }, 1, { percent: 50 })).rejects.toMatchObject({ code: "STALE_CLAIM" })
    } finally { await fixture.close(); await fixture.cleanup() }
  })
})
