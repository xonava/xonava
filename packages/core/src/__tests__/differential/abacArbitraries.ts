import { Predicate, type PredicateNode, type PredicatePrimitive, type PredicateValue } from "../../domain/predicate"
import { parseRfc3339Timestamp } from "../../domain/evaluatePredicate"
import { bindAbacSecurityDigest } from "../../domain/abacBundleIntegrity"
import type { AbacPolicyBundle, AbacScopeType, NormalizedAbacPolicy, VerifiedAbacPolicyBundle } from "../../domain/abacTypes"
import type { FieldPolicyReadMode, ParsedPolicyPayload, PolicyConditions, PolicyFieldAccess } from "../../domain/abacPolicySchema"
import { DIFFERENTIAL_FIELDS, differentialFieldCatalog, generatePredicate, generateRecord, shrinkPredicate, shrinkRecord, type DifferentialField } from "./arbitraries"
import { scaledRuns, type Rng } from "./harness"
import { TIMING_SCALE } from "../timing"

/**
 * Generators for random ABAC policy lists and verified bundles.
 *
 * Policies are shaped exactly like the output of `normalizeAbacPolicy`: plain,
 * date-free data (calendar dates stay "YYYY-MM-DD", instants become canonical
 * ISO strings; see canonicalPolicyLiteral), conditions limited to the
 * operators the normalizer accepts for security policies, and priorities drawn
 * from a tiny set so equal-priority tiers are common.
 */

/**
 * Per-test timeout for ABAC properties: each test checks hundreds of bundles,
 * so the 5s vitest default is too tight under parallel load, and the budget
 * grows with DIFFERENTIAL_SCALE.
 */
export const ABAC_PROPERTY_TIMEOUT_MS = 60_000 * Math.max(1, scaledRuns(100) / 100) * TIMING_SCALE

export const ABAC_MODULE = "diff.records"
export const FOREIGN_MODULE = "diff.other"
export const ABAC_ACTIONS = ["read", "create", "update", "delete"] as const
export const ABAC_CAPABILITIES = ["export", "approve"] as const
export const ABAC_PRIORITIES = [1, 5, 5, 10, 10, 20] as const
export const READ_MODES: readonly FieldPolicyReadMode[] = ["allow", "omit", "mask"]
/** The reserved read-plan default key; generated read maps use it occasionally. */
export const WILDCARD_FIELD = "*"
export const FIELD_KEYS: readonly string[] = DIFFERENTIAL_FIELDS.map((field) => field.key)

const SCOPE_TYPES: readonly AbacScopeType[] = ["tenant_default", "role", "user", "branch", "department"]

const EMPTY_CONDITIONS: PolicyConditions = Object.freeze({
  version: 2,
  systemScope: { logic: "AND", conditions: [] },
  userFilters: { logic: "AND", conditions: [] },
}) as PolicyConditions

export interface PolicyOptions {
  /** Probability the condition is the unconditional `alwaysTrue()` (default 0.45). */
  unconditionalRate?: number
  /** Probability of a fieldAccess block (default 0.4). */
  fieldAccessRate?: number
  /** Probability a read map contains the reserved "*" key (default 0.05). */
  wildcardRate?: number
  /** Probability the policy belongs to {@link FOREIGN_MODULE} (default 0). */
  foreignRate?: number
  effect?: "allow" | "deny"
  priority?: number
  fields?: readonly DifferentialField[]
}

function fieldTypeOf(field: string): DifferentialField["type"] | undefined {
  return DIFFERENTIAL_FIELDS.find((candidate) => candidate.key === field)?.type
}

/**
 * The literal `normalizeAbacPolicy` stores for a value of `type`: a `date`
 * stays a calendar date ("YYYY-MM-DD"), a `datetime` becomes the canonical
 * ISO instant (coercePolicyValue + canonicalizeDurable), and no Date survives.
 */
export function canonicalPolicyLiteral(type: DifferentialField["type"] | undefined, value: PredicatePrimitive): PredicatePrimitive {
  if (value instanceof Date) return type === "date" ? value.toISOString().slice(0, 10) : value.toISOString()
  if (type === "datetime" && typeof value === "string") {
    const time = parseRfc3339Timestamp(value)
    return time === null ? value : new Date(time).toISOString()
  }
  return value
}

