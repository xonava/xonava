import { describe, expect, it, vi } from "vitest"
import { createRng, forAll, type Rng } from "./harness"
import {
  DISAMBIGUATIONS, describeInstant, generateCronExpression, generateDenseCronExpression, generateInstant,
  generateMaybeInvalidExpression, generateZone, surroundWithWhitespace,
} from "./scheduleArbitraries"
import {
  TABLE_END_MS, intlWallClock, oracleInstantsForWallMinute, oracleNext, oracleOccurrences, oracleOffsetMinutes, oracleRejectOutcome,
  oracleTransitions, oracleWallClock, parseOracleCron, wallFromWallMinute, type OracleCron, type OracleDisambiguation,
} from "./scheduleOracle"
import {
  computeScheduleOccurrences, createIntlCronTimezoneAdapter, getNextOccurrence, matchesCron, parseCronExpression, shouldFireSchedule,
} from "../../execution/scheduleCalculator"
import type { CronDisambiguation, ScheduleDefinition } from "../../execution/types"

/**
 * Differential suite for the cron schedule calculator against a brute-force
 * minute-by-minute oracle (scheduleOracle.ts). The oracle shares no code with
 * the production algorithm; see its header for the semantics it encodes.
 */

// Release certification runs every property at a multiple of its base run count.
vi.setConfig({ testTimeout: 120_000 })

const MINUTE = 60_000
const DAY = 86_400_000

function cronOf(expression: string): OracleCron {
  const cron = parseOracleCron(expression)
  if (!cron) throw new Error(`generator produced an expression the oracle rejects: ${expression}`)
  return cron
}

/** `undefined` mode is the production default, which the oracle calls "skip". */
type Mode = OracleDisambiguation | undefined
const modeOptions = (mode: Mode): { disambiguation?: CronDisambiguation } => (mode === undefined ? {} : { disambiguation: mode })
const generateMode = (rng: Rng): Mode => (rng.bool(0.35) ? undefined : rng.pick(DISAMBIGUATIONS))

// ---------------------------------------------------------------------------
// 1. Parsing
// ---------------------------------------------------------------------------

describe("schedule calculator - parsing", () => {
  it("accepts exactly the expressions the oracle accepts and parses them to the same field sets", () => {
    forAll("cron parse accepts exactly the oracle's expressions with identical field sets", generateMaybeInvalidExpression, (expression) => {
      const expected = parseOracleCron(expression)
      let actual: ReturnType<typeof parseCronExpression> | undefined
      let rejected = false
      try {
        actual = parseCronExpression(expression)
      } catch {
        rejected = true
      }
      expect(rejected, `validity of ${JSON.stringify(expression)}`).toBe(expected === null)
      if (!expected || !actual) return
      const indices = (marks: boolean[]): number[] => marks.flatMap((on, index) => (on ? [index] : []))
      expect([...actual.minutes].sort((a, b) => a - b)).toEqual(indices(expected.minute))
      expect([...actual.hours].sort((a, b) => a - b)).toEqual(indices(expected.hour))
      expect([...actual.daysOfMonth].sort((a, b) => a - b)).toEqual(indices(expected.dom))
      expect([...actual.months].sort((a, b) => a - b)).toEqual(indices(expected.month))
      expect([...actual.daysOfWeek].sort((a, b) => a - b)).toEqual(indices(expected.dow))
      expect(actual.daysOfMonthWildcard, "day-of-month star flag").toBe(expected.domStar)
      expect(actual.daysOfWeekWildcard, "day-of-week star flag").toBe(expected.dowStar)
    }, { runs: 800, describe: (expression) => JSON.stringify(expression) })
  })

  it("is insensitive to leading, trailing and repeated whitespace", () => {
    forAll("cron whitespace padding changes neither validity nor the next occurrence", (rng) => {
      const zone = generateZone(rng)
      return { expression: rng.bool(0.8) ? generateDenseCronExpression(rng) : generateMaybeInvalidExpression(rng).split(/\s+/).join(" "), padded: "", zone, after: generateInstant(rng, zone), seed: rng.int(1 << 20) }
    }, (value) => {
      const padded = surroundWithWhitespace(createRng(value.seed), value.expression)
      const attempt = (expression: string): number | null | "invalid" => {
        try {
          return getNextOccurrence(expression, new Date(value.after), value.zone)?.getTime() ?? null
        } catch (error) {
          if ((error as Error).message.includes("Invalid timezone")) throw error
          return "invalid"
        }
      }
      expect(attempt(padded), JSON.stringify(padded)).toBe(attempt(value.expression))
    }, { runs: 100, describe: (value) => JSON.stringify(value) })
  })

  it("matchesCron agrees with the oracle in the process time zone", () => {
    const processZone = new Intl.DateTimeFormat().resolvedOptions().timeZone
    forAll("matchesCron equals oracle wall-clock matching in the process zone", (rng) => ({ expression: generateCronExpression(rng), instant: generateInstant(rng, "UTC") }), ({ expression, instant }) => {
      const cron = cronOf(expression)
      const wall = intlWallClock(processZone, instant)
      const dom = cron.dom[wall.day]!
      const dow = cron.dow[wall.dayOfWeek]!
      const expected = cron.month[wall.month]! && (cron.domStar || cron.dowStar ? dom && dow : dom || dow) && cron.hour[wall.hour]! && cron.minute[wall.minute]!
      expect(matchesCron(new Date(instant), parseCronExpression(expression))).toBe(expected)
    }, { runs: 400, describe: ({ expression, instant }) => `${expression} @ ${describeInstant(instant)}` })
  })
})

