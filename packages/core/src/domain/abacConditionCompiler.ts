import { Predicate, type PredicateNode, type PredicatePrimitive, type PredicateRangeValue } from "./predicate"
import type { AbacContext } from "./abacTypes"
import type { PolicyConditionGroup, PolicyConditions, PolicyFilterClause } from "./abacPolicySchema"
import { normalizeUserAttribute } from "./abacPolicySchema"
import { coercePolicyValue, coercePolicyValueList } from "./coercePolicyValue"
import type { AbacFieldDefinition } from "./abacCatalog"

export type PredicateCompileResult =
  | { success: true; predicate: PredicateNode }
  | { success: false; error: string }

/**
 * A user attribute that resolves to undefined/null is never coerced into a
 * literal ("undefined", 0). Its clause compiles to the fail-closed constant for
 * the policy effect: always-false for allow (grants nothing), always-true for
 * deny (the deny still applies). Conditions only combine with AND/OR, so the
 * substitution is monotone in the safe direction.
 */
const UNRESOLVED = Symbol("unresolvedUserAttribute")

type PolicyEffect = "allow" | "deny"

function unresolvedPredicate(effect: PolicyEffect | undefined): PredicateNode {
  return effect === "deny" ? Predicate.alwaysTrue() : Predicate.alwaysFalse()
}

function resolveUserAttr(context: AbacContext, userAttr: string): unknown {
  if (userAttr === "user.id") return context.userId
  if (userAttr === "user.roleId") return context.roleId
  if (userAttr === "user.branchId") return context.branchId
  if (userAttr === "user.departmentId") return context.departmentId
  if (userAttr === "user.tenantId") return context.tenantId
  return undefined
}

function asPrimitive(value: unknown): PredicatePrimitive | undefined {
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

function asPrimitiveList(values: unknown[]): PredicatePrimitive[] {
  return values
    .map((value) => asPrimitive(value))
    .filter((value): value is PredicatePrimitive => value !== undefined)
}

function combineOr(filters: PredicateNode[]): PredicateNode {
  if (filters.length === 0) return Predicate.alwaysFalse()
  const first = filters[0]
  return filters.length === 1 && first ? first : Predicate.or(...filters)
}

function combineAnd(filters: PredicateNode[]): PredicateNode {
  if (filters.length === 0) return Predicate.alwaysFalse()
  const first = filters[0]
  return filters.length === 1 && first ? first : Predicate.and(...filters)
}

function toBetweenValue(value: unknown): PredicateRangeValue | undefined {
  if (Array.isArray(value) && value.length === 2) {
    const from = asPrimitive(value[0])
    const to = asPrimitive(value[1])
    if (from === undefined && to === undefined) return undefined
    const range: PredicateRangeValue = {}
    if (from !== undefined) range.from = from
    if (to !== undefined) range.to = to
    return range
  }

  if (value && typeof value === "object") {
    const record = value as { from?: unknown; to?: unknown }
    const from = asPrimitive(record.from)
    const to = asPrimitive(record.to)
    if (from === undefined && to === undefined) return undefined
    const range: PredicateRangeValue = {}
    if (from !== undefined) range.from = from
    if (to !== undefined) range.to = to
    return range
  }

  return undefined
}

export function normalizeContextAttribute(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined
  return normalizeUserAttribute(input)
}

function resolvePresentUserAttr(context: AbacContext, userAttr: string): unknown {
  return resolveUserAttr(context, userAttr) ?? UNRESOLVED
}

function resolveClauseValue(clause: PolicyFilterClause, context: AbacContext): unknown {
  if (clause.userAttr) return resolvePresentUserAttr(context, clause.userAttr)

  if (typeof clause.value === "string") {
    const userAttr = normalizeUserAttribute(clause.value)
    if (userAttr) return resolvePresentUserAttr(context, userAttr)
  }

  return clause.value
}

function coerceClauseValue(
  field: string,
  value: unknown,
  fieldCatalog: Record<string, AbacFieldDefinition>,
): { success: true; value: unknown } | { success: false; error: string } {
  if (!Object.hasOwn(fieldCatalog, field)) {
    return { success: true, value }
  }
  const fieldDef = fieldCatalog[field]
  try {
    const coerced = coercePolicyValue({ type: fieldDef!.type, value })
    // A `date` literal stays a calendar date ("YYYY-MM-DD"), never an instant:
    // date columns hydrate as such strings (compared as strings) or as
    // UTC-midnight Dates (compared as instants, which parse the full-date at
    // UTC midnight), and only the full-date form equals both. Normalization
    // would otherwise serialize the Date as "...T00:00:00.000Z", which no
    // string-hydrated date ever equals (a date-equality deny would fail open).
    if (fieldDef!.type === "date" && coerced instanceof Date) {
      const iso = coerced.toISOString()
      // Only a UTC-midnight instant in years 0000-9999 is a calendar date.
      if (!/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(iso)) return { success: false, error: `Cannot coerce value for field "${field}": not a calendar date: ${iso}` }
      return { success: true, value: iso.slice(0, 10) }
    }
    return { success: true, value: coerced }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, error: `Cannot coerce value for field "${field}": ${message}` }
  }
}

