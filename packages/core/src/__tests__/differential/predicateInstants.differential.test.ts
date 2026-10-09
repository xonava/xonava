import { describe, expect, it } from "vitest"
import { createRng, forAll } from "./harness"
import { DIFFERENTIAL_FIELDS, generatePredicate, generateRecord, shrinkPredicate, shrinkRecord } from "./arbitraries"
import {
  assertSameTruth, CODE_POINT_ALPHABET, formatRfc3339, generateCodePointString, generateInstant, hydrateRecord, instantRepresentation,
  mapPredicateValues, rfc3339Representation, shrinkCase,
} from "./predicateArbitraries"
import { Predicate, type PredicateNode, type PredicatePrimitive } from "../../domain/predicate"
import { compareCodePoints, evaluatePredicateTruth, parseRfc3339Timestamp } from "../../domain/evaluatePredicate"

/**
 * Property 5 (instant equivalence) and the comparison primitives it rests on.
 *
 * Spec, "Comparison": an instant is ordered by time and "is also comparable
 * with a strict RFC 3339 full-date (UTC midnight) or date-time string"; two
 * strings are always compared as text (code-point order). So instant
 * equivalence is a property of comparisons where at least one side is a Date:
 * - with the record value hydrated to a Date (adapters MUST hydrate typed
 *   columns), any spelling of an instant in the predicate gives the same truth;
 * - with the predicate value a Date, any spelling of the instant in the record
 *   gives the same truth.
 * String-vs-string comparisons of differently written instants are NOT equal
 * by spec; that is pinned as a named example below rather than asserted away.
 */

const DATETIME = "updatedAt"
const DATE = "dueOn"
const instantFields = DIFFERENTIAL_FIELDS.filter((field) => field.type === "datetime" || field.type === "date")

/** Spells every instant-typed predicate value via `spell` (date fields stay full-dates when spelled as strings). */
function respell(node: PredicateNode, spell: (time: number, field: string) => PredicatePrimitive): PredicateNode {
  return mapPredicateValues(node, (field, value) => {
    if (field !== DATETIME && field !== DATE) return value
    const time = value instanceof Date ? value.getTime() : typeof value === "string" ? parseRfc3339Timestamp(value) : null
    return time === null ? value : spell(time, field)
  })
}

interface InstantCase { node: PredicateNode; record: Record<string, unknown>; seed: number }

describe("predicate semantics — 5. instant equivalence", () => {
  it("with hydrated (Date) records, every RFC 3339 spelling of a predicate instant gives the same truth", () => {
    let unknownOrFalse = 0
    let trueCount = 0
    forAll("predicate instant spelling", (rng) => {
      const node = generatePredicate(rng, { portable: rng.bool(), fields: [...DIFFERENTIAL_FIELDS, ...instantFields, ...instantFields] })
      const record = hydrateRecord(generateRecord(rng))
      // Date fields hold full-dates; hydrate them to UTC-midnight Dates too.
      if (typeof record[DATE] === "string") record[DATE] = new Date(parseRfc3339Timestamp(record[DATE])!)
      return { node, record, seed: rng.next() }
    }, ({ node, record, seed }) => {
      const reference = respell(node, (time) => new Date(time))
      const expected = evaluatePredicateTruth(record, reference)
      if (expected === true) trueCount++
      else unknownOrFalse++
      for (let variant = 0; variant < 4; variant++) {
        const local = createRng((seed + variant) >>> 0)
        const respelled = respell(node, (time) => {
          const choice = local.int(3)
          if (choice === 0) return new Date(time)
          return formatRfc3339(time, choice === 1 ? 0 : local.int(1439) - 719, 3 + local.int(7), local.bool())
        })
        assertSameTruth(evaluatePredicateTruth(record, respelled), expected, `variant ${variant}`)
      }
    }, { runs: 1200, shrink: shrinkCase<InstantCase>({ node: shrinkPredicate, record: shrinkRecord }) })
    expect(trueCount).toBeGreaterThan(50)
    expect(unknownOrFalse).toBeGreaterThan(50)
  })

  it("with Date predicate values, every spelling of the record instant (Date, Z, any offset, full-date at midnight) gives the same truth", () => {
    forAll("record instant spelling", (rng) => {
      const time = generateInstant(rng)
      const node = respell(generatePredicate(rng, { portable: rng.bool(), fields: [...instantFields, ...DIFFERENTIAL_FIELDS] }), (t) => new Date(rng.bool(0.4) ? time : t))
      return { node, time, spellings: Array.from({ length: 4 }, () => instantRepresentation(rng, time)), record: generateRecord(rng) }
    }, ({ node, time, spellings, record }) => {
      const base = { ...record, [DATETIME]: new Date(time) }
      const expected = evaluatePredicateTruth(base, node)
      for (const spelling of spellings) {
        assertSameTruth(evaluatePredicateTruth({ ...record, [DATETIME]: spelling }, node), expected, `record ${DATETIME} = ${String(spelling instanceof Date ? `Date(${spelling.toISOString()})` : spelling)}`)
      }
    }, { runs: 1200, shrink: shrinkCase({ node: shrinkPredicate, record: shrinkRecord }) })
  })

  it("eq / lt / gt between two instants agree with their epoch milliseconds in every spelling", () => {
    forAll("instant order", (rng) => {
      const a = generateInstant(rng)
      const b = rng.bool(0.3) ? a : rng.bool(0.3) ? a + rng.pick([-1, 1, 1000, -86_400_000]) : generateInstant(rng)
      return { a, b, left: instantRepresentation(rng, a), right: new Date(b) }
    }, ({ a, b, left, right }) => {
      const record = { at: left }
      const describe = String(left instanceof Date ? left.toISOString() : left)
      assertSameTruth(evaluatePredicateTruth(record, Predicate.eq("at", right)), a === b, `eq ${describe}`)
      assertSameTruth(evaluatePredicateTruth(record, Predicate.lt("at", right)), a < b, `lt ${describe}`)
      assertSameTruth(evaluatePredicateTruth(record, Predicate.gt("at", right)), a > b, `gt ${describe}`)
    }, { runs: 2000 })
  })

  it("pinned by spec: two strings are compared as text even when they spell the same instant", () => {
    // Spec "Comparison": string kind uses code-point order; only an instant
    // (Date) operand triggers RFC 3339 parsing of the other side.
    expect(evaluatePredicateTruth({ at: "2026-01-01T00:00:00Z" }, Predicate.eq("at", "2026-01-01T05:30:00+05:30"))).toBe(false)
    expect(evaluatePredicateTruth({ at: new Date("2026-01-01T00:00:00Z") }, Predicate.eq("at", "2026-01-01T05:30:00+05:30"))).toBe(true)
  })
})

