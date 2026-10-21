import { policyConditionsToPredicate } from "./abacConditionCompiler"
import { validatePayloadAgainstCatalog } from "./abacPolicySchema"
import type { AbacPolicy, NormalizedAbacPolicy, AbacContext } from "./abacTypes"
import type { AbacFieldDefinition, AbacModuleCatalog } from "./abacCatalog"
import type { PredicateNode } from "./predicate"
import { deepFreeze } from "./abacBundleIntegrity"
import { findNonPortablePredicate, findUnsupportedPredicateCombination } from "./predicate"

export type NormalizePolicyResult = {
  success: true
  policy: NormalizedAbacPolicy
  /** Set when the policy is valid but currently outside its active window. */
  excluded?: "inactive"
} | {
  success: false
  errors: NormalizationError[]
}

export interface NormalizationError {
  code: string
  message: string
  path?: string
  policyId?: string
  /** The offending value (for catalog failures: the unknown action, capability or field name). */
  value?: unknown
}

function asDate(value: Date | string | null | undefined): Date | undefined {
  if (value == null) return undefined
  return typeof value === "string" ? new Date(value) : value
}

function isActive(source: AbacPolicy["source"], at: Date): boolean {
  const startsAt = asDate(source.startsAt)
  const endsAt = asDate(source.endsAt)
  if (startsAt && at < startsAt) return false
  if (endsAt && at > endsAt) return false
  return true
}

function validWindow(source: AbacPolicy["source"]): boolean {
  const startsAt = asDate(source.startsAt)
  const endsAt = asDate(source.endsAt)
  if (startsAt && Number.isNaN(startsAt.getTime())) return false
  if (endsAt && Number.isNaN(endsAt.getTime())) return false
  return !(startsAt && endsAt && startsAt > endsAt)
}

/**
 * String substring matching (collation/case/Unicode drift) and date scalar
 * ordering (evaluator-vs-DB date drift) are not portable across all persistence
 * engines. Reject them from security policies until every engine is proven
 * identical. Numeric gt/lt/gte/lte are portable, so date drift is rejected only
 * when the target field is a date/datetime type.
 */
function findNonPortableSecurityPredicate(
  node: PredicateNode,
  fields: Record<string, AbacFieldDefinition>,
): { op: string; field: string } | undefined {
  if (node.kind === "condition") {
    if (node.op === "contains" || node.op === "startsWith" || node.op === "endsWith") {
      return { op: node.op, field: node.field }
    }
    const fieldType = Object.hasOwn(fields, node.field) ? fields[node.field]?.type : undefined
    const isDateField = fieldType === "date" || fieldType === "datetime"
    if (isDateField && (node.op === "gt" || node.op === "lt" || node.op === "gte" || node.op === "lte" || node.op === "between")) {
      return { op: node.op, field: node.field }
    }
    return undefined
  }
  if (node.kind === "not") return findNonPortableSecurityPredicate(node.filter, fields)
  if (node.kind === "and" || node.kind === "or") {
    for (const filter of node.filters) {
      const found = findNonPortableSecurityPredicate(filter, fields)
      if (found) return found
    }
  }
  return undefined
}

/**
 * Date internal slots stay mutable under Object.freeze, so any Date that
 * survives into a normalized policy could be mutated by a caller. Replace every
 * Date instance with its canonical ISO string primitive so deepFreeze produces
 * a truly immutable durable payload.
 */
function canonicalizeDurable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(canonicalizeDurable)
  if (value && typeof value === "object") {
    const record: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      record[key] = canonicalizeDurable(entry)
    }
    return record
  }
  return value
}

export function normalizeAbacPolicy(args: {
  policy: AbacPolicy
  catalog: AbacModuleCatalog
  context: AbacContext
  at?: Date
}): NormalizePolicyResult {
  const errors: NormalizationError[] = []
  const at = args.at ?? new Date()

  const windowValid = validWindow(args.policy.source)
  if (!windowValid) {
    errors.push({ code: "POLICY_WINDOW_INVALID", message: "Policy active window is invalid", policyId: args.policy.source.policyId })
  }
  const inactive = !isActive(args.policy.source, at)

  // Anything but an explicit allow/deny would otherwise fall through tier
  // resolution as an allow; NaN/fractional priorities break tier grouping.
  const effect: unknown = args.policy.effect
  if (effect !== "allow" && effect !== "deny") {
    errors.push({ code: "POLICY_EFFECT_INVALID", message: `Policy effect must be "allow" or "deny"`, path: "effect", policyId: args.policy.source.policyId })
  }
  const priority: unknown = args.policy.priority
  if (typeof priority !== "number" || !Number.isSafeInteger(priority)) {
    errors.push({ code: "POLICY_PRIORITY_INVALID", message: "Policy priority must be a safe integer", path: "priority", policyId: args.policy.source.policyId })
  }

  if (args.policy.moduleKey !== args.catalog.moduleKey) {
    errors.push({
      code: "MODULE_KEY_MISMATCH",
      message: `Policy moduleKey "${args.policy.moduleKey}" does not match catalog moduleKey "${args.catalog.moduleKey}"`,
      policyId: args.policy.source.policyId,
    })
  }

  const catalogErrors = validatePayloadAgainstCatalog(args.policy.payload, args.catalog)
  if (catalogErrors.length > 0) {
    return {
      success: false,
      errors: catalogErrors.map(e => ({
        code: "CATALOG_VALIDATION_FAILED",
        message: e.message,
        path: e.path,
        policyId: args.policy.source.policyId,
        value: e.value,
      })),
    }
  }

  if (errors.length > 0) {
    return { success: false, errors }
  }

  const compileResult = policyConditionsToPredicate({
    conditions: args.policy.payload.conditions,
    context: args.context,
    fieldCatalog: args.catalog.fields,
    effect: args.policy.effect,
  })

  if (!compileResult.success) {
    return {
      success: false,
      errors: [{
        code: "CONDITION_COMPILATION_FAILED",
        message: compileResult.error,
        policyId: args.policy.source.policyId,
      }],
    }
  }

  const nonPortable = findNonPortablePredicate(compileResult.predicate)
  if (nonPortable) {
    return {
      success: false,
      errors: [{
        code: "NON_PORTABLE_PREDICATE",
        message: `Predicate operator "${nonPortable.op}" is not supported consistently by all persistence adapters`,
        policyId: args.policy.source.policyId,
      }],
    }
  }

  const securityViolation = findNonPortableSecurityPredicate(compileResult.predicate, args.catalog.fields)
  if (securityViolation) {
    return {
      success: false,
      errors: [{
        code: "NON_PORTABLE_PREDICATE",
        message: `Predicate operator "${securityViolation.op}" on field "${securityViolation.field}" is not supported consistently by all persistence adapters`,
        policyId: args.policy.source.policyId,
      }],
    }
  }

  const unsupported = findUnsupportedPredicateCombination(compileResult.predicate, args.catalog.fields)
  if (unsupported) {
    return {
      success: false,
      errors: [{
        code: "UNSUPPORTED_PREDICATE_COMBINATION",
        message: unsupported.message,
        path: `conditions.${unsupported.condition.field}`,
        policyId: args.policy.source.policyId,
      }],
    }
  }

  const normalized = deepFreeze(structuredClone(canonicalizeDurable({
    ...args.policy,
    compiledConditions: compileResult.predicate,
  }))) as NormalizedAbacPolicy

  if (inactive) {
    return { success: true, policy: normalized, excluded: "inactive" }
  }

  return { success: true, policy: normalized }
}