// ---------------------------------------------------------------------------
// 2. next occurrence vs brute-force scan
// ---------------------------------------------------------------------------

interface NextCase { expression: string; zone: string; implicitUtc: boolean; after: number; mode: Mode }

function generateNextCase(rng: Rng): NextCase {
  const zone = generateZone(rng)
  const expression = rng.bool(0.6) ? generateDenseCronExpression(rng) : generateCronExpression(rng)
  return { expression, zone, implicitUtc: zone === "UTC" && rng.bool(), after: generateInstant(rng, zone), mode: generateMode(rng) }
}

function* shrinkNextCase<T extends NextCase>(value: T): Generator<T> {
  const fields = value.expression.split(" ")
  for (let index = 0; index < 5; index++) if (fields[index] !== "*") yield { ...value, expression: fields.map((field, position) => (position === index ? "*" : field)).join(" ") }
  if (value.mode !== undefined) yield { ...value, mode: undefined }
  const rounded = Math.floor(value.after / MINUTE) * MINUTE
  if (rounded !== value.after) yield { ...value, after: rounded }
}

const describeNextCase = (value: NextCase): string => `${value.expression} | ${value.implicitUtc ? "(no zone)" : value.zone} | after ${describeInstant(value.after)} | ${value.mode ?? "default"}`

function productionNext(value: NextCase): number | null {
  const date = getNextOccurrence(value.expression, new Date(value.after), value.implicitUtc ? undefined : value.zone, undefined, modeOptions(value.mode))
  return date === null ? null : date.getTime()
}

