import type { PredicateNode, PredicatePrimitive, PredicateRangeValue, PredicateValue } from "./predicate"

function asComparable(value: unknown): string | number | boolean | null {
  if (value instanceof Date) return value.getTime()
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value
  }
  return null
}

function compareValues(left: unknown, right: unknown): number | null {
  if (left instanceof Date && typeof right === "string") right = new Date(right)
  if (right instanceof Date && typeof left === "string") left = new Date(left)
  const a = asComparable(left)
  const b = asComparable(right)
  if (a === null || b === null) return null
  if (typeof a === "boolean" || typeof b === "boolean") {
    if (a === b) return 0
    return a === true ? 1 : -1
  }
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left == null && right == null
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime()
  }
  if (left instanceof Date && typeof right === "string") return left.getTime() === Date.parse(right)
  if (right instanceof Date && typeof left === "string") return Date.parse(left) === right.getTime()
  return left === right
}

function asArray(value: PredicateValue | undefined): PredicatePrimitive[] {
  return Array.isArray(value) ? value : []
}

function asRange(value: PredicateValue | undefined): PredicateRangeValue | undefined {
  if (!value || Array.isArray(value)) return undefined
  if (typeof value === "object") return value as PredicateRangeValue
  return undefined
}

function includesValue(container: unknown, candidate: PredicatePrimitive): boolean {
  if (container === null || container === undefined || candidate === null) return false
  if (Array.isArray(container)) {
    return container.some((item) => valuesEqual(item, candidate))
  }
  return valuesEqual(container, candidate)
}

function includesAll(container: unknown, candidates: PredicatePrimitive[]): boolean {
  return Array.isArray(container) && candidates.every((candidate) => includesValue(container, candidate))
}

/**
 * Three-valued predicate truth (true | false | null where null = UNKNOWN).
 *
 * IMPORTANT semantic invariant: The public `evaluatePredicate()` collapses
 * three-valued logic to strict boolean via `=== true`.  This means UNKNOWN
 * is treated as "no match" at the policy-match boundary, which is the correct
 * behaviour for tiered policy resolution — a higher tier whose condition
 * cannot be determined (null) should fall through to the next tier.
 *
 * If these predicates are ever compiled to SQL for server-side evaluation,
 * each leaf condition MUST be wrapped with COALESCE(expr, FALSE) before tier
 * negation, because SQL NOT UNKNOWN remains UNKNOWN (three-valued), whereas
 * the JS runtime collapses it to FALSE (two-valued).  Without COALESCE, a
 * NOT applied to an UNKNOWN leaf would prevent the tier from matching — a
 * semantic divergence from the JS evaluator.
 *
 * The Drizzle predicate compiler enforces this with strictBoolean(), which
 * wraps leaf and composite expressions in COALESCE(..., FALSE). Any future
 * compiler must preserve the same parity invariant.
 */
type PredicateTruth = true | false | null

function evaluateCondition(record: Record<string, unknown>, condition: Extract<PredicateNode, { kind: "condition" }>): PredicateTruth {
  const actual = record[condition.field]
  const expected = condition.value

  switch (condition.op) {
    case "eq":
      if ((actual === null || actual === undefined) && expected !== null) return null
      return valuesEqual(actual, expected)
    case "neq":
      if (actual === null || actual === undefined) return null
      return !valuesEqual(actual, expected)
    case "contains":
      return typeof expected === "string" && typeof actual === "string" && actual.includes(expected)
    case "startsWith":
      return typeof expected === "string" && typeof actual === "string" && actual.startsWith(expected)
    case "endsWith":
      return typeof expected === "string" && typeof actual === "string" && actual.endsWith(expected)
    case "isEmpty":
  if (Array.isArray(actual)) return actual.length === 0
      return actual === null || actual === undefined || actual === ""
    case "isNotEmpty":
      if (Array.isArray(actual)) return actual.length > 0
      return actual !== null && actual !== undefined && actual !== ""
    case "gt": {
      const compared = compareValues(actual, expected)
      return compared === null ? null : compared > 0
    }
    case "lt": {
      const compared = compareValues(actual, expected)
      return compared === null ? null : compared < 0
    }
    case "gte": {
      const compared = compareValues(actual, expected)
      return compared === null ? null : compared >= 0
    }
    case "lte": {
      const compared = compareValues(actual, expected)
      return compared === null ? null : compared <= 0
    }
    case "isTrue":
      return actual === true
    case "isFalse":
      return actual === false
    case "isNull":
      return actual === null || actual === undefined
    case "isNotNull":
      return actual !== null && actual !== undefined
    case "in":
      return actual !== null && actual !== undefined && !Array.isArray(actual)
        && asArray(expected).some((value) => value !== null && valuesEqual(actual, value))
    case "includesAny":
      return Array.isArray(actual) && asArray(expected).some((value) => includesValue(actual, value))
    case "includesAll":
      return includesAll(actual, asArray(expected))
    case "between": {
      const range = asRange(expected)
      if (!range || (range.from === undefined && range.to === undefined)) return false
      const lower = range.from === undefined ? true : (() => {
        const compared = compareValues(actual, range.from)
        return compared === null ? null : compared >= 0
      })()
      const upper = range.to === undefined ? true : (() => {
        const compared = compareValues(actual, range.to)
        return compared === null ? null : compared <= 0
      })()
      // JavaScript `&&` on (null && true) yields null (three-valued).
      // The public evaluatePredicate() collapses this to false via `=== true`,
      // so the tier resolver sees UNKNOWN as "no match".  If this expression
      // is compiled to SQL, wrap with COALESCE to ensure parity.
      return lower && upper
    }
    default:
      return false
  }
}

/**
 * Evaluate a predicate tree against a record, returning strict boolean.
 *
 * Three-valued (UNKNOWN) truth from leaf conditions is collapsed here:
 * `=== true` means UNKNOWN is treated as "no match" — the correct semantic
 * for tiered ABAC policy resolution (see PredicateTruth doc above).
 */
export function evaluatePredicate(record: Record<string, unknown>, predicate: PredicateNode): boolean {
  return evaluatePredicateTruth(record, predicate) === true
}

function evaluatePredicateTruth(record: Record<string, unknown>, predicate: PredicateNode): PredicateTruth {
  switch (predicate.kind) {
    case "literal":
      return predicate.value
    case "condition":
      return evaluateCondition(record, predicate)
    case "and":
      return predicate.filters.reduce<PredicateTruth>((truth, filter) => {
        const next = evaluatePredicateTruth(record, filter)
        return truth === false || next === false ? false : truth === null || next === null ? null : true
      }, true)
    case "or":
      return predicate.filters.reduce<PredicateTruth>((truth, filter) => {
        const next = evaluatePredicateTruth(record, filter)
        return truth === true || next === true ? true : truth === null || next === null ? null : false
      }, false)
    case "not":
      {
        const truth = evaluatePredicateTruth(record, predicate.filter)
        return truth === null ? null : !truth
      }
    default:
      return false
  }
}
