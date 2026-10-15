import { describe, it } from "vitest"
import { DrizzleMySqlWorkflowStore } from "@xonava/adapters/drizzle-mysql"
import { openMySqlFixture } from "./database.js"
import { assertWorkflowDurableState } from "../shared/workflowDurableState.js"

describe("MySQL workflow durable state", () => {
  it("keeps step attempts across waits and persists upcast variables with their version", async () => {
    const { pool } = await openMySqlFixture()
    try {
      await assertWorkflowDurableState(new DrizzleMySqlWorkflowStore(pool), `wf-state-mysql-${Date.now()}`)
    } finally {
      await pool.end()
    }
  })
})
