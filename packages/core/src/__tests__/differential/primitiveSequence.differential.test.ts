import { describe, expect, it } from "vitest"
import { forAll, forAllAsync, type Rng } from "./harness"
import { ConfigurationError } from "../../domain/errors"
import { allocateSequence, sequencePeriod, validateSequenceDefinition } from "../../sequence/sequence"
import type { SequenceDefinition, SequenceResetPeriod, SequenceStore } from "../../sequence/types"
import type { ExecutionScopeId } from "../../domain"

/**
 * Sequence period bucketing is compared with an offset-based oracle: the
 * zone's UTC offset at the instant is read through a different Intl facility
 * (`timeZoneName: "longOffset"`) and the local calendar date is then computed
 * with plain Date arithmetic, instead of formatting the date parts as the
 * implementation does.
 */

const ZONES = [
  "UTC", "Etc/UTC", "utc", "Etc/GMT+12", "Etc/GMT-14", "Asia/Kolkata", "Asia/Kathmandu", "America/New_York", "America/St_Johns",
  "Europe/London", "Europe/Berlin", "Australia/Lord_Howe", "Pacific/Kiritimati", "Pacific/Pago_Pago", "Pacific/Apia", "Africa/Casablanca", "America/Sao_Paulo",
] as const

const offsetFormatters = new Map<string, Intl.DateTimeFormat>()

/** Zone offset in ms at the instant, parsed from "GMT", "GMT+05:30" or "GMT-03:30:12". */
function offsetMs(timeZone: string, at: number): number {
  let formatter = offsetFormatters.get(timeZone)
  if (!formatter) { formatter = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }); offsetFormatters.set(timeZone, formatter) }
  const name = formatter.formatToParts(at).find((part) => part.type === "timeZoneName")!.value
  if (name === "GMT") return 0
  const match = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(name.replace("−", "-"))
  if (!match) throw new Error(`unparseable offset ${name}`)
  const total = (Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4] ?? 0)) * 1000
  return match[1] === "-" ? -total : total
}

/** Local calendar date via offset arithmetic; null when the local year is before 1 CE; undefined when the local date is beyond what Date arithmetic can express (no verdict). */
function oraclePeriod(reset: SequenceResetPeriod, at: number, timeZone: string): string | null | undefined {
  if (reset === "never") return "all"
  const local = new Date(at + offsetMs(timeZone, at))
  if (Number.isNaN(local.getTime())) return at > 0 ? undefined : null
  const year = local.getUTCFullYear()
  if (year < 1) return null
  const pad = (n: number, width: number): string => String(n).padStart(width, "0")
  const y = pad(year, 4)
  if (reset === "year") return y
  if (reset === "month") return `${y}-${pad(local.getUTCMonth() + 1, 2)}`
  return `${y}-${pad(local.getUTCMonth() + 1, 2)}-${pad(local.getUTCDate(), 2)}`
}

const MS_HOUR = 3_600_000

function generateInstant(rng: Rng): number {
  const roll = rng.int(12)
  if (roll === 0) return rng.pick([-8.64e15, 8.64e15, Date.UTC(1, 0, 1), Date.UTC(1, 0, 1) - 1, Date.UTC(0, 0, 1), 0, -1, Date.UTC(1970, 0, 1) - 1, Date.UTC(9999, 11, 31, 23, 59, 59, 999), Date.UTC(10000, 0, 1)])
  if (roll < 5) {
    // Around a UTC year / month / day boundary, ± up to 15 hours so every zone's local midnight is covered.
    const year = rng.pick([1, 4, 100, 400, 1600, 1900, 1969, 1999, 2000, 2023, 2024, 2025, 2026, 2100, 9999])
    const month = rng.pick([0, 0, 1, 1, 2, 11, rng.int(12)])
    const day = rng.pick([1, 1, 28, 29, 30, 31, 1 + rng.int(31)])
    const base = new Date(Date.UTC(2000, month, day, 0, 0, 0, 0))
    base.setUTCFullYear(year)
    return base.getTime() + (rng.int(31) - 15) * MS_HOUR + rng.pick([-1, 0, 1, 59_999, 60_000, rng.int(MS_HOUR)])
  }
  if (roll < 8) return Date.UTC(2020, 0, 1) + rng.int(10 * 365 * 24) * MS_HOUR + rng.int(MS_HOUR) // DST transitions of the 2020s
  return Date.UTC(1800, 0, 1) + rng.int(400 * 365 * 24) * MS_HOUR + rng.int(MS_HOUR)
}

