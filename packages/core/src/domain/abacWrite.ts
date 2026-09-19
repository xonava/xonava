import { evaluatePredicate } from "./evaluatePredicate"
import { ForbiddenError } from "./errors"
import { resolveTieredDecision } from "./abacTierDecision"
import { assertPolicyWritableFields } from "./fieldAccess"
import { toEvidence } from "./abacDecision"
import type { NormalizedAbacPolicy, AbacPolicyBundle } from "./abacTypes"
import { assertVerifiedAbacBundle } from "./abacBundleIntegrity"

export interface WriteAccessEvaluation {
  allowed: boolean
  reasonCode: string
  message: string
  policyMeta?: { moduleKey: string; effect: "allow" | "deny"; priority: number }
  evidence: Array<{
    policyId?: string
    effect: "allow" | "deny"
    priority: number
    scopeType?: string
    scopeRefId?: string | null
  }>
}

function policyAppliesToAction(policy: NormalizedAbacPolicy, action: string): boolean {
  return policy.payload.actions.includes(action)
}

function policyMatchesRecord(policy: NormalizedAbacPolicy, record: Record<string, unknown>): boolean {
  return evaluatePredicate(record, policy.compiledConditions)
}

export function evaluateWriteAccessForRecordDetailed(args: {
  policies: NormalizedAbacPolicy[]
  moduleKey: string
  action: string
  record: Record<string, unknown>
}): WriteAccessEvaluation {
  const relevant = args.policies.filter(
    (policy) => policy.moduleKey === args.moduleKey && policyAppliesToAction(policy, args.action),
  )

  const result = resolveTieredDecision({
    policies: relevant,
    getPriority: (p) => p.priority,
    getEffect: (p) => p.effect,
    matches: (p) => policyMatchesRecord(p, args.record),
    defaultEffect: "deny",
  })

  const evidence = relevant.map(toEvidence)

  switch (result.reason) {
    case "ALLOW_POLICY_MATCHED":
      return {
        allowed: true,
        reasonCode: "ALLOW_POLICY_MATCHED",
        message: "An allow policy matched this record.",
        policyMeta: {
          moduleKey: args.moduleKey,
          effect: result.decidingPolicies[0]?.effect ?? "allow",
          priority: result.decidingPolicies[0]?.priority ?? 0,
        },
        evidence,
      }
    case "DENY_POLICY_MATCHED":
      return {
        allowed: false,
        reasonCode: "DENY_POLICY_MATCHED",
        message: "You do not have permission to update this record with the current values.",
        policyMeta: {
          moduleKey: args.moduleKey,
          effect: "deny",
          priority: result.decidingPolicies[0]?.priority ?? 0,
        },
        evidence,
      }
    case "NO_RELEVANT_POLICY":
      return {
        allowed: false,
        reasonCode: "NO_RELEVANT_POLICY",
        message: "No matching policy restrictions found for this action.",
        evidence,
      }
    default:
      return {
        allowed: false,
        reasonCode: "NO_POLICY_MATCHED_RECORD",
        message: "You do not have permission to update this record with the current values.",
        evidence,
      }
  }
}

export function enforceAbacWrite(args: {
  bundle: AbacPolicyBundle
  action: string
  record: Record<string, unknown>
  changedFields?: string[]
}): void {
  assertVerifiedAbacBundle(args.bundle)
  if (args.action !== "delete") {
    assertPolicyWritableFields({
      policies: args.bundle.policies,
      moduleKey: args.bundle.moduleKey,
      action: args.action,
      record: args.record,
      ...(args.changedFields !== undefined ? { changedFields: args.changedFields } : {}),
    })
  }

  const evaluation = evaluateWriteAccessForRecordDetailed({
    policies: args.bundle.policies,
    moduleKey: args.bundle.moduleKey,
    action: args.action,
    record: args.record,
  })

  if (evaluation.allowed) return

  throw new ForbiddenError(evaluation.message, {
    reasonCode: evaluation.reasonCode,
    moduleKey: args.bundle.moduleKey,
    action: args.action,
    policy: evaluation.policyMeta,
    evidence: evaluation.evidence,
  })
}
