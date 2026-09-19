import { describe, expect, it } from "vitest"
import { DrizzleD1SequenceStore } from "adapters/drizzle-d1"
import { temporaryD1Fixture } from "./database.js"
describe("sequence D1 integration", () => {
  it("serializes allocations and isolates scope and reset period", async () => { const fixture = await temporaryD1Fixture(); try { const store = new DrizzleD1SequenceStore(fixture.db as never); const values = await Promise.all(Array.from({ length: 20 }, () => store.next("tenant-a" as never, "invoice", "2026"))); expect(values.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1)); expect(await store.next("tenant-b" as never, "invoice", "2026")).toBe(1); expect(await store.next("tenant-a" as never, "invoice", "2027")).toBe(1) } finally { await fixture.close(); await fixture.cleanup() } })
  it("returns an allocation to the sequence when its consumer batch fails", async () => { const fixture = await temporaryD1Fixture(); try { const store = new DrizzleD1SequenceStore(fixture.db as never); await expect(store.nextWithStatements("tenant" as never, "case", "all", [fixture.db.prepare("INSERT INTO missing_sequence_consumer VALUES (1)") as never])).rejects.toThrow(); expect(await store.next("tenant" as never, "case", "all")).toBe(1) } finally { await fixture.close(); await fixture.cleanup() } })
})
