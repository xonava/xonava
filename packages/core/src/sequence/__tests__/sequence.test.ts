import { describe, expect, it, vi } from "vitest"
import { ConfigurationError } from "../../domain"
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

describe("sequence allocation time range", () => {
  it("rejects local years above 9999 and accepts the last representable 4-digit instant", async () => {
    // With an empty separator, year 2026 value 305 and year 20263 value 5 (padding 2) would both format as "2026305".
    const memory = { next: async () => 5 }
    const definition = { name: "inv", reset: "year" as const, periodFormat: "compact" as const, periodSeparator: "", padding: 2 }
    const scopeId = "tenant" as never
    await expect(allocateSequence(memory, { scopeId, definition, at: new Date(Date.UTC(20263, 5, 1)) })).rejects.toBeInstanceOf(ConfigurationError)
    await expect(allocateSequence(memory, { scopeId, definition, at: new Date(8.64e15) })).rejects.toBeInstanceOf(ConfigurationError)
    for (const reset of ["year", "month", "day"] as const) {
      expect(() => sequencePeriod(reset, new Date(Date.UTC(10000, 0, 1)))).toThrow(ConfigurationError)
      expect(sequencePeriod(reset, new Date(Date.UTC(9999, 11, 31, 23, 59, 59, 999)))).toMatch(/^9999/)
    }
    // The zone decides: 9999-12-31T20:00Z is already year 10000 in UTC+5:30, still 9999 in UTC.
    expect(() => sequencePeriod("year", new Date(Date.UTC(9999, 11, 31, 20)), "Asia/Kolkata")).toThrow(ConfigurationError)
    expect(sequencePeriod("year", new Date(Date.UTC(9999, 11, 31, 20)))).toBe("9999")
    // A counter that never resets has no period and is unaffected.
    expect(sequencePeriod("never", new Date(8.64e15))).toBe("all")
  })
})

describe("sequence time zones and period formatting", () => {
  const memory = () => { const counters = new Map<string, number>(); return { next: async (scope: string, name: string, period: string) => { const key = `${scope}|${name}|${period}`; const value = (counters.get(key) ?? 0) + 1; counters.set(key, value); return value } } }

  it("resets at local midnight in the configured time zone", async () => {
    // 2026-03-31T20:00Z is already April 1st in India (UTC+05:30).
    const at = new Date("2026-03-31T20:00:00.000Z")
    expect(sequencePeriod("month", at)).toBe("2026-03")
    expect(sequencePeriod("month", at, "Asia/Kolkata")).toBe("2026-04")
    expect(sequencePeriod("day", new Date("2026-01-01T03:00:00.000Z"), "America/New_York")).toBe("2025-12-31")
    expect(sequencePeriod("year", new Date("2025-12-31T19:00:00.000Z"), "Asia/Tokyo")).toBe("2026")
  })

  it("embeds the period in the formatted number", async () => {
    const store = memory()
    const definition = { name: "invoice", prefix: "INV-", padding: 4, reset: "month" as const, timeZone: "Asia/Kolkata", periodFormat: "iso" as const }
    await expect(allocateSequence(store, { scopeId: "s" as never, definition, at: new Date("2026-03-31T20:00:00.000Z") })).resolves.toMatchObject({ period: "2026-04", formatted: "INV-2026-04-0001" })
    await expect(allocateSequence(store, { scopeId: "s" as never, definition: { ...definition, periodFormat: "compact", periodSeparator: "/" }, at: new Date("2026-03-31T20:00:00.000Z") })).resolves.toMatchObject({ formatted: "INV-202604/0002" })
  })

  it("uses the injected clock when no trusted instant is supplied", async () => {
    const allocation = await allocateSequence(memory(), { scopeId: "s" as never, definition: { name: "n", reset: "year", periodFormat: "none" } }, () => new Date("2030-06-01T00:00:00.000Z"))
    expect(allocation.period).toBe("2030")
  })

  it("rejects invalid zones, separators, and period formats without a period", () => {
    expect(() => validateSequenceDefinition({ name: "n", timeZone: "Mars/Olympus" })).toThrow("time zone")
    expect(() => validateSequenceDefinition({ name: "n", reset: "month", periodFormat: "iso", periodSeparator: "<script>" })).toThrow("separator")
    expect(() => validateSequenceDefinition({ name: "n", periodFormat: "iso" })).toThrow("no period")
    expect(validateSequenceDefinition({ name: "n" })).toMatchObject({ timeZone: "UTC", periodFormat: "none", periodSeparator: "-" })
  })

  it("embeds the period when a resetting counter declares a period format", async () => {
    const store = memory()
    const definition = { name: "invoice", prefix: "INV-", reset: "year" as const, periodFormat: "compact" as const }
    const first = await allocateSequence(store, { scopeId: "s" as never, definition, at: new Date("2026-06-01T00:00:00.000Z") })
    const second = await allocateSequence(store, { scopeId: "s" as never, definition, at: new Date("2027-06-01T00:00:00.000Z") })
    expect(first).toMatchObject({ value: 1, formatted: "INV-2026-1" })
    expect(second).toMatchObject({ value: 1, formatted: "INV-2027-1" })
    expect(validateSequenceDefinition({ name: "n", reset: "day", periodFormat: "iso" })).toMatchObject({ periodFormat: "iso" })
  })

  it("requires a resetting counter to declare its period format instead of defaulting it", () => {
    expect(() => validateSequenceDefinition({ name: "n", reset: "month" })).toThrow(ConfigurationError)
    expect(() => validateSequenceDefinition({ name: "n", reset: "year" })).toThrow("periodFormat")
    expect(validateSequenceDefinition({ name: "n", reset: "month", periodFormat: "none" })).toMatchObject({ periodFormat: "none" })
    expect(validateSequenceDefinition({ name: "n", reset: "never" })).toMatchObject({ periodFormat: "none" })
  })
})
