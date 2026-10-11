import type { Rng } from "./harness"
import { ORACLE_ZONES, oracleTransitions, type OracleDisambiguation } from "./scheduleOracle"

/**
 * Generators for the schedule suites. Pools are small on purpose so that
 * generated expressions collide with month ends, leap days, DST transitions
 * and each other far more often than uniform sampling would.
 */

const MINUTE_PARTS = ["*", "0", "0", "30", "15", "45", "59", "*/15", "*/20", "*/7", "0,30", "5-10", "0-59/30", "30/10", "1,2", "10-20/5", "7", "*/59"]
const HOUR_PARTS = ["*", "*", "0", "1", "2", "3", "12", "23", "*/2", "1-3", "2,3", "0-5", "22-23", "*/6", "2/3", "1,13", "0,12", "*/5", "4"]
const DOM_PARTS = ["*", "*", "*", "1", "15", "28", "29", "30", "31", "*/2", "1-7", "29-31", "1,15", "*/10", "31/2", "*/31", "28-31", "15,31", "2-30/4"]
const MONTH_PARTS = ["*", "*", "*", "1", "2", "3", "10", "11", "12", "2,3", "*/3", "3-4", "1-12/5", "2-2", "10-11", "12/2", "4,6,9,11"]
const DOW_PARTS = ["*", "*", "*", "0", "1", "5", "6", "7", "1-5", "0,6", "*/2", "5-7", "6-7", "0-7/3", "7/2", "1,3,5", "*/3", "0-0"]

export const WHITESPACE_VARIANTS = [" ", "  ", "\t", " \t ", "\n"] as const

/** A syntactically valid five-field expression. */
export function generateCronExpression(rng: Rng): string {
  return [rng.pick(MINUTE_PARTS), rng.pick(HOUR_PARTS), rng.pick(DOM_PARTS), rng.pick(MONTH_PARTS), rng.pick(DOW_PARTS)].join(" ")
}

/** Biased toward dense expressions, so a scan finds several occurrences quickly. */
export function generateDenseCronExpression(rng: Rng): string {
  const minute = rng.pick(["*", "*/5", "*/15", "0,30", "*/20", "7", "0", "15", "*/10", "0-59/30"])
  const hour = rng.pick(["*", "*", "*/2", "1-3", "0-5", "2,3", "22-23", "*/6", "1,13", "*/3"])
  const dom = rng.bool(0.75) ? "*" : rng.pick(DOM_PARTS)
  const month = rng.bool(0.75) ? "*" : rng.pick(MONTH_PARTS)
  const dow = rng.bool(0.7) ? "*" : rng.pick(DOW_PARTS)
  return [minute, hour, dom, month, dow].join(" ")
}

const INVALID_TOKENS = ["", "*/0", "60", "24", "0", "32", "13", "8", "-1", "5-3", "1-", "-", "/", "*/", "1/", "a", "MON", "jan", "?", "L", "1-2-3", "1//2", "1,,2", ",", "1,", ",1", "*,", "**", "*-5", "1e1", "0x1", "+1", "1.5", "00", "007", "1 2", "99999999999999999999", "0-7/0", "*/x", "1-60", "0-24", "1-32", "0-13"]

/** A five-field string that is mostly valid but frequently carries one hostile token. */
export function generateMaybeInvalidExpression(rng: Rng): string {
  const fields = generateCronExpression(rng).split(" ")
  const roll = rng.int(10)
  if (roll < 4) {
    fields[rng.int(5)] = rng.pick(INVALID_TOKENS)
  } else if (roll === 4) {
    fields.push(rng.pick(MINUTE_PARTS))
  } else if (roll === 5) {
    fields.pop()
  } else if (roll === 6) {
    const index = rng.int(5)
    fields[index] = `${fields[index]},${rng.pick(rng.pick([MINUTE_PARTS, HOUR_PARTS, DOM_PARTS, MONTH_PARTS, DOW_PARTS]))}`
  }
  return fields.join(rng.pick(WHITESPACE_VARIANTS))
}

export function surroundWithWhitespace(rng: Rng, expression: string): string {
  const fields = expression.split(" ")
  return `${rng.bool() ? rng.pick(WHITESPACE_VARIANTS) : ""}${fields.join(rng.pick(WHITESPACE_VARIANTS))}${rng.bool() ? rng.pick(WHITESPACE_VARIANTS) : ""}`
}

export function generateZone(rng: Rng): (typeof ORACLE_ZONES)[number] {
  return rng.pick(ORACLE_ZONES)
}

export const DISAMBIGUATIONS: readonly OracleDisambiguation[] = ["skip", "earlier", "later"]

const SECOND = 1000
const MINUTE = 60 * SECOND

/** Calendar edges, in UTC: month ends, leap days, new year. */
const EDGE_DAYS: Array<[month: number, day: number]> = [[1, 31], [2, 28], [2, 29], [3, 1], [4, 30], [5, 1], [6, 30], [8, 31], [10, 31], [11, 30], [12, 31], [1, 1]]

/** Instants between 2017 and 2033: 40% around a DST transition of the zone, 25% at calendar edges, 35% uniform. */
export function generateInstant(rng: Rng, timeZone: string): number {
  const fraction = rng.bool(0.4) ? rng.int(1000) * SECOND + rng.int(1000) : 0
  const sub = rng.bool(0.7) ? fraction : 0
  const roll = rng.int(100)
  const lower = Date.UTC(2017, 0, 1)
  const upper = Date.UTC(2033, 0, 1)
  if (roll < 40) {
    const transitions = oracleTransitions(timeZone).filter((instant) => instant >= lower && instant < upper)
    if (transitions.length > 0) return rng.pick(transitions) + (rng.int(481) - 240) * MINUTE + sub
  }
  if (roll < 65) {
    const [month, day] = rng.pick(EDGE_DAYS)
    const year = rng.pick([2019, 2020, 2020, 2021, 2023, 2024, 2024, 2027, 2028, 2028, 2031, 2032])
    return Date.UTC(year, month - 1, day, rng.int(24), rng.int(60)) + sub
  }
  return lower + rng.int(Math.floor((upper - lower) / MINUTE)) * MINUTE + sub
}

export function describeInstant(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(ms)
}
