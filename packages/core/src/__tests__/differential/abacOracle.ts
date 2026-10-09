import { Predicate, type PredicateNode } from "../../domain/predicate"
import { evaluatePredicate, evaluatePredicateTruth } from "../../domain/evaluatePredicate"
import { evaluateAbacActionForCollection, evaluateAbacRecordAction, evaluateAbacRecordCapability } from "../../domain/abacDecision"
import { buildActionScope } from "../../domain/abacReadScope"
import { hasGlobalAbacCapability } from "../../domain/abacCapabilities"
import { enforceAbacWrite } from "../../domain/abacWrite"
import { FIELD_READ_DEFAULT_KEY, resolveFieldQueryDenials, resolveFieldReadOverrides, type FieldReadMode, type FieldReadOverride } from "../../domain/fieldAccess"
import { buildTieredPolicyOutcome } from "../../domain/policyTierResolver"
import { ForbiddenError, ValidationError } from "../../domain/errors"
import type { AbacPolicyBundle, NormalizedAbacPolicy, VerifiedAbacPolicyBundle } from "../../domain/abacTypes"
import { generateRecord, fieldValue, DIFFERENTIAL_FIELDS } from "./arbitraries"
import { ABAC_ACTIONS, ABAC_CAPABILITIES, ABAC_MODULE, FIELD_KEYS } from "./abacArbitraries"
import type { Rng } from "./harness"

/**
 * Independent reference semantics for ABAC decisions, written from the
 * documented rules rather than from the implementation, plus "observe"
 * helpers that snapshot every externally visible authorization outcome of a
 * bundle so two bundles can be compared.
 */

export type Truth = boolean | null

/** Every capability a test probes, including one no policy ever names. */
export const PROBED_CAPABILITIES: readonly string[] = [...ABAC_CAPABILITIES, "neverGranted"]
export const RESTRICTIVENESS: Record<FieldReadMode, number> = { allow: 0, mask: 1, omit: 2 }

export function referencedFields(node: PredicateNode, out = new Set<string>()): Set<string> {
  if (node.kind === "condition") out.add(node.field)
  else if (node.kind === "not") referencedFields(node.filter, out)
  else if (node.kind === "and" || node.kind === "or") for (const child of node.filters) referencedFields(child, out)
  return out
}

/**
 * Reference tier resolution: walk distinct priorities from high to low; the
 * first tier containing a policy that is not FALSE decides. Any non-FALSE deny
 * denies; otherwise a TRUE allow allows; otherwise (only UNKNOWN allows) deny.
 */
export function referenceTier(
  policies: readonly NormalizedAbacPolicy[],
  truth: (policy: NormalizedAbacPolicy) => Truth,
): { allowed: boolean; priority?: number } {
  const byPriority = new Map<number, NormalizedAbacPolicy[]>()
  for (const policy of policies) byPriority.set(policy.priority, [...(byPriority.get(policy.priority) ?? []), policy])
  for (const priority of [...byPriority.keys()].sort((a, b) => b - a)) {
    const live = byPriority.get(priority)!.filter((policy) => truth(policy) !== false)
    if (live.length === 0) continue
    if (live.some((policy) => policy.effect !== "allow")) return { allowed: false, priority }
    return { allowed: live.some((policy) => truth(policy) === true), priority }
  }
  return { allowed: false }
}

export function actionPolicies(bundle: AbacPolicyBundle, action: string): NormalizedAbacPolicy[] {
  return bundle.policies.filter((policy) => policy.moduleKey === bundle.moduleKey && policy.payload.actions.includes(action))
}

export function capabilityPolicies(bundle: AbacPolicyBundle, capability: string): NormalizedAbacPolicy[] {
  return bundle.policies.filter((policy) => policy.moduleKey === bundle.moduleKey && policy.payload.capabilities.includes(capability))
}

