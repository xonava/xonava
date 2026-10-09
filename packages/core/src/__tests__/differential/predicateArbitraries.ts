import { Predicate, type PredicateNode, type PredicatePrimitive, type PredicateValue } from "../../domain/predicate"
import { parseRfc3339Timestamp } from "../../domain/evaluatePredicate"
import { DIFFERENTIAL_FIELDS, DATETIME_STRINGS, type DifferentialField, fieldValue, generateRecord, shrinkPredicate, shrinkRecord } from "./arbitraries"
import type { Rng } from "./harness"

/**
 * Generators specific to the predicate-semantics differentials (kept apart
 * from the shared `arbitraries.ts` so concurrent suites never conflict).
 */

type Truth = boolean | null

/** Values of every kind, including ones the spec declares incomparable (NaN, arrays, objects, cross-kind look-alikes). */
export const WILD_VALUES: readonly unknown[] = Object.freeze([
  null, undefined, "", "a", "A", "100", "true", "2026-01-01", "2026-01-01T00:00:00Z", "not-a-date",
  0, 1, 100, -0.5, Number.NaN, Number.POSITIVE_INFINITY, true, false,
  new Date("2026-01-01T00:00:00Z"), new Date(Number.NaN), [], ["x"], [1], { a: 1 },
])

export function wildValue(rng: Rng): unknown {
  return rng.pick(WILD_VALUES)
}

/** A record whose fields hold values of any kind, regardless of the declared field type. */
export function generateWildRecord(rng: Rng, fields: readonly DifferentialField[] = DIFFERENTIAL_FIELDS): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    const roll = rng.int(10)
    if (roll === 0) continue
    out[field.key] = roll < 4 ? wildValue(rng) : roll < 5 ? null : fieldValue(rng, field.type)
  }
  return out
}

/** Either a typed record (mostly) or a wild one. */
export function generateAnyRecord(rng: Rng, wildRate = 0.2): Record<string, unknown> {
  return rng.bool(wildRate) ? generateWildRecord(rng) : generateRecord(rng)
}

/** -62167219200000 is 0000-01-01T00:00:00Z; 253402300799999 is 9999-12-31T23:59:59.999Z. */
export const RFC3339_MIN_TIME = -62_167_219_200_000
export const RFC3339_MAX_TIME = 253_402_300_799_999
const DAY = 86_400_000

/** An instant in RFC 3339's four-digit-year range, biased toward edges (years 0000-0099, leap days, midnight, ms boundaries). */
export function generateInstant(rng: Rng): number {
  const pick = rng.int(8)
  if (pick === 0) return new Date(rng.pick(DATETIME_STRINGS)).getTime()
  if (pick === 1) {
    // A year below 100 — two-digit-year traps in host date APIs.
    const date = new Date(0)
    date.setUTCFullYear(rng.int(100), rng.int(12), 1 + rng.int(28))
    date.setUTCHours(rng.int(24), rng.int(60), rng.int(60), rng.int(1000))
    return date.getTime()
  }
  if (pick === 2) {
    // Leap days and the day before/after, in leap and non-leap centuries.
    const date = new Date(0)
    date.setUTCFullYear(rng.pick([0, 4, 100, 400, 1900, 2000, 2024, 2100]), 1, rng.pick([28, 29]))
    date.setUTCHours(0, 0, 0, 0)
    return date.getTime() + rng.pick([0, -1, 1, DAY - 1])
  }
  if (pick === 3) return rng.pick([RFC3339_MIN_TIME + DAY * 2, RFC3339_MAX_TIME - DAY * 2, 0, -1, 1])
  const span = RFC3339_MAX_TIME - RFC3339_MIN_TIME - DAY * 4
  const raw = RFC3339_MIN_TIME + DAY * 2 + Math.floor((rng.next() / 0x1_0000_0000) * span)
  if (pick === 4) return raw - (((raw % DAY) + DAY) % DAY) // UTC midnight
  if (pick === 5) return raw - (((raw % 1000) + 1000) % 1000) // whole second
  return raw
}

const pad = (value: number, width: number): string => String(value).padStart(width, "0")