describe("sequence period bucketing", () => {
  it("sequencePeriod ≡ offset-arithmetic oracle across zones, DST, leap days and calendar extremes", () => {
    forAll("sequence period vs offset oracle", (rng) => ({
      reset: rng.pick(["never", "year", "month", "day"] as const),
      zone: rng.pick(ZONES),
      at: generateInstant(rng),
    }), (c) => {
      const expected = oraclePeriod(c.reset, c.at, c.zone)
      if (expected === undefined) return
      if (expected === null) expect(() => sequencePeriod(c.reset, new Date(c.at), c.zone), "local year before 1 CE").toThrow(ConfigurationError)
      else expect(sequencePeriod(c.reset, new Date(c.at), c.zone)).toBe(expected)
    }, { runs: 600, describe: (c) => `${JSON.stringify(c)} (${Number.isNaN(new Date(c.at).getTime()) ? "invalid" : new Date(c.at).toISOString()})` })
  })

  it("periods are nested and non-decreasing in time for a fixed zone", () => {
    forAll("sequence periods nest and are monotone", (rng) => ({
      zone: rng.pick(ZONES),
      instants: Array.from({ length: 6 }, () => Date.UTC(1950, 0, 1) + rng.int(150 * 365 * 24) * MS_HOUR + rng.int(MS_HOUR)).sort((a, b) => a - b),
    }), (c) => {
      let previous: [string, string, string] | undefined
      for (const at of c.instants) {
        const date = new Date(at)
        const current: [string, string, string] = [sequencePeriod("year", date, c.zone), sequencePeriod("month", date, c.zone), sequencePeriod("day", date, c.zone)]
        expect(current[1].startsWith(current[0] + "-")).toBe(true)
        expect(current[2].startsWith(current[1] + "-")).toBe(true)
        expect(current[0]).toMatch(/^\d{4}$/)
        expect(current[1]).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/)
        expect(current[2]).toMatch(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)
        if (previous) for (let i = 0; i < 3; i++) expect(current[i]! >= previous[i]!, `level ${i}: ${previous[i]} -> ${current[i]}`).toBe(true)
        previous = current
      }
    }, { runs: 150, describe: (c) => JSON.stringify(c) })
  })

  it("an invalid allocation time is a ConfigurationError, never a bogus period", () => {
    forAll("sequence invalid allocation time", (rng) => ({ value: rng.pick([new Date(NaN), new Date(8.64e15 + 1), "2026-01-01", 0, null, undefined, {}] as unknown[]), reset: rng.pick(["year", "month", "day"] as const) }), (c) => {
      expect(() => sequencePeriod(c.reset, c.value as Date)).toThrow(ConfigurationError)
    }, { runs: 60, describe: (c) => String(c.value) })
  })
})

// ------------------------------------------------------------ definition validation oracle

interface DefinitionDraft { def: Record<string, unknown> }

const NAME_CHARS = "AZaz09._:-/ !é"
const PREFIX_CHARS = "AZaz09._/: -!é\n"

function randomString(rng: Rng, chars: string, max: number): string {
  const length = rng.int(max + 1)
  let out = ""
  for (let i = 0; i < length; i++) out += chars[rng.int(chars.length)]
  return out
}

function oracleDefinitionValid(def: Record<string, unknown>): boolean {
  const inSet = (text: string, allowed: (ch: string) => boolean): boolean => [...text].every(allowed)
  const alnum = (ch: string): boolean => /^[A-Za-z0-9]$/.test(ch)
  const name = def.name
  if (typeof name !== "string" || name.length < 1 || name.length > 128 || !alnum(name[0]!) || !inSet(name, (ch) => alnum(ch) || ".:_-".includes(ch))) return false
  const padding = def.padding ?? 0
  if (typeof padding !== "number" || !Number.isSafeInteger(padding) || padding < 0 || padding > 32) return false
  const reset = def.reset ?? "never"
  if (!["never", "year", "month", "day"].includes(reset as string)) return false
  if (def.prefix !== undefined && (typeof def.prefix !== "string" || def.prefix.length > 64 || !inSet(def.prefix, (ch) => alnum(ch) || "._/: -".includes(ch)))) return false
  const zone = def.timeZone ?? "UTC"
  if (typeof zone !== "string" || zone.length > 64) return false
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }) } catch { return false }
  if (reset !== "never" && def.periodFormat === undefined) return false
  const format = def.periodFormat ?? "none"
  if (!["none", "compact", "iso"].includes(format as string)) return false
  if (format !== "none" && reset === "never") return false
  const separator = def.periodSeparator ?? "-"
  if (typeof separator !== "string" || separator.length > 4 || !inSet(separator, (ch) => alnum(ch) || "._/: -".includes(ch))) return false
  return true
}

