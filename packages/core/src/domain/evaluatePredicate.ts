import type { PredicateNode, PredicatePrimitive, PredicateRangeValue, PredicateValue } from "./predicate"
import { ValidationError } from "./errors"

/**
 * Normative predicate semantics (docs/spec/persistence/predicates.md).
 *
 * Predicates use SQL-native Kleene three-valued logic: every condition yields
 * TRUE, FALSE, or UNKNOWN; `and`/`or`/`not` follow the Kleene truth tables; and
 * only the root collapses UNKNOWN to "no match". A missing field is NULL.
 *
 * A comparison yields UNKNOWN whenever an operand is NULL or the operands are
 * not comparable (different primitive kinds, NaN, unparseable date strings,
 * structured values). Incomparable values never compare as equal; this keeps
 * authorization thresholds such as `lte(amount, limit)` fail-closed for
 * corrupt or mistyped data and matches what any SQL engine computes natively.
 *
 * The null-test operators (`isNull`, `isNotNull`, `isEmpty`, `isNotEmpty`, and
 * `eq`/`neq` against a literal null) are two-valued, exactly like SQL
 * `IS NULL` / `IS NOT NULL`.
 */
type Truth = true | false | null

type Comparable =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "instant"; readonly value: number }

function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined
}

function toComparable(value: unknown): Comparable | null {
  if (typeof value === "number") return Number.isNaN(value) ? null : { kind: "number", value }
  if (typeof value === "string") return { kind: "string", value }
  if (typeof value === "boolean") return { kind: "boolean", value }
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isNaN(time) ? null : { kind: "instant", value: time }
  }
  return null
}

/** RFC 3339 full-date or date-time; host date parsers are too lenient to be portable. */
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2})))?$/

/**
 * Parse a strict RFC 3339 full-date (UTC midnight) or offset-bearing date-time
 * to epoch milliseconds. Out-of-calendar dates and out-of-range clock fields
 * are rejected instead of rolling over; returns null when invalid.
 */
export function parseRfc3339Timestamp(value: string): number | null {
  const match = RFC3339.exec(value)
  if (!match) return null
  const [, year, month, day, hour = "0", minute = "0", second = "0", offsetHour = "0", offsetMinute = "0"] = match
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || Number(offsetHour) > 23 || Number(offsetMinute) > 59) return null
  const time = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value)
  return Number.isNaN(time) ? null : time
}

function parseInstant(value: string): Comparable | null {
  const time = parseRfc3339Timestamp(value)
  return time === null ? null : { kind: "instant", value: time }
}

/** Unicode code-point order, identical to UTF-8 byte order and portable across languages. */
export function compareCodePoints(left: string, right: string): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const a = left.codePointAt(index)!
    const b = right.codePointAt(index)!
    if (a !== b) return a < b ? -1 : 1
    if (a > 0xffff) index++
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1
}

/** Returns -1/0/1, or null when the operands are NULL or not comparable. */
function compareValues(left: unknown, right: unknown): number | null {
  let a = toComparable(left)
  let b = toComparable(right)
  if (a === null || b === null) return null
  // An instant may be compared with an RFC 3339 string; nothing else is
  // coerced. In particular "100" and 100 are different values.
  if (a.kind === "instant" && b.kind === "string") b = parseInstant(b.value)
  else if (b.kind === "instant" && a.kind === "string") a = parseInstant(a.value)
  if (a === null || b === null || a.kind !== b.kind) return null
  if (a.kind === "string") return compareCodePoints(a.value, b.value as string)
  const x = a.kind === "boolean" ? Number(a.value) : a.value
  const y = b.kind === "boolean" ? Number(b.value) : (b.value as number)
  return x < y ? -1 : x > y ? 1 : 0
}

function equals(actual: unknown, expected: unknown): Truth {
  const compared = compareValues(actual, expected)
  return compared === null ? null : compared === 0
}

function asArray(value: PredicateValue | undefined): readonly PredicatePrimitive[] {
  return Array.isArray(value) ? value : []
}

function asRange(value: PredicateValue | undefined): PredicateRangeValue | undefined {
  if (!value || Array.isArray(value) || typeof value !== "object" || value instanceof Date) return undefined
  return value
}

function and(left: Truth, right: Truth): Truth {
  if (left === false || right === false) return false
  return left === null || right === null ? null : true
}

function or(left: Truth, right: Truth): Truth {
  if (left === true || right === true) return true
  return left === null || right === null ? null : false
}

function not(value: Truth): Truth {
  return value === null ? null : !value
}

function ordered(actual: unknown, expected: unknown, test: (compared: number) => boolean): Truth {
  const compared = compareValues(actual, expected)
  return compared === null ? null : test(compared)
}

function stringMatch(actual: unknown, expected: unknown, test: (actual: string, expected: string) => boolean): Truth {
  if (isNullish(actual) || typeof expected !== "string" || typeof actual !== "string") return null
  return test(actual, expected)
}

