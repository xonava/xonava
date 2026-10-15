import { describe, expect, it } from "vitest"
import { DrizzleD1SequenceStore, DrizzleD1TemporalHistoryStore } from "@xonava/adapters/drizzle-d1"
import { temporaryD1Fixture } from "./database.js"
describe("D1 temporal and sequence races", () => {
  it("serializes both allocators under contention", async () => {
    const fixture = await temporaryD1Fixture()
    try {
      const temporal = new DrizzleD1TemporalHistoryStore<{ value: number }>(fixture.db as never)
      const resource = { scopeId: "race" as never, entityType: "record", entityId: "one" }
      const created = await temporal.append({ ...resource, occurredAt: new Date(1), kind: "created", state: { value: 0 } })
      const revisions = await Promise.all(Array.from({ length: 15 }, (_, value) => temporal.append({ ...resource, occurredAt: new Date(1), kind: "updated", state: { value } })))
      expect([created, ...revisions].map(item => item.revision).sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, index) => index + 1))
      const sequence = new DrizzleD1SequenceStore(fixture.db as never)
      const values = await Promise.all(Array.from({ length: 16 }, () => sequence.next("race" as never, "invoice", "all")))
      expect(values.sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, index) => index + 1))
    } finally { await fixture.close(); await fixture.cleanup() }
  })
})