function generateDefinition(rng: Rng): DefinitionDraft {
  const def: Record<string, unknown> = {}
  const wild = rng.bool(0.3)
  def.name = rng.bool(wild ? 0.25 : 0.03) ? rng.pick([undefined, null, 5, ["a"], { toString: () => "ok" }, "", "-lead", "a".repeat(129), "a".repeat(128)] as unknown[]) : rng.bool(0.7) ? "inv" : randomString(rng, NAME_CHARS, 6)
  if (rng.bool(0.5)) def.padding = rng.bool(wild ? 0.3 : 0.05) ? rng.pick([-1, 33, 1.5, NaN, "3", null, Number.MAX_SAFE_INTEGER + 1]) : rng.pick([0, 1, 5, 32])
  if (rng.bool(0.6)) def.reset = rng.bool(wild ? 0.2 : 0.03) ? rng.pick(["week", "YEAR", 5, null]) : rng.pick(["never", "year", "month", "day"])
  if (rng.bool(0.4)) def.prefix = rng.bool(wild ? 0.25 : 0.04) ? rng.pick([5, null, ["a"], "x".repeat(65), randomString(rng, PREFIX_CHARS, 5)] as unknown[]) : rng.pick(["", "INV-", "A/B: "])
  if (rng.bool(0.5)) def.timeZone = rng.pick([...ZONES, "Mars/Base", "", "x".repeat(65), 5, null, "+05:00", "Etc/GMT+5", "america/new_york"] as unknown[])
  if (rng.bool(0.7)) def.periodFormat = rng.bool(wild ? 0.2 : 0.03) ? rng.pick(["short", "ISO", 1, null]) : rng.pick(["none", "compact", "iso"])
  if (rng.bool(0.4)) def.periodSeparator = rng.bool(wild ? 0.25 : 0.04) ? rng.pick(["abcde", 5, null, "\n", "é", ["-"]] as unknown[]) : rng.pick(["", "-", "/", " ", "ab", "._/:"])
  return { def }
}

describe("sequence definition validation", () => {
  it("validateSequenceDefinition accepts exactly the documented definitions (periodFormat rules, name/prefix/zone/padding bounds, untyped input)", () => {
    forAll("sequence definition validity", generateDefinition, ({ def }) => {
      const valid = oracleDefinitionValid(def)
      let result: unknown
      let thrown: unknown
      try { result = validateSequenceDefinition(def as unknown as SequenceDefinition) } catch (error) { thrown = error }
      if (valid) {
        expect(thrown, "valid definition rejected").toBeUndefined()
        const out = result as Record<string, unknown>
        expect(out.padding).toBe(def.padding ?? 0)
        expect(out.reset).toBe(def.reset ?? "never")
        expect(out.periodFormat).toBe(def.periodFormat ?? "none")
        expect(out.periodSeparator).toBe(def.periodSeparator ?? "-")
        expect(out.timeZone).toBe(def.timeZone ?? "UTC")
        expect(out.name).toBe(def.name)
        expect(Object.isFrozen(out)).toBe(true)
      } else expect(thrown, "invalid definition accepted").toBeInstanceOf(ConfigurationError)
    }, { runs: 600, describe: (d) => JSON.stringify(d.def, (_k, v: unknown) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v === undefined ? "<undefined>" : v)) })
  })
})

// ------------------------------------------------------------ allocation and formatting

