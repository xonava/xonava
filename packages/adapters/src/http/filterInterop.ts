import { Predicate, type PredicateNode, type PredicateOp, type PredicatePrimitive, type PredicateRangeValue, type PredicateValue } from "core/domain"
import type { FilterFieldMeta, FilterFieldType } from "core/domain"
import { ConfigurationError, ValidationError } from "core/domain"
import type { EntitySearchStrategy } from "core/entity"
import { DEFAULT_QUERY_BUDGET, type SortSpec } from "core/query"

export type { FilterFieldMeta, FilterFieldType }

export const DEFAULT_MAX_QUERY_JSON_BYTES = 64 * 1024
export const DEFAULT_MAX_FILTER_VALUE_BYTES = 64 * 1024

function assertByteBound(value: string, maxBytes: number, message: string): void {
  if (new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new ValidationError(message)
  }
}

export interface FilterCondition {
  field: string
  operator: string
  value?: unknown
}

export interface FilterGroup {
  logic?: "AND" | "OR"
  conditions?: Array<FilterCondition | FilterGroup>
  search?: string
}

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value
  if (typeof value === "number" || typeof value === "string") {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? undefined : date
  }
  return undefined
}

function coerceByKind(value: unknown, kind?: FilterFieldType): unknown {
  if (kind === "date") {
    const date = toDate(value)
    return date && !Number.isNaN(date.getTime()) ? date.toISOString() : value
  }
  if (kind === "number") {
    const number = Number(value)
    return Number.isFinite(number) ? number : value
  }
  if (kind === "boolean") {
    if (value === "true") return true
    if (value === "false") return false
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isFilterGroup(value: unknown): value is FilterGroup {
  return isRecord(value) && Array.isArray(value.conditions)
}

function toPredicatePrimitive(value: unknown): PredicatePrimitive | undefined {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
    || value instanceof Date
  ) {
    return value
  }

  return undefined
}

function toPredicateRangeValue(value: unknown): PredicateRangeValue | undefined {
  if (Array.isArray(value) && value.length === 2) {
    const from = toPredicatePrimitive(value[0])
    const to = toPredicatePrimitive(value[1])
    if (from !== undefined && to !== undefined) {
       return { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) }
    }
  }

  if (isRecord(value)) {
    const from = toPredicatePrimitive(value.from)
    const to = toPredicatePrimitive(value.to)
    if (from !== undefined || to !== undefined) {
       return { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) }
    }
  }

  return undefined
}

function toPredicateValue(value: unknown): PredicateValue | undefined {
  const primitive = toPredicatePrimitive(value)
  if (primitive !== undefined || value === null) return primitive

  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => toPredicatePrimitive(item))
      .filter((item): item is PredicatePrimitive => item !== undefined)

    if (normalized.length === value.length) {
      return normalized
    }

    const rangeValue = toPredicateRangeValue(value)
    if (rangeValue) return rangeValue
  }

  return toPredicateRangeValue(value)
}