function durableValue(type: DifferentialField["type"] | undefined, value: PredicateValue | undefined): PredicateValue | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value.map((item) => canonicalPolicyLiteral(type, item))
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const range: { from?: PredicatePrimitive; to?: PredicatePrimitive } = {}
    const source = value
    if (source.from !== undefined) range.from = canonicalPolicyLiteral(type, source.from)
    if (source.to !== undefined) range.to = canonicalPolicyLiteral(type, source.to)
    return range
  }
  return canonicalPolicyLiteral(type, value)
}

/**
 * Rewrites a generated predicate into one `normalizeAbacPolicy` would accept:
 * no substring operators, no date/datetime ordering, no Date instances
 * (normalization canonicalizes instants to ISO strings).
 */
export function toPolicyPredicate(node: PredicateNode): PredicateNode {
  switch (node.kind) {
    case "literal":
      return node
    case "not":
      return Predicate.not(toPolicyPredicate(node.filter))
    case "and":
    case "or":
      return { kind: node.kind, filters: node.filters.map(toPolicyPredicate) }
    case "condition": {
      const type = fieldTypeOf(node.field)
      const value = durableValue(type, node.value)
      const substring = node.op === "contains" || node.op === "startsWith" || node.op === "endsWith"
      const dateOrdering = (type === "date" || type === "datetime") &&
        (node.op === "gt" || node.op === "lt" || node.op === "gte" || node.op === "lte" || node.op === "between")
      if (substring) return Predicate.eq(node.field, typeof value === "string" ? value : null)
      if (dateOrdering) {
        const scalar = value && typeof value === "object" && !Array.isArray(value)
          ? ((value as { from?: PredicateValue; to?: PredicateValue }).from ?? (value as { to?: PredicateValue }).to)
          : value
        return Predicate.neq(node.field, (typeof scalar === "string" ? scalar : null))
      }
      return value === undefined ? { kind: "condition", field: node.field, op: node.op } : { kind: "condition", field: node.field, op: node.op, value }
    }
  }
}

export function generatePolicyCondition(rng: Rng, options: PolicyOptions = {}): PredicateNode {
  if (rng.bool(options.unconditionalRate ?? 0.45)) return Predicate.alwaysTrue()
  return toPolicyPredicate(generatePredicate(rng, { portable: true, maxDepth: 2, literalRate: 0.03, ...(options.fields ? { fields: options.fields } : {}) }))
}

export function generateFieldAccess(rng: Rng, options: PolicyOptions = {}): PolicyFieldAccess | undefined {
  const keys = (options.fields ?? DIFFERENTIAL_FIELDS).map((field) => field.key)
  const fieldAccess: PolicyFieldAccess = {}
  if (rng.bool(0.7)) {
    const read: Record<string, FieldPolicyReadMode> = {}
    for (const key of rng.subset(keys, 0.4)) read[key] = rng.pick(READ_MODES)
    if (rng.bool(options.wildcardRate ?? 0.05)) read[WILDCARD_FIELD] = rng.pick(READ_MODES)
    if (Object.keys(read).length > 0) fieldAccess.read = read
  }
  if (rng.bool(0.5)) {
    const write = rng.subset(keys, 0.35)
    if (write.length > 0) fieldAccess.write = write
  }
  if (rng.bool(0.3)) {
    const query: NonNullable<PolicyFieldAccess["query"]> = {}
    for (const mode of ["filter", "search", "sort"] as const) {
      const list = rng.subset(keys, 0.25)
      if (list.length > 0) query[mode] = list
    }
    if (Object.keys(query).length > 0) fieldAccess.query = query
  }
  return Object.keys(fieldAccess).length > 0 ? fieldAccess : undefined
}

let policyCounter = 0

export function makePolicy(args: {
  id?: string
  effect: "allow" | "deny"
  priority: number
  actions: string[]
  capabilities?: string[]
  when?: PredicateNode
  fieldAccess?: PolicyFieldAccess
  moduleKey?: string
  scopeType?: AbacScopeType
}): NormalizedAbacPolicy {
  const scopeType = args.scopeType ?? "tenant_default"
  const payload: ParsedPolicyPayload = {
    actions: args.actions,
    capabilities: args.capabilities ?? [],
    conditions: EMPTY_CONDITIONS,
    ...(args.fieldAccess ? { fieldAccess: args.fieldAccess } : {}),
  }
  return {
    source: {
      policyId: args.id ?? `p${++policyCounter}`,
      scopeType,
      ...(scopeType === "tenant_default" ? {} : { scopeRefId: `${scopeType}-1` }),
    },
    moduleKey: args.moduleKey ?? ABAC_MODULE,
    effect: args.effect,
    priority: args.priority,
    payload,
    compiledConditions: args.when ?? Predicate.alwaysTrue(),
  }
}