describe("comparison primitives", () => {
  it("parseRfc3339Timestamp inverts a reference formatter over years 0000–9999, every offset and precision", () => {
    forAll("rfc3339 round trip", (rng) => {
      const time = generateInstant(rng)
      return { time, text: rfc3339Representation(rng, time) }
    }, ({ time, text }) => {
      expect(parseRfc3339Timestamp(text), text).toBe(time)
    }, { runs: 3000 })
  })

  it("parseRfc3339Timestamp rejects out-of-calendar and out-of-range fields instead of rolling over", () => {
    const daysIn = (year: number, month: number): number => [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!
    forAll("rfc3339 rejects invalid fields", (rng) => ({
      year: rng.pick([0, 1, 99, 100, 1900, 2000, 2024, 2025, 9999]),
      month: 1 + rng.int(14),
      day: 1 + rng.int(32),
      hour: rng.int(26), minute: rng.int(62), second: rng.int(62),
      offsetHour: rng.int(26), offsetMinute: rng.int(62),
      form: rng.int(2),
    }), ({ year, month, day, hour, minute, second, offsetHour, offsetMinute, form }) => {
      const p = (value: number, width = 2) => String(value).padStart(width, "0")
      const text = form === 0
        ? `${p(year, 4)}-${p(month)}-${p(day)}`
        : `${p(year, 4)}-${p(month)}-${p(day)}T${p(hour)}:${p(minute)}:${p(second)}+${p(offsetHour)}:${p(offsetMinute)}`
      const calendarValid = month <= 12 && day <= daysIn(year, month)
      const clockValid = form === 0 || (hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59)
      const parsed = parseRfc3339Timestamp(text)
      if (!(calendarValid && clockValid)) expect(parsed, text).toBeNull()
      else {
        const date = new Date(0)
        date.setUTCFullYear(year, month - 1, day)
        date.setUTCHours(form === 0 ? 0 : hour, form === 0 ? 0 : minute, form === 0 ? 0 : second, 0)
        expect(parsed, text).toBe(date.getTime() - (form === 0 ? 0 : (offsetHour * 60 + offsetMinute) * 60_000))
      }
    }, { runs: 3000 })
  })

  it("compareCodePoints agrees with UTF-8 byte order and is a total order", () => {
    const encoder = new TextEncoder()
    const byteOrder = (left: string, right: string): number => {
      const a = encoder.encode(left)
      const b = encoder.encode(right)
      for (let index = 0; index < Math.min(a.length, b.length); index++) if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1
      return Math.sign(a.length - b.length)
    }
    forAll("code point order", (rng) => {
      const a = generateCodePointString(rng)
      const shared = rng.bool(0.4) ? a.slice(0, rng.int(a.length + 1)) : ""
      return { a, b: shared + generateCodePointString(rng), c: generateCodePointString(rng) }
    }, ({ a, b, c }) => {
      expect(compareCodePoints(a, b)).toBe(byteOrder(a, b))
      expect(compareCodePoints(b, a)).toBe(0 - compareCodePoints(a, b) || 0)
      expect(compareCodePoints(a, a)).toBe(0)
      if (compareCodePoints(a, b) <= 0 && compareCodePoints(b, c) <= 0) expect(compareCodePoints(a, c)).toBeLessThanOrEqual(0)
      // And the evaluator's string ordering is that order.
      expect(evaluatePredicateTruth({ s: a }, Predicate.lt("s", b))).toBe(byteOrder(a, b) < 0)
    }, { runs: 3000 })
    expect(CODE_POINT_ALPHABET.length).toBeGreaterThan(10)
  })
})
