/**
 * Independent reference model for cron schedules (scheduleCalculator.ts).
 *
 * Nothing here shares code with the production calculator. The oracle is a
 * brute-force scan over UTC minutes: for every minute it derives the wall-clock
 * fields in the schedule's IANA zone and tests them against the cron fields.
 *
 * Wall-clock fields come from `Intl.DateTimeFormat`, but only while building a
 * per-zone offset table (sampled every few hours and bisected to the minute at
 * every offset change). The scan itself then uses the table plus plain integer
 * calendar arithmetic, so a multi-year search stays fast. `intlWallMinute` is
 * exported so a property can cross-check the table against Intl directly.
 *
 * Semantics (docs/spec/execution.md is silent on cron details, so these follow
 * Vixie cron and the production comments):
 *  - five fields: minute hour day-of-month month day-of-week; day-of-week 0..7, 7 == 0
 *  - a part is `*`, `n`, `a-b`, each optionally followed by `/step` (`n/step` means n..max)
 *  - a day field whose text STARTS with `*` is "star-flagged"; if either day field is
 *    star-flagged the day matches when BOTH day fields match, otherwise when EITHER does
 *  - a wall-clock minute that does not exist (DST gap) never fires
 *  - a wall-clock minute that occurs twice (overlap) fires at the earliest instant
 *    ("skip" / "earlier"), at the latest ("later"), or is an error ("reject")
 */

const MINUTE = 60_000

export const ORACLE_ZONES = [
  "UTC",
  "America/New_York",
  "Europe/London",
  "Australia/Lord_Howe",
  "Asia/Kolkata",
  "Pacific/Chatham",
  "America/Sao_Paulo",
] as const

export type OracleDisambiguation = "skip" | "earlier" | "later"

export interface OracleCron {
  minute: boolean[]
  hour: boolean[]
  dom: boolean[]
  month: boolean[]
  /** Indexed 0..6 (Sunday == 0); 7 is folded into 0. */
  dow: boolean[]
  domStar: boolean
  dowStar: boolean
}

const DIGITS = /^[0-9]+$/

function parseOracleField(field: string, min: number, max: number): boolean[] | null {
  const marks: boolean[] = Array.from({ length: max + 1 }, () => false)
  for (const part of field.split(",")) {
    const pieces = part.split("/")
    if (pieces.length > 2) return null
    const base = pieces[0]!
    const stepText = pieces[1]
    let low: number
    let high: number
    if (base === "*") {
      low = min
      high = max
    } else {
      const bounds = base.split("-")
      if (bounds.length > 2 || !bounds.every((bound) => DIGITS.test(bound))) return null
      low = Number(bounds[0])
      high = bounds.length === 2 ? Number(bounds[1]) : stepText === undefined ? low : max
    }
    let step = 1
    if (stepText !== undefined) {
      if (!DIGITS.test(stepText)) return null
      step = Number(stepText)
      if (step < 1) return null
    }
    if (low < min || high > max || low > high) return null
    for (let value = low; value <= high; value += step) marks[value] = true
  }
  return marks
}

/** Returns null for any expression the specification rejects. */
export function parseOracleCron(expression: string): OracleCron | null {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const minute = parseOracleField(fields[0]!, 0, 59)
  const hour = parseOracleField(fields[1]!, 0, 23)
  const dom = parseOracleField(fields[2]!, 1, 31)
  const month = parseOracleField(fields[3]!, 1, 12)
  const dowRaw = parseOracleField(fields[4]!, 0, 7)
  if (!minute || !hour || !dom || !month || !dowRaw) return null
  const dow = Array.from({ length: 7 }, (_, day) => dowRaw[day]! || (day === 0 && dowRaw[7]!))
  return { minute, hour, dom, month, dow, domStar: fields[2]!.startsWith("*"), dowStar: fields[4]!.startsWith("*") }
}

// ---------------------------------------------------------------------------
// Calendar arithmetic (no Date involved)
// ---------------------------------------------------------------------------

/** Proleptic Gregorian civil date for a day count since 1970-01-01. */
export function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468
  const era = Math.floor(z / 146097)
  const dayOfEra = z - era * 146097
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365)
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100))
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153)
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1
  const month = monthPrime < 10 ? monthPrime + 3 : monthPrime - 9
  return { year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day }
}

export function weekdayOfDays(days: number): number {
  return (((days + 4) % 7) + 7) % 7
}