export function policyClauseToPredicate(args: {
  clause: PolicyFilterClause
  context: AbacContext
  fieldCatalog: Record<string, AbacFieldDefinition>
  /** Selects the fail-closed constant for unresolved user attributes; defaults to allow semantics. */
  effect?: PolicyEffect
}): PredicateCompileResult {
  const field = args.clause.field
  if (!Object.hasOwn(args.fieldCatalog, args.clause.field)) {
    return { success: false, error: `Unknown field: ${args.clause.field}` }
  }
  const operator = args.clause.operator ?? "equals"
  if (operator === "isEmpty") return { success: true, predicate: Predicate.isEmpty(field) }
  if (operator === "isNotEmpty") return { success: true, predicate: Predicate.isNotEmpty(field) }
  if (operator === "isTrue") return { success: true, predicate: Predicate.isTrue(field) }
  if (operator === "isFalse") return { success: true, predicate: Predicate.isFalse(field) }
  if (operator === "isNull") return { success: true, predicate: Predicate.isNull(field) }
  if (operator === "isNotNull") return { success: true, predicate: Predicate.isNotNull(field) }

  const resolvedValue = resolveClauseValue(args.clause, args.context)

  if (operator === "includesAny" || operator === "includesAll" || operator === "in") {
    const rawValues = Array.isArray(args.clause.values)
      ? args.clause.values
      : resolvedValue !== undefined
        ? [resolvedValue]
        : []
    const resolved = rawValues.map((v) => {
      if (typeof v === "string") {
        const userAttr = normalizeUserAttribute(v)
        if (userAttr) return resolvePresentUserAttr(args.context, userAttr)
      }
      return v
    })
    // An unresolved list member grants nothing under allow; under deny the
    // clause cannot be proven not to match, so the deny applies.
    if (resolved.includes(UNRESOLVED) && args.effect === "deny") return { success: true, predicate: Predicate.alwaysTrue() }
    const normalized = resolved.filter((v) => v !== UNRESOLVED)
    const fieldDef = Object.hasOwn(args.fieldCatalog, field) ? args.fieldCatalog[field] : undefined
    if (fieldDef?.type === "string-array") {
      const result = coercePolicyValueList({ type: fieldDef.type, values: normalized })
      if (!result.success) return { success: false, error: result.errors.map((error) => error.message).join("; ") }
      if (result.values.length === 0) return { success: true, predicate: Predicate.alwaysFalse() }
      const predicate = operator === "includesAny"
        ? Predicate.includesAny(field, result.values)
        : operator === "includesAll"
          ? Predicate.includesAll(field, result.values)
          : Predicate.in(field, result.values)
      return { success: true, predicate }
    }

    const coercedList: unknown[] = []
    for (const v of normalized) {
      const r = coerceClauseValue(field, v, args.fieldCatalog)
      if (!r.success) return r
      coercedList.push(r.value)
    }
    const values = asPrimitiveList(coercedList)
    if (values.length > 0) return { success: true, predicate: operator === "includesAny" ? Predicate.includesAny(field, values) : operator === "includesAll" ? Predicate.includesAll(field, values) : Predicate.in(field, values) }
    return { success: true, predicate: Predicate.alwaysFalse() }
  }

  if (resolvedValue === UNRESOLVED) return { success: true, predicate: unresolvedPredicate(args.effect) }

  if (operator === "between") {
    const raw = args.clause.value ?? args.clause.values
    const betweenValue = toBetweenValue(raw)
    if (betweenValue) {
      let coercedFrom: PredicatePrimitive | undefined
      if (betweenValue.from !== undefined) {
        const fromResult = coerceClauseValue(field, betweenValue.from, args.fieldCatalog)
        if (!fromResult.success) return fromResult
        const value = asPrimitive(fromResult.value)
        if (value === undefined) return { success: false, error: `Invalid lower bound for field "${field}"` }
        coercedFrom = value
      }
      let coercedTo: PredicatePrimitive | undefined
      if (betweenValue.to !== undefined) {
        const toResult = coerceClauseValue(field, betweenValue.to, args.fieldCatalog)
        if (!toResult.success) return toResult
        const value = asPrimitive(toResult.value)
        if (value === undefined) return { success: false, error: `Invalid upper bound for field "${field}"` }
        coercedTo = value
      }
      const range: PredicateRangeValue = {}
      if (coercedFrom !== undefined) range.from = coercedFrom
      if (coercedTo !== undefined) range.to = coercedTo
      return { success: true, predicate: Predicate.between(field, range) }
    }
    return { success: false, error: `Invalid between value for field "${field}"` }
  }

  const coercedResult = coerceClauseValue(field, resolvedValue, args.fieldCatalog)
  if (!coercedResult.success) return coercedResult
  const coercedValue = coercedResult.value

  const primitive = asPrimitive(coercedValue)
  if (primitive === undefined) return { success: true, predicate: Predicate.alwaysFalse() }

  if (operator === "equals") return { success: true, predicate: Predicate.eq(field, primitive) }
  if (operator === "notEquals") return { success: true, predicate: Predicate.neq(field, primitive) }
  if (operator === "contains") {
    if (typeof primitive === "string") return { success: true, predicate: Predicate.contains(field, primitive) }
    return { success: false, error: `Operator "contains" requires a string value for field "${field}", got ${typeof primitive}` }
  }
  if (operator === "startsWith") {
    if (typeof primitive === "string") return { success: true, predicate: Predicate.startsWith(field, primitive) }
    return { success: false, error: `Operator "startsWith" requires a string value for field "${field}", got ${typeof primitive}` }
  }
  if (operator === "endsWith") {
    if (typeof primitive === "string") return { success: true, predicate: Predicate.endsWith(field, primitive) }
    return { success: false, error: `Operator "endsWith" requires a string value for field "${field}", got ${typeof primitive}` }
  }
  if (operator === "greaterThan" || operator === "after") return { success: true, predicate: Predicate.gt(field, primitive) }
  if (operator === "lessThan" || operator === "before") return { success: true, predicate: Predicate.lt(field, primitive) }
  if (operator === "greaterOrEqual") return { success: true, predicate: Predicate.gte(field, primitive) }
  if (operator === "lessOrEqual") return { success: true, predicate: Predicate.lte(field, primitive) }

  return { success: false, error: `Unsupported ABAC operator: ${String(operator)}` }
}

