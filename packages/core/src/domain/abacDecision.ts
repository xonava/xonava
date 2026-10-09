import { type PredicateNode } from "./predicate"
import { resolveTieredDecision } from "./abacTierDecision"
import { evaluatePredicateTruth } from "./evaluatePredicate"
import { buildActionScope } from "./abacReadScope"
import { simplifyPredicate, isAlwaysFalse, isAlwaysTrue } from "./predicateSimplifier"
import type { NormalizedAbacPolicy, AbacPolicyBundle } from "./abacTypes"

export interface AbacDecision {
  allowed: boolean
  target: {
    type: "action" | "capability" | "field-read" | "field-write"
    key: string
  }
  reasonCode:
    | "ALLOW_POLICY_MATCHED"
    | "DENY_POLICY_MATCHED"
    | "NO_RELEVANT_POLICY"
    | "NO_POLICY_MATCHED"
  priority?: number
  evidence: Array<{
    policyId?: string
    effect: "allow" | "deny"
    priority: number
    scopeType?: string
    scopeRefId?: string | null
  }>
}

/** Three-valued match (`null` is UNKNOWN) so record decisions agree with the query scope. */
function policyMatchesRecord(policy: NormalizedAbacPolicy, record: Record<string, unknown>): boolean | null {
  return evaluatePredicateTruth(record, policy.compiledConditions)
}

/**
 * Record-less match: only an unconditional allow can grant, while any deny
 * that is not statically false is assumed to match (fail closed), because some
 * record or context the global grant covers may satisfy it.
 */
function policyMatchesGlobally(policy: NormalizedAbacPolicy): boolean {
  const simplified = simplifyPredicate(policy.compiledConditions)
  return policy.effect === "allow" ? isAlwaysTrue(simplified) : !isAlwaysFalse(simplified)
}

export function toEvidence(policy: NormalizedAbacPolicy): AbacDecision["evidence"][number] {
  const evidence: AbacDecision["evidence"][number] = {
    policyId: policy.source.policyId,
    effect: policy.effect,
    priority: policy.priority,
    scopeType: policy.source.scopeType,
  }
  if (policy.source.scopeRefId !== undefined) evidence.scopeRefId = policy.source.scopeRefId
  return evidence
}

export function evaluateAbacRecordAction(args: {
  bundle: AbacPolicyBundle
  action: string
  record: Record<string, unknown>
}): AbacDecision {
  const relevant = args.bundle.policies.filter(
    (p) => p.moduleKey === args.bundle.moduleKey && p.payload.actions.includes(args.action),
  )

  const result = resolveTieredDecision({
    policies: relevant,
    getPriority: (p) => p.priority,
    getEffect: (p) => p.effect,
    matches: (p) => policyMatchesRecord(p, args.record),
    defaultEffect: args.bundle.defaultEffect,
  })

  const decision: AbacDecision = {
    allowed: result.allowed,
    target: { type: "action", key: args.action },
    reasonCode: result.reason,
    evidence: result.decidingPolicies.map(toEvidence).concat(
      result.matchedPolicies.filter((mp) => !result.decidingPolicies.includes(mp)).map(toEvidence),
    ),
  }
  if (result.priority !== undefined) decision.priority = result.priority
  return decision
}

export function evaluateGlobalAbacCapability(args: {
  bundle: AbacPolicyBundle
  capability: string
}): AbacDecision {
  const relevant = args.bundle.policies.filter(
    (p) => p.moduleKey === args.bundle.moduleKey && p.payload.capabilities.includes(args.capability),
  )

  const result = resolveTieredDecision({
    policies: relevant,
    getPriority: (p) => p.priority,
    getEffect: (p) => p.effect,
    matches: policyMatchesGlobally,
    defaultEffect: "deny",
  })

  const decision: AbacDecision = {
    allowed: result.allowed,
    target: { type: "capability", key: args.capability },
    reasonCode: result.reason,
    evidence: result.decidingPolicies.map(toEvidence).concat(
      result.matchedPolicies.filter((mp) => !result.decidingPolicies.includes(mp)).map(toEvidence),
    ),
  }
  if (result.priority !== undefined) decision.priority = result.priority
  return decision
}

export function evaluateAbacRecordCapability(args: {
  bundle: AbacPolicyBundle
  capability: string
  record: Record<string, unknown>
}): AbacDecision {
  const relevant = args.bundle.policies.filter(
    (p) => p.moduleKey === args.bundle.moduleKey && p.payload.capabilities.includes(args.capability),
  )

  const result = resolveTieredDecision({
    policies: relevant,
    getPriority: (p) => p.priority,
    getEffect: (p) => p.effect,
    matches: (p) => policyMatchesRecord(p, args.record),
    defaultEffect: "deny",
  })

  const decision: AbacDecision = {
    allowed: result.allowed,
    target: { type: "capability", key: args.capability },
    reasonCode: result.reason,
    evidence: result.decidingPolicies.map(toEvidence).concat(
      result.matchedPolicies.filter((mp) => !result.decidingPolicies.includes(mp)).map(toEvidence),
    ),
  }
  if (result.priority !== undefined) decision.priority = result.priority
  return decision
}

export interface AbacCollectionDecision {
  allowed: boolean
  scope: PredicateNode
  reasonCode: "ACTION_SCOPE_AVAILABLE" | "NO_ALLOW_POLICY" | "STATICALLY_DENIED"
  evidence: Array<{
    policyId?: string
    effect: "allow" | "deny"
    priority: number
    scopeType?: string
    scopeRefId?: string | null
  }>
}

export function evaluateAbacActionForCollection(args: {
  bundle: AbacPolicyBundle
  action: string
}): AbacCollectionDecision {
  const scope = buildActionScope({ bundle: args.bundle, action: args.action })
  const simplifiedScope = simplifyPredicate(scope.filter)

  if (isAlwaysFalse(simplifiedScope)) {
    return {
      allowed: false,
      scope: simplifiedScope,
      reasonCode: "STATICALLY_DENIED",
      evidence: [],
    }
  }

  const hasAllowPolicy = args.bundle.policies.some(
    (p) => p.moduleKey === args.bundle.moduleKey && p.payload.actions.includes(args.action) && p.effect === "allow",
  )

  const defaultEffect = args.bundle.defaultEffect

  if (!hasAllowPolicy && defaultEffect === "deny") {
    return {
      allowed: false,
      scope: simplifiedScope,
      reasonCode: "NO_ALLOW_POLICY",
      evidence: [],
    }
  }

  return {
    allowed: true,
    scope: simplifiedScope,
    reasonCode: "ACTION_SCOPE_AVAILABLE",
    evidence: args.bundle.policies
      .filter((p) => p.moduleKey === args.bundle.moduleKey && p.payload.actions.includes(args.action))
      .map((p) => {
        const evidence: AbacCollectionDecision["evidence"][number] = {
        policyId: p.source.policyId,
        effect: p.effect,
        priority: p.priority,
        scopeType: p.source.scopeType,
        }
        if (p.source.scopeRefId !== undefined) evidence.scopeRefId = p.source.scopeRefId
        return evidence
      }),
  }
}


