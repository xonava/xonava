import { ConfigurationError, ValidationError } from "../domain/errors.js"
import { MAX_PREDICATE_EVALUATION_DEPTH } from "../domain/evaluatePredicate.js"
import { isTrustedPredicate } from "../domain/trustedPredicate.js"
import type { PredicateOp } from "../domain/predicate.js"
import type { QueryPlan } from "./queryPlan.js"

export interface QueryBudget { readonly maxPredicateDepth: number; readonly maxPredicateNodes: number; readonly maxOrBranches: number; readonly maxInValues: number; readonly maxSortFields: number; readonly maxProjectionFields: number; readonly maxSearchBytes: number }

export const DEFAULT_QUERY_BUDGET: QueryBudget = Object.freeze({ maxPredicateDepth: 5, maxPredicateNodes: 50, maxOrBranches: 20, maxInValues: 100, maxSortFields: 5, maxProjectionFields: 50, maxSearchBytes: 4096 })

/** Hard syntax limits which are independent of an individual query's work budget. */
const MAX_QUERY_FIELD_BYTES = 1024
const MAX_QUERY_CURSOR_BYTES = 16_384
/** Per string literal and per plan, so `in` lists cannot carry megabytes of values. */
export const MAX_QUERY_VALUE_BYTES = 8192
export const MAX_QUERY_TOTAL_VALUE_BYTES = 65_536

const encoder = new TextEncoder()
const budgetKeys = Object.keys(DEFAULT_QUERY_BUDGET) as (keyof QueryBudget)[]
const predicateOps = new Set<PredicateOp>([
  "eq", "neq", "contains", "startsWith", "endsWith", "isEmpty", "isNotEmpty",
  "gt", "lt", "gte", "lte", "isTrue", "isFalse", "isNull", "isNotNull",
  "in", "includesAny", "includesAll", "between",
])
const valuelessOps = new Set<PredicateOp>(["isEmpty", "isNotEmpty", "isTrue", "isFalse", "isNull", "isNotNull"])
const listOps = new Set<PredicateOp>(["in", "includesAny", "includesAll"])

type DataRecord = Readonly<Record<string, unknown>>

function fail(message: string): never { throw new ValidationError(message) }