/** Create semantics per abacWriteMatch: UNKNOWN caused by an ABSENT referenced field is no match. */
export function referenceWriteTruth(record: Record<string, unknown>, node: PredicateNode, action: string): Truth {
  const truth = evaluatePredicateTruth(record, node)
  if (truth !== null || action !== "create") return truth
  return [...referencedFields(node)].every((field) => Object.hasOwn(record, field)) ? null : false
}

export function referenceRecordDecision(bundle: AbacPolicyBundle, action: string, record: Record<string, unknown>): { allowed: boolean; priority?: number } {
  return referenceTier(actionPolicies(bundle, action), (policy) => evaluatePredicateTruth(record, policy.compiledConditions))
}

export function referenceWriteDecision(bundle: AbacPolicyBundle, action: string, record: Record<string, unknown>): { allowed: boolean; priority?: number } {
  return referenceTier(actionPolicies(bundle, action), (policy) => referenceWriteTruth(record, policy.compiledConditions, action))
}

/**
 * Field writability under an allowed decision: some TRUE allow at the
 * deciding tier grants the field (no write list = every field).
 */
export function referenceFieldWritable(bundle: AbacPolicyBundle, action: string, record: Record<string, unknown>, field: string): boolean {
  const decision = referenceWriteDecision(bundle, action, record)
  if (!decision.allowed) return false
  return actionPolicies(bundle, action).some((policy) =>
    policy.priority === decision.priority &&
    policy.effect === "allow" &&
    referenceWriteTruth(record, policy.compiledConditions, action) === true &&
    (!policy.payload.fieldAccess?.write?.length || policy.payload.fieldAccess.write.includes(field)))
}

/** Capability "scope": the tiered query expression a capability filter would compile to. */
export function capabilityScope(bundle: AbacPolicyBundle, capability: string): PredicateNode {
  const relevant = capabilityPolicies(bundle, capability)
  return buildTieredPolicyOutcome({
    policies: relevant,
    getPriority: (policy) => policy.priority,
    getEffect: (policy) => policy.effect,
    getMatch: (policy) => policy.compiledConditions,
    ops: {
      alwaysTrue: () => Predicate.alwaysTrue(),
      alwaysFalse: () => Predicate.alwaysFalse(),
      and: (filters) => Predicate.and(...filters),
      or: (filters) => Predicate.or(...filters),
      not: (filter) => Predicate.not(filter),
    },
  })
}

/** The mode projection applies to `field` (field entry, then the "*" default, then allow). */
export function effectiveReadMode(plan: Record<string, FieldReadOverride>, field: string): FieldReadMode {
  if (field !== FIELD_READ_DEFAULT_KEY && Object.hasOwn(plan, field)) return plan[field]!
  if (Object.hasOwn(plan, FIELD_READ_DEFAULT_KEY)) return plan[FIELD_READ_DEFAULT_KEY]!
  return "allow"
}

export function readPlan(bundle: AbacPolicyBundle, record: Record<string, unknown>): Record<string, FieldReadOverride> {
  return resolveFieldReadOverrides({ policies: bundle.policies, moduleKey: bundle.moduleKey, record })
}

export function queryDenials(bundle: AbacPolicyBundle): { filter: string[]; search: string[]; sort: string[] } {
  const denials = resolveFieldQueryDenials({ policies: bundle.policies, moduleKey: bundle.moduleKey, fields: FIELD_KEYS })
  return { filter: [...denials.filter].sort(), search: [...denials.search].sort(), sort: [...denials.sort].sort() }
}

// ---------------------------------------------------------------------------
// Write cases
// ---------------------------------------------------------------------------

export interface WriteCase {
  action: "create" | "update" | "delete"
  record: Record<string, unknown>
  existing?: Record<string, unknown>
  changedFields?: string[]
}

export function generatePatch(rng: Rng): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const field of rng.subset(DIFFERENTIAL_FIELDS, 0.3)) patch[field.key] = rng.bool(0.2) ? null : fieldValue(rng, field.type)
  return patch
}