function encodedValueByteLength(value: unknown): number {
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength
  if (value === null || value === undefined) return 0
  if (typeof value === "number" || typeof value === "boolean" || value instanceof Date) {
    return new TextEncoder().encode(String(value)).byteLength
  }
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

const OPERATOR_MAP = new Map<string, PredicateOp>([
  ["eq", "eq"],
  ["neq", "neq"],
  ["contains", "contains"],
  ["startsWith", "startsWith"],
  ["endsWith", "endsWith"],
  ["isEmpty", "isEmpty"],
  ["isNotEmpty", "isNotEmpty"],
  ["gt", "gt"],
  ["lt", "lt"],
  ["gte", "gte"],
  ["lte", "lte"],
  ["isTrue", "isTrue"],
  ["isFalse", "isFalse"],
  ["isNull", "isNull"],
  ["isNotNull", "isNotNull"],
  ["between", "between"],
  ["in", "in"],
])

function normalizeOperator(operator: string | undefined): PredicateOp | undefined {
  const raw = operator ?? "eq"
  return OPERATOR_MAP.get(raw)
}

const VALUELESS_OPERATORS = new Set<PredicateOp>([
  "isEmpty",
  "isNotEmpty",
  "isTrue",
  "isFalse",
  "isNull",
  "isNotNull",
])

export function predicateFromFilterCondition(
  condition: unknown,
  allowedFields?: string[],
  fieldMetaMap?: Record<string, FilterFieldMeta>,
  limits?: { maxFilterValueBytes?: number },
): PredicateNode | undefined {
  if (!isRecord(condition) || typeof condition.field !== "string" || condition.field.length === 0) {
    throw new ValidationError("Filter condition must include a non-empty field")
  }
  if (condition.operator !== undefined && typeof condition.operator !== "string") {
    throw new ValidationError(`Invalid filter operator for field "${condition.field}"`)
  }
  // Own-property lookup only: an inherited key (constructor, __proto__, ...)
  // must never resolve to metadata or remap the queried column.
  const meta = fieldMetaMap && Object.hasOwn(fieldMetaMap, condition.field) ? fieldMetaMap[condition.field] : undefined
  const field = typeof meta?.columnName === "string" && meta.columnName.length > 0 ? meta.columnName : condition.field
  if (allowedFields && !allowedFields.includes(field)) {
    throw new ValidationError(`Filtering by field "${condition.field}" is not allowed`)
  }
  const op = normalizeOperator(condition.operator)
  if (!op) throw new ValidationError(`Invalid filter operator "${condition.operator}"`)

  if (
    meta?.kind === "date"
    && op === "eq"
    && typeof condition.value === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(condition.value)
  ) {
    const dayStart = new Date(`${condition.value}T00:00:00.000Z`)
    const dayEnd = new Date(`${condition.value}T23:59:59.999Z`)
    if (!Number.isNaN(dayStart.getTime()) && !Number.isNaN(dayEnd.getTime())) {
      return Predicate.between(field, { from: dayStart.toISOString(), to: dayEnd.toISOString() })
    }
  }

   const predicate = {
     kind: "condition",
     field,
     op,
   } as const
    const hasValue = condition.value !== undefined
    if (!hasValue && !VALUELESS_OPERATORS.has(op)) {
      throw new ValidationError(`Filter operator "${op}" requires a value`)
    }
    const value = toPredicateValue(coerceByKind(condition.value, meta?.kind))
    if (hasValue && value === undefined) {
      throw new ValidationError(`Invalid filter value for field "${condition.field}"`)
    }
    if (hasValue && limits?.maxFilterValueBytes !== undefined) {
      if (encodedValueByteLength(value) > limits.maxFilterValueBytes) {
        throw new ValidationError(`Filter value for field "${condition.field}" exceeds the maximum of ${limits.maxFilterValueBytes} UTF-8 bytes`)
      }
    }
    return value === undefined ? predicate : { ...predicate, value }
}

const MAX_NESTING_DEPTH = DEFAULT_QUERY_BUDGET.maxPredicateDepth
const MAX_CONDITIONS = DEFAULT_QUERY_BUDGET.maxPredicateNodes

export function predicateFromFilterGroup(
  group: FilterGroup,
  allowedFields?: string[],
  fieldMetaMap?: Record<string, FilterFieldMeta>,
  depth = 0,
  limits?: { maxFilterValueBytes?: number },
): PredicateNode | undefined {
  const state = { count: 0 }
  return parseFilterGroup(group, allowedFields, fieldMetaMap, depth, state, limits)
}

function parseFilterGroup(
  group: FilterGroup,
  allowedFields?: string[],
  fieldMetaMap?: Record<string, FilterFieldMeta>,
  depth = 0,
  state: { count: number } = { count: 0 },
  limits?: { maxFilterValueBytes?: number },
): PredicateNode | undefined {
  if (!isRecord(group)) throw new ValidationError("Filter group must be an object")
  if (depth > MAX_NESTING_DEPTH) throw new ValidationError("Filter nesting depth exceeds the maximum")
  if (group.logic !== undefined && group.logic !== "AND" && group.logic !== "OR") {
    throw new ValidationError("Filter group logic must be AND or OR")
  }
  if (group.conditions !== undefined && !Array.isArray(group.conditions)) {
    throw new ValidationError("Filter group conditions must be an array")
  }
  if (group.search !== undefined && typeof group.search !== "string") {
    throw new ValidationError("Filter search must be a string")
  }
  const conditions: unknown[] = Array.isArray(group.conditions) ? group.conditions : []

  const predicates: PredicateNode[] = []

  if (conditions.length > 0) {
    for (const condition of conditions) {
      if (++state.count > MAX_CONDITIONS) {
        throw new ValidationError(`Filter condition count exceeds the maximum of ${MAX_CONDITIONS}`)
      }
      if (isFilterGroup(condition)) {
        const nested = parseFilterGroup(condition, allowedFields, fieldMetaMap, depth + 1, state, limits)
        if (nested) predicates.push(nested)
      } else {
        const cond = predicateFromFilterCondition(condition, allowedFields, fieldMetaMap, limits)
        if (cond) predicates.push(cond)
      }
    }
  }

  if (predicates.length === 0) return undefined
  if (predicates.length === 1) return predicates[0]
  return group.logic === "OR" ? Predicate.or(...predicates) : Predicate.and(...predicates)
}

export function searchToPredicate(
  searchTerm: string,
  searchableColumns: string[],
  strategy?: EntitySearchStrategy,
): PredicateNode | undefined {
  // Full-text search cannot be represented as a persistence-neutral predicate
  // (PredicateOp has no full-text operator) and must never silently degrade to
  // a contains/%term% probe. Refuse to run rather than weaken the search.
  if (strategy?.kind === "fullText") {
    throw new ConfigurationError(
      `Search strategy "fullText"${strategy.indexName ? ` (index "${strategy.indexName}")` : ""} is not supported by this handler; configure a "contains" or "prefix" search strategy`
    )
  }
  const build = strategy?.kind === "prefix" ? Predicate.startsWith : Predicate.contains
  const predicates = searchableColumns
    .filter((col) => col)
    .map((col) => build(col, searchTerm))
  if (predicates.length === 0) return undefined
  return predicates.length === 1
       ? predicates[0]!
    : Predicate.or(...predicates)
}

export interface SearchLimits {
  maxSearchBytes?: number
  maxSearchableColumns?: number
  maxFilterJsonBytes?: number
  maxFilterValueBytes?: number
}

export function filtersToPredicate(
  filters: string,
  searchableColumns: string[],
  filterableColumns?: string[],
  fieldMetaMap?: Record<string, FilterFieldMeta>,
  limits: SearchLimits = {},
  strategy?: EntitySearchStrategy,
): PredicateNode | undefined {
  if (!filters) return undefined
  const maxFilterJsonBytes = limits.maxFilterJsonBytes ?? DEFAULT_MAX_QUERY_JSON_BYTES
  assertByteBound(filters, maxFilterJsonBytes, `Filters JSON exceeds the maximum of ${maxFilterJsonBytes} UTF-8 bytes`)
  let parsed: unknown
  try {
    parsed = JSON.parse(filters)
  } catch {
    throw new ValidationError("Invalid filters JSON")
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) {
    throw new ValidationError("Filters must be a JSON object")
  }

  const predicates: PredicateNode[] = []

  if (typeof parsed.search === "string" && parsed.search.length > 0 && searchableColumns.length > 0) {
    if (limits.maxSearchBytes !== undefined && new TextEncoder().encode(parsed.search).byteLength > limits.maxSearchBytes) {
      throw new ValidationError(`Search text exceeds the maximum of ${limits.maxSearchBytes} UTF-8 bytes`)
    }
    if (limits.maxSearchableColumns !== undefined && searchableColumns.length > limits.maxSearchableColumns) {
      throw new ValidationError(`Search fanout exceeds the maximum of ${limits.maxSearchableColumns} columns`)
    }
    const searchPred = searchToPredicate(parsed.search, searchableColumns, strategy)
    if (searchPred) predicates.push(searchPred)
  }

  const filterPred = predicateFromFilterGroup(parsed, filterableColumns, fieldMetaMap, 0, limits)
  if (filterPred) predicates.push(filterPred)

  if (predicates.length === 0) return undefined
  if (predicates.length === 1) return predicates[0]
  return Predicate.and(...predicates)
}

export interface ParseSortOptions {
  allowedFields?: string[]
  maxKeys?: number
  maxBytes?: number
}

export const DEFAULT_MAX_SORT_KEYS = 3

export function parseSortString(sorting?: string, options: ParseSortOptions = {}): SortSpec[] | undefined {
  if (!sorting) return undefined
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_QUERY_JSON_BYTES
  assertByteBound(sorting, maxBytes, `Sorting JSON exceeds the maximum of ${maxBytes} UTF-8 bytes`)
  let parsed: unknown
  try {
    parsed = JSON.parse(sorting)
  } catch {
    throw new ValidationError("Invalid sorting JSON")
  }
  if (!Array.isArray(parsed)) throw new ValidationError("Sorting must be a JSON array")
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_SORT_KEYS
  if (parsed.length > maxKeys) throw new ValidationError(`Sorting supports at most ${maxKeys} keys`)
  return parsed.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
      throw new ValidationError(`Invalid sort entry at index ${index}`)
    }
    if (options.allowedFields && !options.allowedFields.includes(entry.id)) {
      throw new ValidationError(`Sorting by field "${entry.id}" is not allowed`)
    }
    if (entry.desc !== undefined && typeof entry.desc !== "boolean") {
      throw new ValidationError(`Invalid sort direction at index ${index}`)
    }
    return {
      field: entry.id,
      direction: entry.desc ? "desc" as const : "asc" as const,
    }
  })
}
