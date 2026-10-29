import { afterEach, describe, expect, it, vi } from "vitest"
import { ConfigurationError } from "../../domain"
import { allocateSequence, sequencePeriod, validateSequenceDefinition, type SequenceStore } from ".."

const bad = (definition: unknown, message: string) => expect(() => validateSequenceDefinition(definition as never)).toThrow(new ConfigurationError(message))
const RESETTING = 'A resetting sequence must declare periodFormat; use "compact" or "iso" to keep formatted values unique, or "none" if the period is carried elsewhere'

describe("validateSequenceDefinition", () => {
  it("validates the name", () => {
    for (const v of [null, undefined]) bad(v, "Sequence name is invalid")
    for (const name of ["", "-a", "a b", 5, ["a"], "a".repeat(129)]) bad({ name }, "Sequence name is invalid")
    expect(validateSequenceDefinition({ name: "a".repeat(128) }).name).toHaveLength(128)
  })
  it("validates padding inclusively from 0 to 32", () => {
    for (const padding of [-1, 33, 1.5, Number.NaN, "2"]) bad({ name: "n", padding }, "Sequence padding must be an integer from 0 to 32")
    expect(validateSequenceDefinition({ name: "n", padding: 0 }).padding).toBe(0)
    expect(validateSequenceDefinition({ name: "n", padding: 32 }).padding).toBe(32)
  })
  it("validates reset period and prefix", () => {
    bad({ name: "n", reset: "week" }, "Sequence reset period is invalid")
    for (const prefix of [5, null, ["a"], "\n", "é", "a".repeat(65)]) bad({ name: "n", prefix }, "Sequence prefix is invalid")
    expect(validateSequenceDefinition({ name: "n", prefix: "a".repeat(64) }).prefix).toHaveLength(64)
    expect(validateSequenceDefinition({ name: "n", prefix: "" }).prefix).toBe("")
  })
  it("validates the time zone", () => {
    const tz = "Sequence time zone is invalid"
    for (const timeZone of [5, "Not/AZone", "a".repeat(65), ""]) bad({ name: "n", timeZone }, tz)
    expect(validateSequenceDefinition({ name: "n", timeZone: "Asia/Kolkata" }).timeZone).toBe("Asia/Kolkata")
  })
  it("validates the period format and separator", () => {
    for (const reset of ["year", "month", "day"]) bad({ name: "n", reset }, RESETTING)
    bad({ name: "n", reset: "year", periodFormat: "weekly" }, "Sequence period format is invalid")
    bad({ name: "n", periodFormat: "weekly" }, "Sequence period format is invalid")
    for (const periodFormat of ["compact", "iso"]) bad({ name: "n", periodFormat }, "A sequence without a reset period has no period to embed")
    for (const periodSeparator of [5, "abcde", "é", "\n"]) bad({ name: "n", periodSeparator }, "Sequence period separator is invalid")
    expect(validateSequenceDefinition({ name: "n", periodSeparator: "" }).periodSeparator).toBe("")
    expect(validateSequenceDefinition({ name: "n", periodSeparator: "abcd" }).periodSeparator).toBe("abcd")
    expect(validateSequenceDefinition({ name: "n", reset: "year", periodFormat: "none" }).periodFormat).toBe("none")
  })
  it("applies defaults and omits an absent prefix", () => {
    const out = validateSequenceDefinition({ name: "n" })
    expect(out).toStrictEqual({ name: "n", padding: 0, reset: "never", timeZone: "UTC", periodFormat: "none", periodSeparator: "-" })
    expect(Object.isFrozen(out)).toBe(true)
    expect(validateSequenceDefinition({ name: "n", prefix: "P", padding: 3, reset: "month", periodFormat: "iso", periodSeparator: "/" })).toStrictEqual({ name: "n", prefix: "P", padding: 3, reset: "month", periodFormat: "iso", periodSeparator: "/", timeZone: "UTC" })
  })
})

describe("sequencePeriod", () => {
  it("rejects invalid instants and unrepresentable years", () => {
    const m = "Sequence allocation time is invalid"
    for (const at of [new Date(Number.NaN), "2026-01-01", 5, null]) expect(() => sequencePeriod("day", at as never)).toThrow(new ConfigurationError(m))
    expect(() => sequencePeriod("never", new Date(Number.NaN))).toThrow(new ConfigurationError(m))
    expect(() => sequencePeriod("year", new Date("-000044-03-15T00:00:00Z"))).toThrow(new ConfigurationError(m))
    expect(() => sequencePeriod("year", new Date("+010000-01-01T00:00:00Z"))).toThrow(new ConfigurationError(m))
    expect(sequencePeriod("year", new Date("9999-12-31T23:59:59Z"))).toBe("9999")
    expect(sequencePeriod("year", new Date("0001-06-01T00:00:00Z"))).toBe("0001")
  })
  it("evaluates periods in the configured zone", () => {
    const at = new Date("2026-12-31T20:00:00Z")
    expect(sequencePeriod("day", at, "Asia/Kolkata")).toBe("2027-01-01")
    expect(sequencePeriod("month", at, "Asia/Kolkata")).toBe("2027-01")
    expect(sequencePeriod("year", at, "Asia/Kolkata")).toBe("2027")
    expect(sequencePeriod("day", at)).toBe("2026-12-31")
    expect(sequencePeriod("never", at, "Asia/Kolkata")).toBe("all")
    expect(() => sequencePeriod("day", at, "Not/AZone")).toThrow(new ConfigurationError("Sequence time zone is invalid"))
  })
})

