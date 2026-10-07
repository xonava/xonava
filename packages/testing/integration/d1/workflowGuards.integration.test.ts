import { describe, it } from "vitest"
import { DrizzleD1WorkflowStore } from "adapters/drizzle-d1"
import { temporaryD1Fixture } from "./database.js"
import { assertWorkflowStoreGuards } from "../shared/workflowStoreGuards.js"

describe("D1 workflow store guards", () => {
  it("keeps compensation on cancel and backoff on repeated signals", async () => {
    const fixture = await temporaryD1Fixture()
    try {
      await assertWorkflowStoreGuards(new DrizzleD1WorkflowStore(fixture.db as never), "wf-guards-d1")
    } finally {
      await fixture.close()
      await fixture.cleanup()
    }
  })
})
