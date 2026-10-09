import { describe, it } from "vitest"
import { DrizzleD1WorkflowStore } from "adapters/drizzle-d1"
import { temporaryD1Fixture } from "./database.js"
import { assertWorkflowDurableState } from "../shared/workflowDurableState.js"

describe("D1 workflow durable state", () => {
  it("keeps step attempts across waits and persists upcast variables with their version", async () => {
    const fixture = await temporaryD1Fixture()
    try {
      await assertWorkflowDurableState(new DrizzleD1WorkflowStore(fixture.db as never), "wf-state-d1")
    } finally {
      await fixture.close()
      await fixture.cleanup()
    }
  })
})