describe("time zone formatter cache", () => {
  afterEach(() => vi.restoreAllMocks())
  it("reuses formatters and evicts the oldest beyond 64 zones", () => {
    const zones = Intl.supportedValuesOf("timeZone").filter(z => z !== "UTC").slice(0, 80)
    const at = new Date("2026-01-01T00:00:00Z")
    for (const z of zones.slice(0, 70)) sequencePeriod("day", at, z)
    const Original = Intl.DateTimeFormat
    const spy = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locale?: string | string[], options?: Intl.DateTimeFormatOptions) { return new Original(locale, options) } as never)
    const built = (z: string) => spy.mock.calls.filter(call => (call[1] as { timeZone?: string } | undefined)?.timeZone === z).length
    sequencePeriod("day", at, zones[69]!)
    sequencePeriod("day", at, zones[69]!)
    expect(built(zones[69]!)).toBe(0)
    sequencePeriod("day", at, zones[6]!)
    expect(built(zones[6]!)).toBe(0)
    sequencePeriod("day", at, zones[5]!)
    expect(built(zones[5]!)).toBe(1)
    sequencePeriod("day", at, zones[5]!)
    expect(built(zones[5]!)).toBe(1)
  })
})

describe("allocateSequence", () => {
  const store = (value: number): SequenceStore & { next: ReturnType<typeof vi.fn> } => ({ next: vi.fn(async () => value) })
  const at = new Date("2026-03-05T10:00:00Z")
  it("validates the scope", async () => {
    const m = "Sequence scope is invalid"
    for (const scopeId of ["", 5, "a\nb", "a\rb", "a\0b", "a".repeat(1025), undefined]) await expect(allocateSequence(store(1), { scopeId: scopeId as never, definition: { name: "n" } })).rejects.toThrow(new ConfigurationError(m))
    await expect(allocateSequence(store(1), null as never)).rejects.toThrow(new ConfigurationError(m))
    expect((await allocateSequence(store(1), { scopeId: "a".repeat(1024) as never, definition: { name: "n" } })).scopeId).toHaveLength(1024)
  })
  it("rejects invalid store values", async () => {
    for (const v of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      await expect(allocateSequence({ next: async () => v as never }, { scopeId: "s" as never, definition: { name: "n" } })).rejects.toThrow(new ConfigurationError("Sequence store returned an invalid value"))
    }
    expect((await allocateSequence(store(1), { scopeId: "s" as never, definition: { name: "n" } })).value).toBe(1)
  })
  it("formats the period token, prefix and padding", async () => {
    const run = (definition: object, value = 7) => allocateSequence(store(value), { scopeId: "s" as never, definition: { name: "n", ...definition } as never, at })
    expect((await run({})).formatted).toBe("7")
    expect((await run({ prefix: "INV-", padding: 4 })).formatted).toBe("INV-0007")
    expect((await run({ reset: "month", periodFormat: "compact" })).formatted).toBe("202603-7")
    expect((await run({ reset: "month", periodFormat: "iso" })).formatted).toBe("2026-03-7")
    expect((await run({ reset: "day", periodFormat: "compact", periodSeparator: "" })).formatted).toBe("202603057")
    expect((await run({ reset: "day", periodFormat: "iso", periodSeparator: "/", prefix: "X", padding: 3 })).formatted).toBe("X2026-03-05/007")
    expect((await run({ reset: "year", periodFormat: "none", prefix: "P", padding: 2 })).formatted).toBe("P07")
    expect((await run({ padding: 2 }, 123)).formatted).toBe("123")
  })
  it("passes scope, name and period to the store and returns a frozen allocation", async () => {
    const s = store(9)
    const out = await allocateSequence(s, { scopeId: "tenant" as never, definition: { name: "inv", reset: "month", periodFormat: "iso" }, at })
    expect(s.next).toHaveBeenCalledWith("tenant", "inv", "2026-03")
    expect(out).toStrictEqual({ scopeId: "tenant", name: "inv", period: "2026-03", value: 9, formatted: "2026-03-9" })
    expect(Object.isFrozen(out)).toBe(true)
  })
  it("prefers the request instant over the clock and uses the clock otherwise", async () => {
    const s = store(1)
    const other = new Date("2030-01-01T00:00:00Z")
    await allocateSequence(s, { scopeId: "s" as never, definition: { name: "n", reset: "year", periodFormat: "none" }, at }, () => other)
    expect(s.next).toHaveBeenLastCalledWith("s", "n", "2026")
    await allocateSequence(s, { scopeId: "s" as never, definition: { name: "n", reset: "year", periodFormat: "none" } }, () => other)
    expect(s.next).toHaveBeenLastCalledWith("s", "n", "2030")
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2031-06-01T00:00:00Z"))
      await allocateSequence(s, { scopeId: "s" as never, definition: { name: "n", reset: "year", periodFormat: "none" } })
      expect(s.next).toHaveBeenLastCalledWith("s", "n", "2031")
    } finally { vi.useRealTimers() }
  })
})
