import { Predicate, type PredicateNode, type PredicatePrimitive } from "../../domain/predicate"
import type { AbacFieldDefinition } from "../../domain/abacCatalog"
import type { AbacFieldType } from "../../domain/coercePolicyValue"
import type { Rng } from "./harness"

/**
 * Shared generators for differential tests. Value domains are deliberately
 * small and collision-heavy (so generated predicates actually match rows) and
 * include the edge cases where semantics diverge: NULL, missing keys, empty
 * strings, case and accent differences, non-BMP characters, LIKE
 * metacharacters, negative and fractional numbers, and instants written both
 * as `Date` and as RFC 3339 strings with different offsets.
 */

export interface DifferentialField {
  key: string
  type: AbacFieldType
}

/** One field of every catalog type, plus a second string/number for cross-field variety. */
export const DIFFERENTIAL_FIELDS: readonly DifferentialField[] = Object.freeze([
  { key: "name", type: "string" },
  { key: "code", type: "string" },
  { key: "ownerId", type: "identifier" },
  { key: "amount", type: "number" },
  { key: "rank", type: "number" },
  { key: "active", type: "boolean" },
  { key: "dueOn", type: "date" },
  { key: "updatedAt", type: "datetime" },
  { key: "tags", type: "string-array" },
])

export const STRING_VALUES = ["", "a", "A", "ab", "Ab", "b", "é", "e", "z", "😀", "a%_\\", " a", "draft", "locked"] as const
export const IDENTIFIER_VALUES = ["u1", "u2", "u3", "U1"] as const
export const NUMBER_VALUES = [-2, -0.5, 0, 1, 2.5, 10, 1e6] as const
export const DATE_VALUES = ["2025-12-31", "2026-01-01", "2026-02-28", "2026-03-01"] as const
/** The same instants written several ways; `2026-01-01T00:00:00Z` equals `2026-01-01T05:30:00+05:30`. */
export const DATETIME_STRINGS = [
  "2025-12-31T23:59:59Z",
  "2026-01-01T00:00:00Z",
  "2026-01-01T05:30:00+05:30",
  "2026-01-01T00:00:00.001Z",
  "2026-06-01T12:00:00-07:00",
] as const
export const TAG_VALUES = ["x", "y", "z", "X"] as const

export function datetimeValue(rng: Rng): string | Date {
  const text = rng.pick(DATETIME_STRINGS)
  return rng.bool(0.3) ? new Date(text) : text
}

/**
 * Optional replacement value domains (e.g. the larger, collation-hostile sets
 * the real-database differentials use). Any domain left out keeps the default.
 */
export interface ValueDomains {
  readonly string?: readonly string[]
  readonly identifier?: readonly string[]
  readonly number?: readonly number[]
  readonly date?: readonly string[]
  /** RFC 3339 strings (or deliberately invalid strings); 30% become `Date` like {@link datetimeValue}. */
  readonly datetime?: readonly string[]
  readonly tag?: readonly string[]
}

/** A non-null value of the field's type. */
export function fieldValue(rng: Rng, type: AbacFieldType, domains?: ValueDomains): PredicatePrimitive | string[] {
  switch (type) {
    case "string": return rng.pick(domains?.string ?? STRING_VALUES)
    case "identifier": return rng.pick(domains?.identifier ?? IDENTIFIER_VALUES)
    case "number": return rng.pick(domains?.number ?? NUMBER_VALUES)
    case "boolean": return rng.bool()
    case "date": return rng.pick(domains?.date ?? DATE_VALUES)
    case "datetime": {
      if (!domains?.datetime) return datetimeValue(rng)
      const text = rng.pick(domains.datetime)
      const date = new Date(text)
      return rng.bool(0.3) && !Number.isNaN(date.getTime()) ? date : text
    }
    case "string-array": return rng.subset(domains?.tag ?? TAG_VALUES)
  }
}

export interface RecordOptions {
  /** Probability a field is NULL (default 0.15). */
  nullRate?: number
  /** Probability a field is absent from the record (default 0.1). */
  missingRate?: number
  fields?: readonly DifferentialField[]
  domains?: ValueDomains
}

export function generateRecord(rng: Rng, options: RecordOptions = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of options.fields ?? DIFFERENTIAL_FIELDS) {
    if (rng.bool(options.missingRate ?? 0.1)) continue
    out[field.key] = rng.bool(options.nullRate ?? 0.15) ? null : fieldValue(rng, field.type, options.domains)
  }
  return out
}

export interface PredicateOptions {
  /** Only operators every SQL compiler and the policy pipeline accept (default true). */
  portable?: boolean
  maxDepth?: number
  fields?: readonly DifferentialField[]
  /** Probability of a literal / empty group leaf (default 0.05). */
  literalRate?: number
  /** Replacement value domains for literals. */
  domains?: ValueDomains
  /**
   * Also generate `isEmpty` / `isNotEmpty` on scalar string fields in portable
   * mode. Every SQL compiler supports them; only the policy pipeline rejects them.
   */
  emptyTests?: boolean
}

