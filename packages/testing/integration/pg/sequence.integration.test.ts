import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DrizzlePgSequenceStore } from "adapters/drizzle-pg"
import { allocateSequence } from "core/sequence"
import { openPgFixture, pgCertificationUrl } from "./database.js"
describe("sequence PostgreSQL integration", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 24 })
  beforeAll(async () => { const fixture = await openPgFixture(); await fixture.end() })
  afterAll(() => pool.end())
  it("serializes concurrent scoped allocations", async () => { const store = new DrizzlePgSequenceStore(pool, "framework_test"); const values = await Promise.all(Array.from({ length: 20 }, () => store.next("tenant-a" as never, "invoice", "2026"))); expect(values.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1)); expect(await store.next("tenant-b" as never, "invoice", "2026")).toBe(1); expect(await store.next("tenant-a" as never, "invoice", "2027")).toBe(1) })
  it("reuses a rolled-back number in the consuming transaction", async () => { const client = await pool.connect(); try { await client.query("BEGIN"); expect(await allocateSequence(new DrizzlePgSequenceStore(client, "framework_test"), { scopeId: "rollback" as never, definition: { name: "case", prefix: "C-", padding: 3 } })).toMatchObject({ value: 1, formatted: "C-001" }); await client.query("ROLLBACK") } finally { client.release() }; expect(await new DrizzlePgSequenceStore(pool, "framework_test").next("rollback" as never, "case", "all")).toBe(1) })
})