export function generatePolicy(rng: Rng, id: string, options: PolicyOptions = {}): NormalizedAbacPolicy {
  const fieldAccess = rng.bool(options.fieldAccessRate ?? 0.4) ? generateFieldAccess(rng, options) : undefined
  let actions = rng.subset(ABAC_ACTIONS, 0.55)
  const capabilities = rng.subset(ABAC_CAPABILITIES, 0.3)
  if (actions.length === 0 && capabilities.length === 0) actions = [rng.pick(ABAC_ACTIONS)]
  return makePolicy({
    id,
    effect: options.effect ?? (rng.bool(0.65) ? "allow" : "deny"),
    priority: options.priority ?? rng.pick(ABAC_PRIORITIES),
    actions,
    capabilities,
    when: generatePolicyCondition(rng, options),
    ...(fieldAccess ? { fieldAccess } : {}),
    ...(rng.bool(options.foreignRate ?? 0) ? { moduleKey: FOREIGN_MODULE } : {}),
    scopeType: rng.pick(SCOPE_TYPES),
  })
}

export function generatePolicies(rng: Rng, options: PolicyOptions & { min?: number; max?: number } = {}): NormalizedAbacPolicy[] {
  const min = options.min ?? 0
  const max = options.max ?? 6
  const count = min + rng.int(max - min + 1)
  return Array.from({ length: count }, (_, index) => generatePolicy(rng, `p${index}`, options))
}

export function bundleInput(policies: readonly NormalizedAbacPolicy[], extra: Partial<AbacPolicyBundle> = {}): Omit<AbacPolicyBundle, "securityDigest"> {
  return {
    mode: "tenant",
    moduleKey: ABAC_MODULE,
    policies: [...policies],
    context: { tenantId: "t1", userId: "u1", roleId: "role-1" },
    defaultEffect: "deny",
    fieldCatalog: differentialFieldCatalog(),
    ...extra,
  }
}

export function bindPolicies(policies: readonly NormalizedAbacPolicy[], extra: Partial<AbacPolicyBundle> = {}): Promise<VerifiedAbacPolicyBundle> {
  return bindAbacSecurityDigest(bundleInput(policies, extra))
}

/** Rows that collide with policy constants; NULL and missing keys are common. */
export function generateRows(rng: Rng, count = 10): Array<Record<string, unknown>> {
  const rows = Array.from({ length: count }, () => generateRecord(rng, { nullRate: 0.2, missingRate: 0.15 }))
  rows.push({})
  return rows
}

// ---------------------------------------------------------------------------
// Shrinking
// ---------------------------------------------------------------------------

function withoutKey<T extends object>(value: T, key: keyof T): T {
  const { [key]: _removed, ...rest } = value
  return rest as T
}

function* shrinkFieldAccess(fieldAccess: PolicyFieldAccess): Generator<PolicyFieldAccess | undefined> {
  yield undefined
  for (const key of ["read", "write", "query"] as const) {
    if (fieldAccess[key] === undefined) continue
    const rest = withoutKey(fieldAccess, key)
    yield Object.keys(rest).length > 0 ? rest : undefined
  }
  if (fieldAccess.read) {
    for (const field of Object.keys(fieldAccess.read)) {
      const read = withoutKey(fieldAccess.read, field)
      yield Object.keys(read).length > 0 ? { ...fieldAccess, read } : withoutKey(fieldAccess, "read")
    }
  }
  if (fieldAccess.write) {
    for (const field of fieldAccess.write) {
      const write = fieldAccess.write.filter((item) => item !== field)
      yield write.length > 0 ? { ...fieldAccess, write } : withoutKey(fieldAccess, "write")
    }
  }
  if (fieldAccess.query) {
    for (const mode of ["filter", "search", "sort"] as const) {
      for (const field of fieldAccess.query[mode] ?? []) {
        const list = (fieldAccess.query[mode] ?? []).filter((item) => item !== field)
        const query = list.length > 0 ? { ...fieldAccess.query, [mode]: list } : withoutKey(fieldAccess.query, mode)
        yield Object.keys(query).length > 0 ? { ...fieldAccess, query } : withoutKey(fieldAccess, "query")
      }
    }
  }
}