/**
 * Formats `time` as a strict RFC 3339 string at the given offset (minutes east
 * of UTC) with `fractionDigits` fractional digits (0, or 3..9 so the
 * millisecond is exact; 1..2 only when the millisecond allows it).
 */
export function formatRfc3339(time: number, offsetMinutes: number, fractionDigits: number, zulu = offsetMinutes === 0): string {
  const local = new Date(time + offsetMinutes * 60_000)
  const ms = local.getUTCMilliseconds()
  let fraction = ""
  if (fractionDigits > 0) {
    const nine = `${pad(ms, 3)}000000`
    fraction = `.${nine.slice(0, fractionDigits)}`
  }
  const sign = offsetMinutes < 0 || Object.is(offsetMinutes, -0) ? "-" : "+"
  const absolute = Math.abs(offsetMinutes)
  const offset = zulu && offsetMinutes === 0 ? "Z" : `${sign}${pad(Math.floor(absolute / 60), 2)}:${pad(absolute % 60, 2)}`
  return `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1, 2)}-${pad(local.getUTCDate(), 2)}T${pad(local.getUTCHours(), 2)}:${pad(local.getUTCMinutes(), 2)}:${pad(local.getUTCSeconds(), 2)}${fraction}${offset}`
}

/** A random strict RFC 3339 spelling of `time` (any offset within ±23:59, any exact precision; full-date at UTC midnight). */
export function rfc3339Representation(rng: Rng, time: number): string {
  if (((time % DAY) + DAY) % DAY === 0 && rng.bool(0.3)) {
    const date = new Date(time)
    return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`
  }
  const ms = ((time % 1000) + 1000) % 1000
  const minimumDigits = ms === 0 ? 0 : ms % 100 === 0 ? 1 : ms % 10 === 0 ? 2 : 3
  for (let attempt = 0; attempt < 8; attempt++) {
    // Zero offsets are spelled "Z", "+00:00" or "-00:00".
    const offset = rng.bool(0.3) ? (rng.bool() ? 0 : -0) : (rng.int(24 * 60) * (rng.bool() ? 1 : -1))
    const local = time + offset * 60_000
    if (local < RFC3339_MIN_TIME || local > RFC3339_MAX_TIME) continue
    const digits = rng.bool(0.4) ? minimumDigits : Math.max(minimumDigits, 1 + rng.int(9))
    return formatRfc3339(time, offset, digits, rng.bool())
  }
  return formatRfc3339(time, 0, 3)
}

/** `time` as a Date or as a random RFC 3339 spelling. */
export function instantRepresentation(rng: Rng, time: number): string | Date {
  return rng.bool(0.35) ? new Date(time) : rfc3339Representation(rng, time)
}

/**
 * Adapter hydration (spec: "Adapters MUST hydrate typed columns ... into the
 * value kind the entity declares"): datetime fields become Date instances.
 */
export function hydrateRecord(record: Record<string, unknown>, fields: readonly DifferentialField[] = DIFFERENTIAL_FIELDS): Record<string, unknown> {
  const out: Record<string, unknown> = { ...record }
  for (const field of fields) {
    if (field.type !== "datetime" || !Object.hasOwn(out, field.key)) continue
    const value = out[field.key]
    if (typeof value === "string") {
      const time = parseRfc3339Timestamp(value)
      if (time !== null) out[field.key] = new Date(time)
    }
  }
  return out
}

/** Rewrites every condition value (and list member and range bound) in a predicate. */
export function mapPredicateValues(node: PredicateNode, map: (field: string, value: PredicatePrimitive) => PredicatePrimitive): PredicateNode {
  switch (node.kind) {
    case "literal": return node
    case "not": return Predicate.not(mapPredicateValues(node.filter, map))
    case "and": case "or": return { kind: node.kind, filters: node.filters.map((child) => mapPredicateValues(child, map)) }
    case "condition": {
      if (!Object.hasOwn(node, "value")) return node
      const value = node.value as PredicateValue
      let next: PredicateValue
      if (Array.isArray(value)) next = value.map((item) => map(node.field, item))
      else if (value !== null && typeof value === "object" && !(value instanceof Date)) {
        next = {}
        if (value.from !== undefined) next.from = map(node.field, value.from)
        if (value.to !== undefined) next.to = map(node.field, value.to)
      } else next = map(node.field, value)
      return { kind: "condition", field: node.field, op: node.op, value: next }
    }
  }
}

export interface PatchOptions {
  fields?: readonly DifferentialField[]
  /** Probability a written field is NULL (default 0.2). */
  nullRate?: number
  /** Probability a written field is `undefined` (default 0.1). */
  undefinedRate?: number
}

/** An update patch writing 1..3 fields (values of the field's type, NULL, or `undefined`). */
export function generatePatch(rng: Rng, options: PatchOptions = {}): Record<string, unknown> {
  const fields = rng.shuffle(options.fields ?? DIFFERENTIAL_FIELDS).slice(0, 1 + rng.int(3))
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    out[field.key] = rng.bool(options.undefinedRate ?? 0.1) ? undefined : rng.bool(options.nullRate ?? 0.2) ? null : fieldValue(rng, field.type)
  }
  return out
}

/** Characters around every UTF-8 / UTF-16 encoding boundary (all scalar values, no lone surrogates). */
export const CODE_POINT_ALPHABET = ["a", "b", "B", "\u007f", "\u0080", "é", "߿", "ࠀ", "퟿", "", "￯", "￿", "😀", "\u{10000}", "\u{10ffff}"] as const

export function generateCodePointString(rng: Rng, maxLength = 5): string {
  return Array.from({ length: rng.int(maxLength + 1) }, () => rng.pick(CODE_POINT_ALPHABET)).join("")
}

/** Kleene connectives as an independent reference (ordering FALSE < UNKNOWN < TRUE). */
const rank = (truth: Truth): number => (truth === false ? 0 : truth === null ? 1 : 2)
const fromRank = (value: number): Truth => (value === 0 ? false : value === 1 ? null : true)
export const kleene = {
  and: (values: readonly Truth[]): Truth => fromRank(values.reduce<number>((min, value) => Math.min(min, rank(value)), 2)),
  or: (values: readonly Truth[]): Truth => fromRank(values.reduce<number>((max, value) => Math.max(max, rank(value)), 0)),
  not: (value: Truth): Truth => (value === null ? null : !value),
}

export function showTruth(truth: Truth): string {
  return truth === null ? "UNKNOWN" : truth ? "TRUE" : "FALSE"
}

/** Throws a readable error when two truth values differ. */
export function assertSameTruth(actual: Truth, expected: Truth, label: string): void {
  if (actual !== expected) throw new Error(`${label}: got ${showTruth(actual)}, expected ${showTruth(expected)}`)
}

/** Shrinks an object case field by field with per-field shrinkers. */
export function shrinkCase<S extends object>(shrinkers: { [K in keyof S]?: (value: S[K]) => Iterable<S[K]> }): <T extends S>(value: T) => Generator<T> {
  return function* <T extends S>(value: T): Generator<T> {
    for (const key of Object.keys(shrinkers) as (keyof S)[]) {
      const shrink = shrinkers[key]
      if (!shrink) continue
      for (const candidate of shrink(value[key])) yield { ...value, [key]: candidate }
    }
  }
}

/** Shrinks a list by dropping one element, then by shrinking one element. */
export function shrinkList<T>(shrinkItem?: (value: T) => Iterable<T>): (list: readonly T[]) => Generator<T[]> {
  return function* (list: readonly T[]) {
    for (let index = 0; index < list.length; index++) yield list.filter((_, position) => position !== index)
    if (!shrinkItem) return
    for (let index = 0; index < list.length; index++) {
      for (const candidate of shrinkItem(list[index]!)) yield list.map((item, position) => (position === index ? candidate : item))
    }
  }
}

export const shrinkNode = shrinkPredicate
export const shrinkRow = shrinkRecord

/** Counts predicate nodes. */
export function nodeCount(node: PredicateNode): number {
  if (node.kind === "not") return 1 + nodeCount(node.filter)
  if (node.kind === "and" || node.kind === "or") return 1 + node.filters.reduce((sum, child) => sum + nodeCount(child), 0)
  return 1
}
