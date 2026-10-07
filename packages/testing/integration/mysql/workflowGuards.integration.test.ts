import { describe, it } from "vitest"
import { DrizzleMySqlWorkflowStore } from "adapters/drizzle-mysql"
import { openMySqlFixture } from "./database.js"
import { assertWorkflowStoreGuards } from "../shared/workflowStoreGuards.js"

describe("MySQL workflow store guards", () => {
  it("keeps compensation on cancel and backoff on repeated signals", async () => {
    const { pool } = await openMySqlFixture()
    try {
      await assertWorkflowStoreGuards(new DrizzleMySqlWorkflowStore(pool), `wf-guards-mysql-${Date.now()}`)
    } finally {
      await pool.end()
    }
  })
})