export interface OracleWallClock { year: number; month: number; day: number; hour: number; minute: number; dayOfWeek: number }

export function wallFromWallMinute(wallMinute: number): OracleWallClock {
  const days = Math.floor(wallMinute / 1440)
  const minuteOfDay = wallMinute - days * 1440
  return { ...civilFromDays(days), hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60, dayOfWeek: weekdayOfDays(days) }
}

// ---------------------------------------------------------------------------
// Offset tables
// ---------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>()

/** Wall-clock minute (minutes since 1970-01-01T00:00 wall time) of an instant, straight from Intl. */
export function intlWallMinute(timeZone: string, minuteIndex: number): number {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
    formatters.set(timeZone, formatter)
  }
  const parts: Record<string, number> = {}
  for (const part of formatter.formatToParts(new Date(minuteIndex * MINUTE))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value)
  }
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour! % 24, parts.minute!) / MINUTE
}

export function intlWallClock(timeZone: string, instantMs: number): OracleWallClock {
  return wallFromWallMinute(intlWallMinute(timeZone, Math.floor(instantMs / MINUTE)))
}

interface OffsetTable {
  /** Minute index at which each segment begins (ascending). */
  starts: number[]
  /** UTC offset in minutes of each segment. */
  offsets: number[]
  /** The distinct values of `offsets`. */
  distinct: number[]
}

export const TABLE_START_MS = Date.UTC(2015, 0, 1)
export const TABLE_END_MS = Date.UTC(2043, 0, 1)
const SAMPLE_STEP_MINUTES = 360

const tables = new Map<string, OffsetTable>()

function buildTable(timeZone: string): OffsetTable {
  const offsetAt = (minuteIndex: number): number => intlWallMinute(timeZone, minuteIndex) - minuteIndex
  const startMinute = TABLE_START_MS / MINUTE
  const endMinute = TABLE_END_MS / MINUTE
  let previous = offsetAt(startMinute)
  const starts = [startMinute]
  const offsets = [previous]
  for (let minute = startMinute + SAMPLE_STEP_MINUTES; minute <= endMinute; minute += SAMPLE_STEP_MINUTES) {
    const offset = offsetAt(minute)
    if (offset === previous) continue
    let low = minute - SAMPLE_STEP_MINUTES
    let high = minute
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2)
      if (offsetAt(middle) === previous) low = middle
      else high = middle
    }
    starts.push(high)
    offsets.push(offset)
    previous = offset
  }
  return { starts, offsets, distinct: [...new Set(offsets)] }
}

function tableFor(timeZone: string): OffsetTable {
  let table = tables.get(timeZone)
  if (!table) {
    table = buildTable(timeZone)
    tables.set(timeZone, table)
  }
  return table
}

function segmentIndex(table: OffsetTable, minuteIndex: number): number {
  let low = 0
  let high = table.starts.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (table.starts[middle]! <= minuteIndex) low = middle
    else high = middle - 1
  }
  return low
}

export function oracleOffsetMinutes(timeZone: string, instantMs: number): number {
  const table = tableFor(timeZone)
  return table.offsets[segmentIndex(table, Math.floor(instantMs / MINUTE))]!
}

export function oracleWallClock(timeZone: string, instantMs: number): OracleWallClock {
  const minuteIndex = Math.floor(instantMs / MINUTE)
  return wallFromWallMinute(minuteIndex + oracleOffsetMinutes(timeZone, instantMs))
}

/** Instants (ms) at which the zone's offset changes, within the table range. */
export function oracleTransitions(timeZone: string): number[] {
  return tableFor(timeZone).starts.slice(1).map((minute) => minute * MINUTE)
}