describe("schedule calculator - next occurrence", () => {
  it("equals the first minute of a brute-force scan, across zones, DST edges, month ends and leap days", () => {
    forAll("getNextOccurrence equals the minute-by-minute oracle", generateNextCase, (value) => {
      const cron = cronOf(value.expression)
      const mode = value.mode ?? "skip"
      const expected = oracleNext({ cron, timeZone: value.zone, afterMs: value.after, disambiguation: mode })
      const actual = productionNext(value)
      if (expected === null && actual !== null) {
        // Beyond the oracle's nine-year horizon (e.g. Feb 29 AND a rare weekday): confirm by scanning up to the answer.
        if (actual > TABLE_END_MS) return
        expect(oracleOccurrences({ cron, timeZone: value.zone, afterMs: value.after, endMs: actual, disambiguation: mode, limit: 1 }).map(describeInstant)).toEqual([describeInstant(actual)])
        return
      }
      expect(actual === null ? null : describeInstant(actual)).toBe(expected === null ? null : describeInstant(expected))
    }, { runs: 600, shrink: shrinkNextCase, describe: describeNextCase })
  })

  it("rejects ambiguous and non-existent matching local times exactly when the oracle meets one", () => {
    forAll("getNextOccurrence with reject disambiguation throws exactly like the oracle", (rng) => ({ ...generateNextCase(rng), mode: undefined as Mode }), (value) => {
      const outcome = oracleRejectOutcome({ cron: cronOf(value.expression), timeZone: value.zone, afterMs: value.after, horizonDays: 9 * 366 })
      let actual: { kind: "instant"; ms: number } | { kind: "error" } | { kind: "none" }
      try {
        const date = getNextOccurrence(value.expression, new Date(value.after), value.zone, undefined, { disambiguation: "reject" })
        actual = date === null ? { kind: "none" } : { kind: "instant", ms: date.getTime() }
      } catch (error) {
        expect((error as Error).message).toMatch(/ambiguous|does not exist/)
        actual = { kind: "error" }
      }
      if (outcome.kind === "none" && actual.kind === "instant") return // beyond the oracle horizon
      expect(actual.kind === "instant" ? describeInstant(actual.ms) : actual.kind).toBe(outcome.kind === "instant" ? describeInstant(outcome.ms) : outcome.kind)
    }, { runs: 400, shrink: shrinkNextCase, describe: describeNextCase })
  })

  it("is a right-continuous step function: every instant in [t, next(t)) maps to next(t), and next(next(t)) > next(t)", () => {
    forAll("next occurrence is a right-continuous step function with minute-aligned results", (rng) => ({ ...generateNextCase(rng), probe: rng.next() / 0x1_0000_0000 }), (value) => {
      const zone = value.implicitUtc ? undefined : value.zone
      const options = modeOptions(value.mode)
      const first = getNextOccurrence(value.expression, new Date(value.after), zone, undefined, options)
      if (first === null) return
      const firstMs = first.getTime()
      expect(firstMs).toBeGreaterThan(value.after)
      expect(firstMs % MINUTE).toBe(0)
      const probe = value.after + Math.floor(value.probe * (firstMs - value.after))
      for (const instant of [probe, firstMs - 1, value.after]) {
        expect(instant, "probe stays in [t, next(t))").toBeLessThan(firstMs)
        expect(getNextOccurrence(value.expression, new Date(instant), zone, undefined, options)?.getTime(), `next(${describeInstant(instant)})`).toBe(firstMs)
      }
      const second = getNextOccurrence(value.expression, first, zone, undefined, options)
      if (second !== null) expect(second.getTime()).toBeGreaterThan(firstMs)
    }, { runs: 400, shrink: shrinkNextCase, describe: describeNextCase })
  })

  it("repeated next() enumerates exactly the oracle's matches in a window: strictly increasing, no duplicates, none skipped", () => {
    forAll("repeated next equals oracle enumeration of a window", (rng) => {
      const zone = generateZone(rng)
      return { expression: generateDenseCronExpression(rng), zone, implicitUtc: false, after: generateInstant(rng, zone), mode: generateMode(rng), days: 1 + rng.int(45) }
    }, (value) => {
      const cron = cronOf(value.expression)
      const end = value.after + value.days * DAY
      const limit = 20
      const expected = oracleOccurrences({ cron, timeZone: value.zone, afterMs: value.after, endMs: end, disambiguation: value.mode ?? "skip", limit })
      const actual: number[] = []
      let cursor = value.after
      while (actual.length < limit) {
        const next = getNextOccurrence(value.expression, new Date(cursor), value.zone, undefined, modeOptions(value.mode))
        if (next === null || next.getTime() > end) break
        expect(next.getTime(), "strictly increasing").toBeGreaterThan(cursor)
        actual.push(next.getTime())
        cursor = next.getTime()
      }
      expect(actual.map(describeInstant)).toEqual(expected.map(describeInstant))
    }, { runs: 150, describe: (value) => `${describeNextCase(value)} | ${value.days}d` })
  })
})

// ---------------------------------------------------------------------------
// 3. computeScheduleOccurrences
// ---------------------------------------------------------------------------