describe("sequence allocation formatting", () => {
  const scopeId = "scope-1" as ExecutionScopeId

  it("formatted value = prefix + period token + zero-padded number; the number round-trips and distinct (period, value) pairs never share a formatted value", async () => {
    await forAllAsync("sequence formatting round trip", (rng) => {
      const reset = rng.pick(["never", "year", "month", "day"] as const)
      const definition: SequenceDefinition = {
        name: "inv",
        ...(rng.bool(0.6) ? { prefix: rng.pick(["", "INV-", "2026-", "A", "9", "X/", "Q 3:"]) } : {}),
        padding: rng.pick([0, 0, 1, 3, 6, 32]),
        reset,
        ...(reset === "never" ? (rng.bool(0.5) ? { periodFormat: "none" as const } : {}) : { periodFormat: rng.pick(["none", "compact", "iso"] as const) }),
        ...(rng.bool(0.5) ? { periodSeparator: rng.pick(["", "-", "/", "ab", "0", "12"]) } : {}),
        timeZone: rng.pick(ZONES),
      }
      return {
        definition,
        draws: Array.from({ length: 12 }, () => ({
          at: Date.UTC(1000, 0, 1) + rng.int(9000 * 365) * 24 * MS_HOUR + rng.int(24 * MS_HOUR),
          value: rng.pick([1, 2, 9, 10, 11, 99, 100, 123456, Number.MAX_SAFE_INTEGER, 1 + rng.int(50)]),
        })),
      }
    }, async (c) => {
      const seen = new Map<string, string>()
      for (const draw of c.draws) {
        const store: SequenceStore = { next: async () => draw.value }
        const out = await allocateSequence(store, { scopeId, definition: c.definition, at: new Date(draw.at) })
        const period = sequencePeriod(c.definition.reset ?? "never", new Date(draw.at), c.definition.timeZone ?? "UTC")
        expect(out.period).toBe(period)
        expect(out.value).toBe(draw.value)
        const prefix = c.definition.prefix ?? ""
        const format = c.definition.periodFormat ?? "none"
        const separator = c.definition.periodSeparator ?? "-"
        const token = format === "none" ? "" : `${format === "compact" ? period.replaceAll("-", "") : period}${separator}`
        const digits = String(draw.value).padStart(c.definition.padding ?? 0, "0")
        expect(out.formatted).toBe(prefix + token + digits)
        // Stripping what the format added must give back the exact stored number (padding never truncates or alters it).
        const tail = out.formatted.slice(prefix.length + token.length)
        expect(tail.length).toBeGreaterThanOrEqual(String(draw.value).length)
        expect(Number(tail)).toBe(draw.value)
        // Uniqueness: a resetting counter that embeds its period must not repeat a formatted value for different (period, value).
        if (format !== "none") {
          const key = `${period}#${draw.value}`
          const prior = seen.get(out.formatted)
          if (prior !== undefined) expect(prior, `formatted ${out.formatted} produced by two different allocations`).toBe(key)
          seen.set(out.formatted, key)
        }
      }
    }, { runs: 200, describe: (c) => JSON.stringify(c) })
  })

  it("passes exactly the computed period to the store, prefers the explicit instant over the clock, and rejects invalid store values and scopes", async () => {
    await forAllAsync("sequence allocation contract", (rng) => ({
      at: rng.bool(0.6) ? Date.UTC(2000, 0, 1) + rng.int(30 * 365) * 24 * MS_HOUR : undefined,
      clock: Date.UTC(2000, 0, 1) + rng.int(30 * 365) * 24 * MS_HOUR,
      reset: rng.pick(["never", "year", "month", "day"] as const),
      value: rng.pick([1, 2, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, "3", null, undefined] as unknown[]),
      scope: rng.pick(["ok", "", "a".repeat(1024), "a".repeat(1025), "a\0b", "a\nb", "a\rb", 5, null] as unknown[]),
    }), async (c) => {
      const calls: unknown[][] = []
      const store: SequenceStore = { next: async (...args) => { calls.push(args); return c.value as number } }
      const request = { scopeId: c.scope as ExecutionScopeId, definition: { name: "n", reset: c.reset, ...(c.reset === "never" ? {} : { periodFormat: "iso" as const }) }, ...(c.at !== undefined ? { at: new Date(c.at) } : {}) }
      const scopeOk = typeof c.scope === "string" && c.scope.length > 0 && c.scope.length <= 1024 && !/[\0\r\n]/.test(c.scope)
      const valueOk = typeof c.value === "number" && Number.isSafeInteger(c.value) && c.value >= 1
      const outcome = await allocateSequence(store, request, () => new Date(c.clock)).then((value) => ({ value }), (error: unknown) => ({ error }))
      if (!scopeOk) { expect((outcome as { error: unknown }).error).toBeInstanceOf(ConfigurationError); expect(calls).toEqual([]); return }
      const period = sequencePeriod(c.reset, new Date(c.at ?? c.clock))
      expect(calls).toEqual([[c.scope, "n", period]])
      if (!valueOk) expect((outcome as { error: unknown }).error).toBeInstanceOf(ConfigurationError)
      else expect((outcome as { value: { value: number } }).value.value).toBe(c.value)
    }, { runs: 200, describe: (c) => JSON.stringify(c, (_k, v: unknown) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v === undefined ? "<undefined>" : v)) })
  })
})

describe("sequence module sanity", () => {
  it("is deterministic", () => { expect(sequencePeriod("day", new Date(0), "UTC")).toBe("1970-01-01") })
})
