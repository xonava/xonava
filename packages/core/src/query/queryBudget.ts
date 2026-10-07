import { ValidationError } from "../domain/errors.js"
import type { PredicateOp } from "../domain/predicate.js"
import type { QueryPlan } from "./queryPlan.js"

export interface QueryBudget { readonly maxPredicateDepth: number; readonly maxPredicateNodes: number; readonly maxOrBranches: number; readonly maxInValues: number; readonly maxSortFields: number; readonly maxProjectionFields: number; readonly maxSearchBytes: number }

export const DEFAULT_QUERY_BUDGET: QueryBudget = Object.freeze({ maxPredicateDepth: 5, maxPredicateNodes: 50, maxOrBranches: 20, maxInValues: 100, maxSortFields: 5, maxProjectionFields: 50, maxSearchBytes: 4096 })

/** Hard syntax limits which are independent of an individual query's work budget. */
const MAX_QUERY_FIELD_BYTES = 1024
const MAX_QUERY_CURSOR_BYTES = 16_384

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

function scalar(value: unknown, label: string, active: ReadonlySet<object>): void {
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

export function validateQueryPlan(plan: QueryPlan, budget: QueryBudget = DEFAULT_QUERY_BUDGET): void {
  const limits = parseQueryBudget(budget)
  const active = new Set<object>()
  let nodes = 0
  let orBranches = 0

  const enter = (value: object): void => {
    if (active.has(value)) fail("query plan contains a cycle")
    active.add(value)
  }
  const leave = (value: object): void => { active.delete(value) }

  const visitPredicate = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== "object") fail("query predicate must be an object")
    enter(value)
    try {
      nodes += 1
      if (depth > limits.maxPredicateDepth) fail("query predicate exceeds maximum depth")
      if (nodes > limits.maxPredicateNodes) fail("query predicate exceeds maximum node count")

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
          const values = denseArray(node.value, `${typedOp} predicate.value`, limits.maxInValues, "query predicate exceeds maximum IN values")
          for (const item of values) scalar(item, `${typedOp} predicate value`, active)
          return
        }
        if (typedOp === "between") {
          if (node.value === null || typeof node.value !== "object") fail("between predicate.value must be an object")
          enter(node.value)
          try {
            const range = dataRecord(node.value, "between predicate.value", ["from", "to"])
            if (!own(range, "from") && !own(range, "to")) fail("between predicate requires at least one bound")
            if (own(range, "from")) scalar(range.from, "between predicate.from", active)
            if (own(range, "to")) scalar(range.to, "between predicate.to", active)
          } finally { leave(node.value) }
          return
        }
        scalar(node.value, `${typedOp} predicate.value`, active)
        return
      }
      if (kind === "and" || kind === "or") {
        const node = dataRecord(value, `${kind} predicate`, ["kind", "filters"])
        const filters = denseArray(required(node, "filters", `${kind} predicate`), `${kind} predicate.filters`, limits.maxPredicateNodes - nodes, "query predicate exceeds maximum node count")
        if (kind === "or") {
          orBranches += filters.length
          if (orBranches > limits.maxOrBranches) fail("query predicate exceeds maximum OR branches")
        }
        enter(filters)
        try { for (const child of filters) visitPredicate(child, depth + 1) } finally { leave(filters) }
        return
      }
      if (kind === "not") {
        const node = dataRecord(value, "not predicate", ["kind", "filter"])
        visitPredicate(required(node, "filter", "not predicate"), depth + 1)
        return
      }
      fail(`query predicate has unknown kind ${String(kind)}`)
    } finally { leave(value) }
  }

  const root = dataRecord(plan, "query plan", ["filter", "sort", "pagination", "projection", "consistency", "search"])
  enter(plan)
  try {
    if (own(root, "filter")) visitPredicate(root.filter, 1)
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