function dataRecord(value: unknown, label: string, allowedKeys: readonly string[]): DataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a plain object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`)
  if (Object.getOwnPropertySymbols(value).length > 0) fail(`${label} must not contain symbol keys`)

  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const allowed = new Set(allowedKeys)
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(key)) fail(`Unknown field ${key} in ${label}`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !("value" in descriptor)) fail(`${label}.${key} must be a data property`)
    result[key] = descriptor.value
  }
  return result
}

function denseArray(value: unknown, label: string, maximumLength?: number, maximumMessage?: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(`${label} must be an array`)
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length")
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) fail(`${label} has an invalid length`)
  const length = lengthDescriptor.value as number
  if (maximumLength !== undefined && length > maximumLength) fail(maximumMessage ?? `${label} exceeds maximum length`)
  if (Object.getOwnPropertySymbols(value).length > 0) fail(`${label} must not contain symbol keys`)
  const names = Object.getOwnPropertyNames(value)
  if (names.length !== length + 1 || !names.includes("length")) fail(`${label} must be a dense array without extra properties`)
  const result: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !("value" in descriptor)) fail(`${label} must be a dense array of data properties`)
    result.push(descriptor.value)
  }
  return result
}

function own(record: DataRecord, key: string): boolean { return Object.hasOwn(record, key) }

function required(record: DataRecord, key: string, label: string): unknown {
  if (!own(record, key)) fail(`${label}.${key} is required`)
  return record[key]
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${label} must be a non-empty string`)
  if (encoder.encode(value).byteLength > maxBytes) fail(`${label} exceeds maximum UTF-8 bytes`)
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${label} must be a positive safe integer`)
  return value as number
}

function scalar(value: unknown, label: string, active: ReadonlySet<object>, valueBytes?: { total: number }): void {
  if (typeof value === "string") {
    const bytes = encoder.encode(value).byteLength
    if (bytes > MAX_QUERY_VALUE_BYTES) fail(`${label} exceeds ${MAX_QUERY_VALUE_BYTES} UTF-8 bytes`)
    if (valueBytes) {
      valueBytes.total += bytes
      if (valueBytes.total > MAX_QUERY_TOTAL_VALUE_BYTES) fail(`query predicate values exceed ${MAX_QUERY_TOTAL_VALUE_BYTES} UTF-8 bytes`)
    }
    return
  }
  if (value instanceof Date) {
    if (Object.getPrototypeOf(value) !== Date.prototype || !Number.isFinite(Date.prototype.getTime.call(value))) fail(`${label} must be a valid Date`)
    return
  }
  if (value !== null && typeof value === "object") {
    if (active.has(value)) fail("query plan contains a cycle")
    fail(`${label} must be a scalar value`)
  }
  if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) fail(`${label} must be a finite safe number`)
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" && value !== null) fail(`${label} must be a scalar value`)
}

function parseQueryBudget(budget: QueryBudget): QueryBudget {
  const record = dataRecord(budget, "query budget", budgetKeys)
  for (const key of budgetKeys) positiveInteger(required(record, key, "query budget"), key)
  return record as unknown as QueryBudget
}

export function assertQueryBudget(budget: QueryBudget): void { parseQueryBudget(budget) }

/**
 * Builds a strict, frozen query budget from a wider limits object (for example
 * entity query limits, which also carry pagination/count/search limits that are
 * enforced elsewhere). Only budget keys are read; absent keys take defaults.
 */
export function compileQueryBudget(limits?: object): QueryBudget {
  const budget: Record<string, unknown> = { ...DEFAULT_QUERY_BUDGET }
  const declared = (limits ?? {}) as Readonly<Record<string, unknown>>
  for (const key of budgetKeys) {
    if (Object.hasOwn(declared, key) && declared[key] !== undefined) budget[key] = declared[key]
  }
  return Object.freeze(parseQueryBudget(budget as unknown as QueryBudget))
}

interface PredicateWalk {
  readonly limits: Pick<QueryBudget, "maxPredicateDepth" | "maxPredicateNodes" | "maxOrBranches" | "maxInValues">
  readonly trusted: boolean
  nodes: number
  orBranches: number
  readonly valueBytes: { total: number }
}

/**
 * Hard limits for framework-built mandatory scopes (markTrustedPredicate):
 * structural and ABAC scopes only narrow a query, are bounded by policy
 * normalization, and must never consume the caller's query budget, but they
 * still have to stay evaluable (MAX_PREDICATE_EVALUATION_DEPTH) and finite.
 */
const TRUSTED_SCOPE_LIMITS = Object.freeze({ maxPredicateDepth: MAX_PREDICATE_EVALUATION_DEPTH, maxPredicateNodes: 100_000, maxOrBranches: 100_000, maxInValues: 100_000 })

function isTransparentConjunction(value: object): boolean {
  const kind = Object.getOwnPropertyDescriptor(value, "kind")
  const filters = Object.getOwnPropertyDescriptor(value, "filters")
  return kind !== undefined && "value" in kind && kind.value === "and" &&
    filters !== undefined && Array.isArray(filters.value) && (filters.value as unknown[]).some(isTrustedPredicate)
}

export function validateQueryPlan(plan: QueryPlan, budget: QueryBudget = DEFAULT_QUERY_BUDGET): void {
  const limits = parseQueryBudget(budget)
  const active = new Set<object>()
  const callerWalk: PredicateWalk = { limits, trusted: false, nodes: 0, orBranches: 0, valueBytes: { total: 0 } }

  const enter = (value: object): void => {
    if (active.has(value)) fail("query plan contains a cycle")
    active.add(value)
  }
  const leave = (value: object): void => { active.delete(value) }

  /**
   * `depth` is the depth charged to the walk's budget; `nesting` is the real
   * nesting depth, which must stay evaluable whatever the budgets allow.
   */
  const visitPredicate = (value: unknown, depth: number, nesting: number, walk: PredicateWalk): void => {
    if (value === null || typeof value !== "object") fail("query predicate must be an object")
    if (!walk.trusted && isTrustedPredicate(value)) {
      // A trusted scope is checked against hard limits with its own counters;
      // any problem with it is a server configuration error, not a bad request.
      const trustedWalk: PredicateWalk = { limits: TRUSTED_SCOPE_LIMITS, trusted: true, nodes: 0, orBranches: 0, valueBytes: { total: 0 } }
      try {
        visitPredicate(value, 1, nesting, trustedWalk)
      } catch (error) {
        if (error instanceof ValidationError) throw new ConfigurationError(`Trusted query scope is invalid: ${error.message}`)
        throw error
      }
      return
    }
    if (nesting > MAX_PREDICATE_EVALUATION_DEPTH) {
      if (walk.trusted) fail(`query predicate nesting exceeds ${MAX_PREDICATE_EVALUATION_DEPTH} levels`)
      throw new ConfigurationError(`Query predicate combined with trusted scopes exceeds ${MAX_PREDICATE_EVALUATION_DEPTH} levels`)
    }
    enter(value)
    try {
      // `and(..., trustedScope, ...)` is the framework conjoining a mandatory
      // scope: it is not charged to the caller (nodes or depth); the caller's
      // own conjuncts are charged as if they stood alone.
      if (!walk.trusted && isTransparentConjunction(value)) {
        const node = dataRecord(value, "and predicate", ["kind", "filters"])
        const filters = denseArray(required(node, "filters", "and predicate"), "and predicate.filters", TRUSTED_SCOPE_LIMITS.maxPredicateNodes, "query predicate exceeds maximum node count")
        enter(filters)
        try { for (const child of filters) visitPredicate(child, depth, nesting + 1, walk) } finally { leave(filters) }
        return
      }
      walk.nodes += 1
      if (depth > walk.limits.maxPredicateDepth) fail("query predicate exceeds maximum depth")
      if (walk.nodes > walk.limits.maxPredicateNodes) fail("query predicate exceeds maximum node count")

      const base = dataRecord(value, "query predicate", ["kind", "field", "op", "value", "filters", "filter"])
      const kind = required(base, "kind", "query predicate")
      if (kind === "literal") {
        const node = dataRecord(value, "literal predicate", ["kind", "value"])
        if (required(node, "value", "literal predicate") !== true && node.value !== false) fail("literal predicate.value must be boolean")
        return
      }
      if (kind === "condition") {
        const node = dataRecord(value, "condition predicate", ["kind", "field", "op", "value"])
        boundedString(required(node, "field", "condition predicate"), "condition predicate.field", MAX_QUERY_FIELD_BYTES)
        const op = required(node, "op", "condition predicate")
        if (typeof op !== "string" || !predicateOps.has(op as PredicateOp)) fail(`condition predicate has unknown operator ${String(op)}`)
        const typedOp = op as PredicateOp
        const hasValue = own(node, "value")
        if (valuelessOps.has(typedOp)) {
          if (hasValue) fail(`predicate operator ${typedOp} does not accept a value`)
          return
        }
        if (!hasValue) fail(`predicate operator ${typedOp} requires a value`)
        if (listOps.has(typedOp)) {
          const values = denseArray(node.value, `${typedOp} predicate.value`, walk.limits.maxInValues, "query predicate exceeds maximum IN values")
          for (const item of values) scalar(item, `${typedOp} predicate value`, active, walk.valueBytes)
          return
        }
        if (typedOp === "between") {
          if (node.value === null || typeof node.value !== "object") fail("between predicate.value must be an object")
          enter(node.value)
          try {
            const range = dataRecord(node.value, "between predicate.value", ["from", "to"])
            if (!own(range, "from") && !own(range, "to")) fail("between predicate requires at least one bound")
            if (own(range, "from")) scalar(range.from, "between predicate.from", active, walk.valueBytes)
            if (own(range, "to")) scalar(range.to, "between predicate.to", active, walk.valueBytes)
          } finally { leave(node.value) }
          return
        }
        scalar(node.value, `${typedOp} predicate.value`, active, walk.valueBytes)
        return
      }
      if (kind === "and" || kind === "or") {
        const node = dataRecord(value, `${kind} predicate`, ["kind", "filters"])
        const filters = denseArray(required(node, "filters", `${kind} predicate`), `${kind} predicate.filters`, walk.limits.maxPredicateNodes - walk.nodes, "query predicate exceeds maximum node count")
        if (kind === "or") {
          walk.orBranches += filters.length
          if (walk.orBranches > walk.limits.maxOrBranches) fail("query predicate exceeds maximum OR branches")
        }
        enter(filters)
        try { for (const child of filters) visitPredicate(child, depth + 1, nesting + 1, walk) } finally { leave(filters) }
        return
      }
      if (kind === "not") {
        const node = dataRecord(value, "not predicate", ["kind", "filter"])
        visitPredicate(required(node, "filter", "not predicate"), depth + 1, nesting + 1, walk)
        return
      }
      fail(`query predicate has unknown kind ${String(kind)}`)
    } finally { leave(value) }
  }

  const root = dataRecord(plan, "query plan", ["filter", "sort", "pagination", "projection", "consistency", "search"])
  enter(plan)
  try {
    if (own(root, "filter")) visitPredicate(root.filter, 1, 1, callerWalk)
    if (own(root, "sort")) {
      const sort = denseArray(root.sort, "query sort", limits.maxSortFields, "query exceeds maximum sort fields")
      const fields = new Set<string>()
      for (const value of sort) {
        const item = dataRecord(value, "query sort item", ["field", "direction", "nulls"])
        const field = boundedString(required(item, "field", "query sort item"), "query sort field", MAX_QUERY_FIELD_BYTES)
        if (fields.has(field)) fail("query sort fields must be unique")
        fields.add(field)
        const direction = required(item, "direction", "query sort item")
        if (direction !== "asc" && direction !== "desc") fail("query sort direction must be asc or desc")
        if (own(item, "nulls") && item.nulls !== "first" && item.nulls !== "last") fail("query sort null ordering must be first or last")
      }
    }
    if (own(root, "pagination")) {
      const pagination = dataRecord(root.pagination, "query pagination", ["kind", "page", "pageSize", "after", "before", "limit"])
      const kind = required(pagination, "kind", "query pagination")
      if (kind === "offset") {
        const offset = dataRecord(root.pagination, "offset pagination", ["kind", "page", "pageSize"])
        positiveInteger(required(offset, "page", "offset pagination"), "offset pagination.page")
        positiveInteger(required(offset, "pageSize", "offset pagination"), "offset pagination.pageSize")
      } else if (kind === "cursor") {
        const cursor = dataRecord(root.pagination, "cursor pagination", ["kind", "after", "before", "limit"])
        positiveInteger(required(cursor, "limit", "cursor pagination"), "cursor pagination.limit")
        if (own(cursor, "after") === own(cursor, "before")) fail("cursor pagination must set exactly one of after or before")
        const boundary = own(cursor, "after") ? cursor.after : cursor.before
        boundedString(boundary, "cursor pagination boundary", MAX_QUERY_CURSOR_BYTES)
      } else fail(`query pagination has unknown kind ${String(kind)}`)
    }
    if (own(root, "projection")) {
      const projection = dataRecord(root.projection, "query projection", ["fields"])
      const fields = denseArray(required(projection, "fields", "query projection"), "query projection.fields", limits.maxProjectionFields, "query exceeds maximum projection fields")
      const unique = new Set<string>()
      for (const value of fields) {
        const field = boundedString(value, "query projection field", MAX_QUERY_FIELD_BYTES)
        if (unique.has(field)) fail("query projection fields must be unique")
        unique.add(field)
      }
    }
    if (own(root, "consistency") && root.consistency !== "strong" && root.consistency !== "session" && root.consistency !== "eventual") fail("query consistency is invalid")
    if (own(root, "search")) {
      const search = dataRecord(root.search, "query search", ["text"])
      const text = required(search, "text", "query search")
      if (typeof text !== "string") fail("query search.text must be a string")
      if (encoder.encode(text).byteLength > limits.maxSearchBytes) fail("query search exceeds maximum UTF-8 bytes")
    }
  } finally { leave(plan) }
}