describe("schedule calculator - occurrences in a window", () => {
  it("computeScheduleOccurrences = [nextRunAt if due] + the oracle's later matches up to now, capped at maxCount", () => {
    forAll("computeScheduleOccurrences equals nextRunAt plus oracle matches", (rng) => {
      const zone = generateZone(rng)
      const expression = generateDenseCronExpression(rng)
      const nextRunAt = generateInstant(rng, zone)
      const span = rng.bool(0.1) ? -rng.int(3 * 60) * MINUTE : rng.int(20 * 1440) * MINUTE + rng.int(60_000)
      return { expression, zone, implicitUtc: false, after: nextRunAt, mode: rng.bool(0.5) ? undefined : rng.pick(DISAMBIGUATIONS), span, maxCount: 1 + rng.int(12) }
    }, (value) => {
      const now = value.after + value.span
      const cron = cronOf(value.expression)
      const actual = computeScheduleOccurrences({
        schedule: { cronExpression: value.expression, enabled: true, nextRunAt: new Date(value.after) },
        now: new Date(now), maxCount: value.maxCount, timezone: value.zone, ...(value.mode === undefined ? {} : { disambiguation: value.mode }),
      }).map((date) => date.getTime())
      const expected: number[] = value.after <= now ? [value.after] : []
      if (value.after <= now) {
        expected.push(...oracleOccurrences({ cron, timeZone: value.zone, afterMs: value.after, endMs: now, disambiguation: value.mode ?? "skip", limit: value.maxCount - 1 }))
      }
      expect(actual.map(describeInstant)).toEqual(expected.map(describeInstant))
    }, { runs: 250, describe: (value) => `${describeNextCase(value)} | span ${value.span} | max ${value.maxCount}` })
  })

  it("returns nothing for a disabled schedule or a missing nextRunAt, and rejects non-positive or non-integer maxCount", () => {
    forAll("computeScheduleOccurrences guards", (rng) => ({ enabled: rng.bool(), hasNext: rng.bool(), maxCount: rng.pick([0, -1, 1, 2, 5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2, 3]) }), ({ enabled, hasNext, maxCount }) => {
      const run = () => computeScheduleOccurrences({
        schedule: { cronExpression: "*/5 * * * *", enabled, nextRunAt: hasNext ? new Date(Date.UTC(2026, 0, 1)) : null },
        now: new Date(Date.UTC(2026, 0, 1, 1)), maxCount,
      })
      if (!Number.isSafeInteger(maxCount) || maxCount < 1) {
        expect(run).toThrow(/maxCount/)
        return
      }
      const result = run()
      if (!enabled || !hasNext) expect(result).toEqual([])
      else expect(result).toHaveLength(Math.min(maxCount, 13))
    }, { runs: 100 })
  })
})

// ---------------------------------------------------------------------------
// 4. Time zone adapter
// ---------------------------------------------------------------------------