/** Kleene `x = ANY(list)`; null list members are ignored, an empty list is FALSE. */
function membership(actual: unknown, candidates: readonly PredicatePrimitive[]): Truth {
  let truth: Truth = false
  for (const candidate of candidates) {
    if (candidate === null) continue
    truth = or(truth, equals(actual, candidate))
    if (truth === true) return true
  }
  return truth
}

function evaluateCondition(record: Readonly<Record<string, unknown>>, condition: Extract<PredicateNode, { kind: "condition" }>): Truth {
  const actual = Object.hasOwn(record, condition.field) ? record[condition.field] : undefined
  const expected = condition.value

  switch (condition.op) {
    case "eq":
      if (expected === null) return isNullish(actual)
      return isNullish(actual) ? null : equals(actual, expected)
    case "neq":
      if (expected === null) return !isNullish(actual)
      return isNullish(actual) ? null : not(equals(actual, expected))
    case "contains":
      return stringMatch(actual, expected, (value, needle) => value.includes(needle))
    case "startsWith":
      return stringMatch(actual, expected, (value, needle) => value.startsWith(needle))
    case "endsWith":
      return stringMatch(actual, expected, (value, needle) => value.endsWith(needle))
    case "isEmpty":
      if (Array.isArray(actual)) return actual.length === 0
      return isNullish(actual) || actual === ""
    case "isNotEmpty":
      if (Array.isArray(actual)) return actual.length > 0
      return !isNullish(actual) && actual !== ""
    case "gt": return ordered(actual, expected, (compared) => compared > 0)
    case "lt": return ordered(actual, expected, (compared) => compared < 0)
    case "gte": return ordered(actual, expected, (compared) => compared >= 0)
    case "lte": return ordered(actual, expected, (compared) => compared <= 0)
    case "isTrue": return isNullish(actual) ? null : equals(actual, true)
    case "isFalse": return isNullish(actual) ? null : equals(actual, false)
    case "isNull": return isNullish(actual)
    case "isNotNull": return !isNullish(actual)
    case "in":
      if (!Array.isArray(expected)) return false
      if (isNullish(actual) || Array.isArray(actual)) return isNullish(actual) && membershipIsEmpty(expected) ? false : null
      return membership(actual, expected)
    case "includesAny": {
      if (!Array.isArray(actual)) return null
      let truth: Truth = false
      for (const candidate of asArray(expected)) {
        if (candidate === null) continue
        truth = or(truth, membership(candidate, actual as PredicatePrimitive[]))
        if (truth === true) return true
      }
      return truth
    }
    case "includesAll": {
      if (!Array.isArray(actual)) return null
      let truth: Truth = true
      for (const candidate of asArray(expected)) {
        if (candidate === null) return null
        truth = and(truth, membership(candidate, actual as PredicatePrimitive[]))
        if (truth === false) return false
      }
      return truth
    }
    case "between": {
      const range = asRange(expected)
      if (!range || (range.from === undefined && range.to === undefined)) return false
      const lower: Truth = range.from === undefined ? true : ordered(actual, range.from, (compared) => compared >= 0)
      const upper: Truth = range.to === undefined ? true : ordered(actual, range.to, (compared) => compared <= 0)
      return and(lower, upper)
    }
    default:
      return false
  }
}

/** SQL `NULL IN ()` is FALSE; with candidates it is UNKNOWN. */
function membershipIsEmpty(candidates: readonly PredicatePrimitive[]): boolean {
  return candidates.every((candidate) => candidate === null)
}

export const MAX_PREDICATE_EVALUATION_DEPTH = 256

function evaluateTruth(record: Readonly<Record<string, unknown>>, predicate: PredicateNode, depth: number): Truth {
  if (depth > MAX_PREDICATE_EVALUATION_DEPTH) throw new ValidationError(`Predicate nesting exceeds ${MAX_PREDICATE_EVALUATION_DEPTH} levels`)
  switch (predicate.kind) {
    case "literal":
      return predicate.value === true
    case "condition":
      return evaluateCondition(record, predicate)
    case "and": {
      let truth: Truth = true
      for (const filter of predicate.filters) {
        truth = and(truth, evaluateTruth(record, filter, depth + 1))
        if (truth === false) return false
      }
      return truth
    }
    case "or": {
      let truth: Truth = false
      for (const filter of predicate.filters) {
        truth = or(truth, evaluateTruth(record, filter, depth + 1))
        if (truth === true) return true
      }
      return truth
    }
    case "not":
      return not(evaluateTruth(record, predicate.filter, depth + 1))
    default:
      return null
  }
}

/** Evaluates a predicate in three-valued logic; `null` is UNKNOWN. */
export function evaluatePredicateTruth(record: Readonly<Record<string, unknown>>, predicate: PredicateNode): boolean | null {
  return evaluateTruth(record, predicate, 0)
}

/**
 * Evaluate a predicate tree against a record. UNKNOWN collapses to `false`
 * only here, at the root, exactly like a SQL `WHERE` clause. Trees deeper than
 * MAX_PREDICATE_EVALUATION_DEPTH throw a ValidationError instead of
 * exhausting the stack.
 */
export function evaluatePredicate(record: Readonly<Record<string, unknown>>, predicate: PredicateNode): boolean {
  return evaluateTruth(record, predicate, 0) === true
}