export function generateWriteCases(rng: Rng, rows: ReadonlyArray<Record<string, unknown>>, count = 8): WriteCase[] {
  return Array.from({ length: count }, (): WriteCase => {
    const action = rng.pick(["create", "update", "update", "delete"] as const)
    if (action === "create") {
      const record = generateRecord(rng, { nullRate: 0.2, missingRate: 0.3 })
      return { action, record, changedFields: Object.keys(record) }
    }
    const existing = rng.pick(rows)
    if (action === "delete") return { action, record: existing }
    const patch = generatePatch(rng)
    return { action, existing, record: { ...existing, ...patch }, changedFields: Object.keys(patch) }
  })
}

export type WriteOutcome = "ok" | string

/** Runs enforceAbacWrite; returns "ok" or a stable description of the denial. */
export function writeOutcome(bundle: VerifiedAbacPolicyBundle, write: WriteCase): WriteOutcome {
  try {
    enforceAbacWrite({
      bundle,
      action: write.action,
      record: write.record,
      ...(write.existing !== undefined ? { existing: write.existing } : {}),
      ...(write.changedFields !== undefined ? { changedFields: write.changedFields } : {}),
    })
    return "ok"
  } catch (error) {
    if (error instanceof ValidationError) return `INVALID:${error.message}`
    if (!(error instanceof ForbiddenError)) throw error
    const details = (error as unknown as { details?: { reasonCode?: string; fields?: string[] } }).details ?? {}
    return `${details.reasonCode ?? "FORBIDDEN"}${details.fields ? `:${[...details.fields].sort().join(",")}` : ""}`
  }
}

// ---------------------------------------------------------------------------
// Observation snapshots
// ---------------------------------------------------------------------------

export interface BundleObservation {
  actions: Record<string, Array<{ allowed: boolean; reasonCode: string; priority?: number; evidence: string[] }>>
  scopes: Record<string, boolean[]>
  collection: Record<string, { allowed: boolean; reasonCode: string; rows: boolean[] }>
  recordCapabilities: Record<string, boolean[]>
  globalCapabilities: Record<string, boolean>
  readPlans: Array<Record<string, FieldReadOverride>>
  queryDenials: { filter: string[]; search: string[]; sort: string[] }
  writes: WriteOutcome[]
}

export function observeBundle(bundle: VerifiedAbacPolicyBundle, rows: ReadonlyArray<Record<string, unknown>>, writes: readonly WriteCase[]): BundleObservation {
  const observation: BundleObservation = {
    actions: {}, scopes: {}, collection: {}, recordCapabilities: {}, globalCapabilities: {},
    readPlans: rows.map((row) => readPlan(bundle, row)),
    queryDenials: queryDenials(bundle),
    writes: writes.map((write) => writeOutcome(bundle, write)),
  }
  for (const action of ABAC_ACTIONS) {
    const scope = buildActionScope({ bundle, action }).filter
    const collection = evaluateAbacActionForCollection({ bundle, action })
    observation.scopes[action] = rows.map((row) => evaluatePredicate(row, scope))
    observation.collection[action] = { allowed: collection.allowed, reasonCode: collection.reasonCode, rows: rows.map((row) => evaluatePredicate(row, collection.scope)) }
    observation.actions[action] = rows.map((row) => {
      const decision = evaluateAbacRecordAction({ bundle, action, record: row })
      return {
        allowed: decision.allowed,
        reasonCode: decision.reasonCode,
        ...(decision.priority !== undefined ? { priority: decision.priority } : {}),
        evidence: decision.evidence.map((item) => `${item.policyId}:${item.effect}`).sort(),
      }
    })
  }
  for (const capability of PROBED_CAPABILITIES) {
    observation.recordCapabilities[capability] = rows.map((row) => evaluateAbacRecordCapability({ bundle, capability, record: row }).allowed)
    observation.globalCapabilities[capability] = hasGlobalAbacCapability({ bundle, capabilityKey: capability })
  }
  return observation
}

export { ABAC_MODULE }