function scalarOf(rng: Rng, type: AbacFieldType, domains?: ValueDomains): PredicatePrimitive {
  const value = fieldValue(rng, type === "string-array" ? "string" : type, domains)
  return Array.isArray(value) ? null : value
}

function maybeNull(rng: Rng, type: AbacFieldType, domains?: ValueDomains): PredicatePrimitive {
  return rng.bool(0.15) ? null : scalarOf(rng, type, domains)
}

export function generateCondition(rng: Rng, options: PredicateOptions = {}): PredicateNode {
  const portable = options.portable ?? true
  const field = rng.pick(options.fields ?? DIFFERENTIAL_FIELDS)
  const { key, type } = field
  if (type === "string-array") {
    if (portable) return rng.pick([() => Predicate.isNull(key), () => Predicate.isNotNull(key)])()
    return rng.pick([
      () => Predicate.includesAny(key, rng.subset([...TAG_VALUES, null])),
      () => Predicate.includesAll(key, rng.subset([...TAG_VALUES, null])),
      () => Predicate.isEmpty(key),
      () => Predicate.isNotEmpty(key),
      () => Predicate.isNull(key),
    ])()
  }
  const value = () => maybeNull(rng, type, options.domains)
  const scalar = () => scalarOf(rng, type, options.domains)
  const list = () => Array.from({ length: rng.int(4) }, value)
  const common: Array<() => PredicateNode> = [
    () => Predicate.eq(key, value()),
    () => Predicate.neq(key, value()),
    () => Predicate.in(key, list()),
    () => Predicate.isNull(key),
    () => Predicate.isNotNull(key),
  ]
  const ordered: Array<() => PredicateNode> = type === "boolean" ? [] : [
    () => Predicate.gt(key, scalar()),
    () => Predicate.lt(key, scalar()),
    () => Predicate.gte(key, scalar()),
    () => Predicate.lte(key, scalar()),
    () => Predicate.between(key, { from: scalar(), to: scalar() }),
    () => Predicate.between(key, rng.bool() ? { from: scalar() } : { to: scalar() }),
  ]
  const strings: Array<() => PredicateNode> = type === "string" || type === "identifier" ? [
    () => Predicate.contains(key, String(scalar())),
    () => Predicate.startsWith(key, String(scalar())),
    () => Predicate.endsWith(key, String(scalar())),
    ...(portable && !options.emptyTests ? [] : [() => Predicate.isEmpty(key), () => Predicate.isNotEmpty(key)]),
  ] : []
  const booleans: Array<() => PredicateNode> = type === "boolean" ? [() => Predicate.isTrue(key), () => Predicate.isFalse(key)] : []
  return rng.pick([...common, ...ordered, ...strings, ...booleans])()
}

export function generatePredicate(rng: Rng, options: PredicateOptions = {}, depth = 0): PredicateNode {
  const maxDepth = options.maxDepth ?? 4
  if (rng.bool(options.literalRate ?? 0.05)) {
    return rng.pick([() => Predicate.literal(true), () => Predicate.literal(false), () => Predicate.alwaysTrue(), () => Predicate.alwaysFalse()])()
  }
  const roll = rng.int(10)
  if (depth >= maxDepth || roll < 4) return generateCondition(rng, options)
  if (roll < 6) return Predicate.not(generatePredicate(rng, options, depth + 1))
  const children = Array.from({ length: rng.int(4) }, () => generatePredicate(rng, options, depth + 1))
  return roll < 8 ? Predicate.and(...children) : Predicate.or(...children)
}

/** Structurally smaller predicates: subtrees, literals, and groups with one child removed. */
export function* shrinkPredicate(node: PredicateNode): Generator<PredicateNode> {
  if (node.kind === "literal") return
  yield Predicate.literal(true)
  yield Predicate.literal(false)
  if (node.kind === "not") {
    yield node.filter
    for (const inner of shrinkPredicate(node.filter)) yield Predicate.not(inner)
    return
  }
  if (node.kind === "and" || node.kind === "or") {
    for (const child of node.filters) yield child
    for (let index = 0; index < node.filters.length; index++) {
      yield { kind: node.kind, filters: node.filters.filter((_, position) => position !== index) }
    }
    for (let index = 0; index < node.filters.length; index++) {
      for (const inner of shrinkPredicate(node.filters[index]!)) {
        yield { kind: node.kind, filters: node.filters.map((child, position) => (position === index ? inner : child)) }
      }
    }
  }
}

/** Records with fewer fields set, for shrinking. */
export function* shrinkRecord(record: Record<string, unknown>): Generator<Record<string, unknown>> {
  for (const key of Object.keys(record)) {
    const { [key]: _removed, ...rest } = record
    yield rest
    if (record[key] !== null) yield { ...record, [key]: null }
  }
}

/** A catalog of {@link DIFFERENTIAL_FIELDS} for ABAC bundles. */
export function differentialFieldCatalog(fields: readonly DifferentialField[] = DIFFERENTIAL_FIELDS): Record<string, AbacFieldDefinition> {
  const catalog = Object.create(null) as Record<string, AbacFieldDefinition>
  for (const field of fields) catalog[field.key] = { key: field.key, type: field.type, operators: [] }
  return catalog
}
