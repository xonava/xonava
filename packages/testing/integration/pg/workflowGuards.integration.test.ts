import pg from "pg"
import { afterAll, beforeAll, describe, it } from "vitest"
import { DrizzlePgWorkflowStore } from "adapters/drizzle-pg"
import { openPgFixture, pgCertificationUrl } from "./database.js"
import { assertWorkflowStoreGuards } from "../shared/workflowStoreGuards.js"

describe("PostgreSQL workflow store guards", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl() })
  beforeAll(async () => { const fixture = await openPgFixture(); await fixture.end() })
  afterAll(() => pool.end())
  it("keeps compensation on cancel and backoff on repeated signals", async () => {
    await assertWorkflowStoreGuards(new DrizzlePgWorkflowStore(pool, { schema: "framework_test" }), `wf-guards-pg-${Date.now()}`)
  })
})