/** Every instant (minute-aligned ms, ascending) whose wall clock is `wallMinute`; empty in a DST gap. */
export function oracleInstantsForWallMinute(timeZone: string, wallMinute: number): number[] {
  const table = tableFor(timeZone)
  const found = new Set<number>()
  for (const offset of table.distinct) {
    const candidate = wallMinute - offset
    if (table.offsets[segmentIndex(table, candidate)] === offset) found.add(candidate * MINUTE)
  }
  return [...found].sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// Brute-force scan
// ---------------------------------------------------------------------------

function dayMatches(cron: OracleCron, wall: OracleWallClock): boolean {
  if (!cron.month[wall.month]) return false
  const domOk = cron.dom[wall.day]!
  const dowOk = cron.dow[wall.dayOfWeek]!
  return cron.domStar || cron.dowStar ? domOk && dowOk : domOk || dowOk
}

/**
 * All matching instants t with after < t <= end, ascending, at most `limit`.
 * Scans every UTC minute (skipping wall-clock days whose date cannot match,
 * which is exact because the date fields are constant within a wall day).
 */
export function oracleOccurrences(args: {
  cron: OracleCron
  timeZone: string
  afterMs: number
  endMs: number
  disambiguation?: OracleDisambiguation
  limit?: number
}): number[] {
  const { cron, timeZone, afterMs, endMs } = args
  const mode = args.disambiguation ?? "skip"
  const limit = args.limit ?? Number.POSITIVE_INFINITY
  const table = tableFor(timeZone)
  const results: number[] = []
  const endMinute = Math.floor(endMs / MINUTE)
  let minute = Math.floor(afterMs / MINUTE) + 1
  let index = segmentIndex(table, minute)
  let cachedDay = Number.NaN
  let cachedDayOk = false
  while (minute <= endMinute && results.length < limit) {
    while (index + 1 < table.starts.length && minute >= table.starts[index + 1]!) index++
    const offset = table.offsets[index]!
    const segmentEnd = index + 1 < table.starts.length ? table.starts[index + 1]! : Number.POSITIVE_INFINITY
    const wallMinute = minute + offset
    const day = Math.floor(wallMinute / 1440)
    if (day !== cachedDay) {
      cachedDay = day
      cachedDayOk = dayMatches(cron, wallFromWallMinute(day * 1440))
    }
    if (!cachedDayOk) {
      minute = Math.min(minute + (day + 1) * 1440 - wallMinute, segmentEnd)
      continue
    }
    const minuteOfDay = wallMinute - day * 1440
    if (cron.hour[Math.floor(minuteOfDay / 60)] && cron.minute[minuteOfDay % 60]) {
      const instants = oracleInstantsForWallMinute(timeZone, wallMinute)
      const chosen = mode === "later" ? instants[instants.length - 1] : instants[0]
      if (chosen === minute * MINUTE) results.push(minute * MINUTE)
    }
    minute++
  }
  return results
}

/**
 * Oracle for `disambiguation: "reject"`: walk wall-clock minutes upward from
 * the minute after `after`; the first cron-matching wall minute decides —
 * missing or repeated wall minutes are an error, otherwise its instant.
 */
export function oracleRejectOutcome(args: { cron: OracleCron; timeZone: string; afterMs: number; horizonDays: number }): { kind: "instant"; ms: number } | { kind: "error" } | { kind: "none" } {
  const { cron, timeZone, afterMs } = args
  const afterMinute = Math.floor(afterMs / MINUTE)
  const startWall = afterMinute + oracleOffsetMinutes(timeZone, afterMinute * MINUTE) + 1
  const endWall = startWall + args.horizonDays * 1440
  let wallMinute = startWall
  while (wallMinute <= endWall) {
    const day = Math.floor(wallMinute / 1440)
    if (!dayMatches(cron, wallFromWallMinute(day * 1440))) {
      wallMinute = (day + 1) * 1440
      continue
    }
    const minuteOfDay = wallMinute - day * 1440
    if (cron.hour[Math.floor(minuteOfDay / 60)] && cron.minute[minuteOfDay % 60]) {
      const instants = oracleInstantsForWallMinute(timeZone, wallMinute)
      if (instants.length !== 1) return { kind: "error" }
      if (instants[0]! > afterMs) return { kind: "instant", ms: instants[0]! }
    }
    wallMinute++
  }
  return { kind: "none" }
}

/** Convenience: the first occurrence after `afterMs` within `horizonDays`, or null. */
export function oracleNext(args: { cron: OracleCron; timeZone: string; afterMs: number; disambiguation?: OracleDisambiguation; horizonDays?: number }): number | null {
  const horizon = (args.horizonDays ?? 9 * 366) * 1440 * MINUTE
  const [first] = oracleOccurrences({ cron: args.cron, timeZone: args.timeZone, afterMs: args.afterMs, endMs: args.afterMs + horizon, ...(args.disambiguation === undefined ? {} : { disambiguation: args.disambiguation }), limit: 1 })
  return first ?? null
}
