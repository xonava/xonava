import pg from "pg"
import { afterAll, beforeAll, describe, it } from "vitest"
import { DrizzlePgWorkflowStore } from "@xonava/adapters/drizzle-pg"
import { openPgFixture, pgCertificationUrl } from "./database.js"
import { assertWorkflowDurableState } from "../shared/workflowDurableState.js"

describe("PostgreSQL workflow durable state", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl() })
  beforeAll(async () => { const fixture = await openPgFixture(); await fixture.end() })
  afterAll(() => pool.end())
  it("keeps step attempts across waits and persists upcast variables with their version", async () => {
    await assertWorkflowDurableState(new DrizzlePgWorkflowStore(pool, { schema: "framework_test" }), `wf-state-pg-${Date.now()}`)
  })
})