function isConditionGroup(input: PolicyConditionGroup | PolicyFilterClause): input is PolicyConditionGroup {
  return "logic" in input && Array.isArray(input.conditions)
}

export function conditionGroupToPredicate(args: {
  group: PolicyConditionGroup
  context: AbacContext
  fieldCatalog: Record<string, AbacFieldDefinition>
  effect?: PolicyEffect
}): PredicateCompileResult {
  if (args.group.conditions.length === 0) {
    return {
      success: true,
      predicate: args.group.logic === "AND" ? Predicate.alwaysTrue() : Predicate.alwaysFalse(),
    }
  }

  const results = args.group.conditions.map((condition) => {
    if (isConditionGroup(condition)) {
      return conditionGroupToPredicate({ group: condition, context: args.context, fieldCatalog: args.fieldCatalog, ...(args.effect ? { effect: args.effect } : {}) })
    }
    return policyClauseToPredicate({ clause: condition, context: args.context, fieldCatalog: args.fieldCatalog, ...(args.effect ? { effect: args.effect } : {}) })
  })

  const errors = results.filter((r): r is { success: false; error: string } => !r.success)
  if (errors.length > 0) {
    return { success: false, error: errors.map((e) => e.error).join("; ") }
  }

  const predicates = results.flatMap((result) => (result.success ? [result.predicate] : []))
  const combined = args.group.logic === "OR" ? combineOr(predicates) : combineAnd(predicates)

  return { success: true, predicate: combined }
}

export function policyConditionsToPredicate(args: {
  conditions: PolicyConditions
  context: AbacContext
  fieldCatalog: Record<string, AbacFieldDefinition>
  effect?: PolicyEffect
}): PredicateCompileResult {
  const effect = args.effect ? { effect: args.effect } : {}
  const systemResult = conditionGroupToPredicate({ group: args.conditions.systemScope, context: args.context, fieldCatalog: args.fieldCatalog, ...effect })
  if (!systemResult.success) return systemResult

  const userResult = conditionGroupToPredicate({ group: args.conditions.userFilters, context: args.context, fieldCatalog: args.fieldCatalog, ...effect })
  if (!userResult.success) return userResult

  return { success: true, predicate: combineAnd([systemResult.predicate, userResult.predicate]) }
}