describe("schedule calculator - Intl time zone adapter", () => {
  const adapter = createIntlCronTimezoneAdapter()

  it("toLocalDateTimeParts returns the wall clock (including weekday) that Intl reports", () => {
    forAll("adapter toLocalDateTimeParts equals oracle wall clock", (rng) => {
      const zone = generateZone(rng)
      return { zone, instant: generateInstant(rng, zone) }
    }, ({ zone, instant }) => {
      const actual = adapter.toLocalDateTimeParts(new Date(instant), zone)
      expect(actual).toEqual(oracleWallClock(zone, instant))
      expect(actual).toEqual(intlWallClock(zone, instant))
    }, { runs: 400, describe: ({ zone, instant }) => `${zone} @ ${describeInstant(instant)}` })
  })

  it("the oracle's offset table agrees with Intl at every transition boundary", () => {
    for (const zone of ["America/New_York", "Europe/London", "Australia/Lord_Howe", "Pacific/Chatham", "America/Sao_Paulo"]) {
      const transitions = oracleTransitions(zone)
      expect(transitions.length, zone).toBeGreaterThan(zone === "America/Sao_Paulo" ? 6 : 20)
      for (const transition of transitions.slice(0, 80)) {
        for (const delta of [-MINUTE, 0, MINUTE]) {
          expect(oracleWallClock(zone, transition + delta), `${zone} ${describeInstant(transition + delta)}`).toEqual(intlWallClock(zone, transition + delta))
        }
      }
    }
    expect(oracleOffsetMinutes("Australia/Lord_Howe", Date.UTC(2026, 0, 15))).toBe(11 * 60)
    expect(oracleOffsetMinutes("Australia/Lord_Howe", Date.UTC(2026, 6, 15))).toBe(10.5 * 60)
    expect(oracleOffsetMinutes("Pacific/Chatham", Date.UTC(2026, 0, 15))).toBe(13 * 60 + 45)
  })

  it("localToUtc resolves gaps, overlaps and unique local times as the oracle does", () => {
    forAll("adapter localToUtc equals oracle wall-minute inversion", (rng) => {
      const zone = generateZone(rng)
      const anchor = generateInstant(rng, zone)
      return { zone, wallMinute: Math.floor(anchor / MINUTE) + oracleOffsetMinutes(zone, anchor) + rng.int(241) - 120, mode: rng.pick(["skip", "earlier", "later", "reject", undefined] as const) }
    }, ({ zone, wallMinute, mode }) => {
      const instants = oracleInstantsForWallMinute(zone, wallMinute)
      const local = wallFromWallMinute(wallMinute)
      const call = () => adapter.localToUtc(local, zone, mode)
      if (mode === "reject" && instants.length !== 1) {
        expect(call).toThrow()
        return
      }
      const date = call()
      if (instants.length === 0) {
        expect(Number.isNaN(date.getTime()), "gap yields an invalid date").toBe(true)
        return
      }
      const expected = mode === "later" ? instants[instants.length - 1]! : instants[0]!
      expect(describeInstant(date.getTime())).toBe(describeInstant(expected))
    }, { runs: 500, describe: ({ zone, wallMinute, mode }) => `${zone} wall ${describeInstant(wallMinute * MINUTE)} (as UTC) ${mode ?? "default"}` })
  })

  it("rejects an unknown time zone with a ValidationError", () => {
    expect(() => getNextOccurrence("* * * * *", new Date(0), "Mars/Olympus")).toThrow(/Invalid timezone/)
  })
})

// ---------------------------------------------------------------------------
// 4b. Invalid dates
// ---------------------------------------------------------------------------

describe("schedule calculator - invalid dates", () => {
  it("an Invalid Date is rejected instead of being read as 'not due' or 'always due'", () => {
    forAll("schedule calculator rejects Invalid Date inputs", (rng) => ({
      zone: rng.pick([undefined, "UTC", "America/New_York", "Asia/Kolkata"]),
      expression: generateDenseCronExpression(rng),
      which: rng.pick(["after", "now", "nextRunAt", "fireNow", "fireNextRunAt"] as const),
      maxCount: 1 + rng.int(5),
    }), ({ zone, expression, which, maxCount }) => {
      const invalid = new Date(Number.NaN)
      const valid = new Date(Date.UTC(2026, 5, 1))
      const schedule = { cronExpression: expression, timezone: zone ?? "UTC", enabled: true, misfirePolicy: { type: "fire_now" as const }, overlapPolicy: { type: "allow" as const }, lastRunAt: null, lastStatus: null }
      switch (which) {
        case "after":
          expect(() => getNextOccurrence(expression, invalid, zone)).toThrow(/valid Date/)
          break
        case "now":
          expect(() => computeScheduleOccurrences({ schedule: { cronExpression: expression, enabled: true, nextRunAt: valid }, now: invalid, maxCount, ...(zone === undefined ? {} : { timezone: zone }) })).toThrow(/valid Date/)
          break
        case "nextRunAt":
          expect(() => computeScheduleOccurrences({ schedule: { cronExpression: expression, enabled: true, nextRunAt: invalid }, now: valid, maxCount, ...(zone === undefined ? {} : { timezone: zone }) })).toThrow(/valid Date/)
          break
        case "fireNow":
          expect(() => shouldFireSchedule({ schedule: { ...schedule, nextRunAt: valid }, now: invalid })).toThrow(/valid Date/)
          break
        case "fireNextRunAt":
          expect(() => shouldFireSchedule({ schedule: { ...schedule, nextRunAt: invalid }, now: valid })).toThrow(/valid Date/)
          break
      }
    }, { runs: 60 })
  })
})

