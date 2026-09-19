import { describe, expect, it, vi } from "vitest"
import { allocateSequence, sequencePeriod, validateSequenceDefinition } from "../index.js"

describe("sequence service", () => {
  it("allocates scoped values and formats without changing the stored number", async () => {
    const next = vi.fn().mockResolvedValue(42)
    await expect(allocateSequence({ next }, { scopeId: "tenant-a" as never, definition: { name: "invoice", prefix: "INV-", padding: 6 }, at: new Date("2026-04-03T23:00:00Z") })).resolves.toEqual({ scopeId: "tenant-a", name: "invoice", period: "all", value: 42, formatted: "INV-000042" })
    expect(next).toHaveBeenCalledWith("tenant-a", "invoice", "all")
  })
  it("derives reset buckets in UTC", () => {
    const at = new Date("2026-01-02T01:02:03Z")
    expect(sequencePeriod("never", at)).toBe("all")
    expect(sequencePeriod("year", at)).toBe("2026")
    expect(sequencePeriod("month", at)).toBe("2026-01")
    expect(sequencePeriod("day", at)).toBe("2026-01-02")
  })
  it.each([{ name: "" }, { name: "ok", padding: -1 }, { name: "ok", padding: 33 }, { name: "ok", prefix: "\n" }, { name: "ok", reset: "week" }])("rejects invalid definitions %#", definition => { expect(() => validateSequenceDefinition(definition as never)).toThrow() })
  it("rejects invalid provider output", async () => { await expect(allocateSequence({ next: async () => 0 }, { scopeId: "tenant" as never, definition: { name: "case" } })).rejects.toThrow("invalid value") })
})