function withFieldAccess(policy: NormalizedAbacPolicy, fieldAccess: PolicyFieldAccess | undefined): NormalizedAbacPolicy {
  const payload = withoutKey(policy.payload, "fieldAccess")
  return { ...policy, payload: fieldAccess ? { ...payload, fieldAccess } : payload }
}

/** Smaller variants of one policy: simpler condition, fewer actions/capabilities/fieldAccess entries. */
export function* shrinkPolicy(policy: NormalizedAbacPolicy): Generator<NormalizedAbacPolicy> {
  const condition = policy.compiledConditions
  const unconditional = condition.kind === "and" && condition.filters.length === 0
  if (!unconditional) yield { ...policy, compiledConditions: Predicate.alwaysTrue() }
  for (const smaller of shrinkPredicate(condition)) yield { ...policy, compiledConditions: smaller }
  if (policy.payload.fieldAccess) {
    for (const fieldAccess of shrinkFieldAccess(policy.payload.fieldAccess)) yield withFieldAccess(policy, fieldAccess)
  }
  for (const action of policy.payload.actions) {
    yield { ...policy, payload: { ...policy.payload, actions: policy.payload.actions.filter((item) => item !== action) } }
  }
  for (const capability of policy.payload.capabilities) {
    yield { ...policy, payload: { ...policy.payload, capabilities: policy.payload.capabilities.filter((item) => item !== capability) } }
  }
  if (policy.source.scopeType !== "tenant_default") yield { ...policy, source: { policyId: policy.source.policyId, scopeType: "tenant_default" } }
}

/** Drop policies, then shrink each remaining policy in place. */
export function* shrinkPolicies(policies: readonly NormalizedAbacPolicy[]): Generator<NormalizedAbacPolicy[]> {
  for (let index = 0; index < policies.length; index++) yield policies.filter((_, position) => position !== index)
  for (let index = 0; index < policies.length; index++) {
    for (const smaller of shrinkPolicy(policies[index]!)) {
      yield policies.map((policy, position) => (position === index ? smaller : policy))
    }
  }
  // Collapse distinct priorities toward the smallest one (ties are the interesting case).
  const priorities = [...new Set(policies.map((policy) => policy.priority))].sort((a, b) => a - b)
  if (priorities.length > 1) {
    for (let index = 0; index < policies.length; index++) {
      if (policies[index]!.priority === priorities[0]) continue
      yield policies.map((policy, position) => (position === index ? { ...policy, priority: priorities[0]! } : policy))
    }
  }
}

/** Fewer rows, then smaller rows. */
export function* shrinkRows(rows: ReadonlyArray<Record<string, unknown>>): Generator<Array<Record<string, unknown>>> {
  if (rows.length > 1) {
    for (const row of rows) yield [row]
    for (let index = 0; index < rows.length; index++) yield rows.filter((_, position) => position !== index)
  }
  for (let index = 0; index < rows.length; index++) {
    for (const smaller of shrinkRecord(rows[index]!)) yield rows.map((row, position) => (position === index ? smaller : row))
  }
}

/** Shrinks a `{ policies, rows, ...rest }` case: policies first, then rows. */
export function* shrinkPolicyCase<T extends { policies: NormalizedAbacPolicy[]; rows: Array<Record<string, unknown>> }>(value: T): Generator<T> {
  if (value.rows.length > 1) for (const row of value.rows) yield { ...value, rows: [row] }
  for (const policies of shrinkPolicies(value.policies)) yield { ...value, policies }
  for (const rows of shrinkRows(value.rows)) yield { ...value, rows }
}

/** Shared forAll/forAllAsync options for `{ policies, rows }` cases. */
export const POLICY_CASE_OPTIONS = { shrink: shrinkPolicyCase, describe: describePolicyCase, maxShrinkSteps: 400 } as const

/** Compact, readable form of a case for failure reports. */
export function describePolicyCase(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => {
    if (item instanceof Date) return `Date(${item.toISOString()})`
    if (key === "conditions" && item && typeof item === "object" && "version" in item) return undefined
    if (key === "source" && item && typeof item === "object") return (item as { policyId: string }).policyId
    return item
  })
}