// ---------------------------------------------------------------------------
// 5. shouldFireSchedule decision table
// ---------------------------------------------------------------------------

describe("schedule calculator - fire decision", () => {
  it("shouldFireSchedule follows the documented decision table", () => {
    forAll("shouldFireSchedule decision table", (rng) => ({
      enabled: rng.bool(0.9),
      hasNext: rng.bool(0.95),
      lagMs: rng.pick([-1, 0, 1, 59 * MINUTE, 60 * MINUTE - 1, 60 * MINUTE, 60 * MINUTE + 1, 61 * MINUTE, 5 * DAY]),
      misfire: rng.pick(["skip", "fire_now", "queue_all"] as const),
      overlap: rng.pick(["allow", "skip", "queue"] as const),
      prior: rng.pick([undefined, null, "queued", "running", "completed", "failed", "cancelled"] as const),
      lastStatus: rng.pick([null, "running", "fired", "failed", "skipped"] as const),
    }), (value) => {
      const nextRunAt = new Date(Date.UTC(2026, 5, 1))
      const now = new Date(nextRunAt.getTime() + value.lagMs)
      const schedule: Pick<ScheduleDefinition, "cronExpression" | "timezone" | "enabled" | "misfirePolicy" | "overlapPolicy" | "nextRunAt" | "lastRunAt" | "lastStatus"> = {
        cronExpression: "* * * * *", timezone: "UTC", enabled: value.enabled, misfirePolicy: { type: value.misfire }, overlapPolicy: { type: value.overlap },
        nextRunAt: value.hasNext ? nextRunAt : null, lastRunAt: null, lastStatus: value.lastStatus,
      }
      const decision = shouldFireSchedule({ schedule, now, ...(value.prior === undefined ? {} : { priorExecutionStatus: value.prior }) })
      let expected: string
      if (!value.enabled || !value.hasNext || value.lagMs < 0) expected = "ignore"
      else if (value.misfire === "skip" && value.lagMs > 60 * MINUTE) expected = "skip"
      else if (value.overlap === "queue") expected = "queue"
      else if (value.overlap === "allow") expected = "fire"
      else {
        const busy = value.prior === "queued" || value.prior === "running" || ((value.prior === undefined || value.prior === null) && value.lastStatus === "running")
        expected = busy ? "skip" : "fire"
      }
      expect(decision).toBe(expected)
    }, { runs: 400 })
  })
})

describe("schedule calculator - years 0-99", () => {
  // Date.UTC(year, ...) maps years 0-99 to 1900-1999; the calendar walk must treat them as the years they are.
  const earlyInstant = (rng: Rng): number => {
    const date = new Date(0)
    const year = rng.bool(0.3) ? rng.pick([1, 4, 96, 99, 100]) : 1 + rng.int(199)
    date.setUTCFullYear(year, rng.bool(0.4) ? rng.pick([1, 11]) : rng.int(12), rng.bool(0.4) ? rng.pick([27, 28, 29, 30]) : 1 + rng.int(28))
    date.setUTCHours(rng.int(24), rng.int(60), 0, 0)
    return date.getTime()
  }
  it("equals the brute-force oracle for UTC searches that start in the first two centuries", () => {
    forAll("getNextOccurrence equals the oracle for UTC instants in years 1-199", (rng) => ({ expression: generateDenseCronExpression(rng), after: earlyInstant(rng) }), ({ expression, after }) => {
      const cron = cronOf(expression)
      const actual = getNextOccurrence(expression, new Date(after))
      const expected = oracleNext({ cron, timeZone: "UTC", afterMs: after })
      if (expected === null && actual !== null) {
        // Beyond the oracle's horizon (e.g. Feb 29 AND a rare weekday): confirm by scanning up to the answer.
        expect(oracleOccurrences({ cron, timeZone: "UTC", afterMs: after, endMs: actual.getTime(), limit: 1 })).toEqual([actual.getTime()])
        return
      }
      expect(actual === null ? null : actual.getTime()).toBe(expected)
    }, { runs: 150, describe: ({ expression, after }) => `${expression} | after ${new Date(after).toISOString()}` })
  })
})
