import { evaluateWriteConditionTruth } from "./abacWriteMatch"
import { ForbiddenError, ValidationError } from "./errors"
import { parseRfc3339Timestamp } from "./evaluatePredicate"
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

/**
 * Three-valued match (`null` is UNKNOWN) so write decisions agree with the
 * query scope; see evaluateWriteConditionTruth for the create exception.
 */
function policyMatchesRecord(policy: NormalizedAbacPolicy, record: Record<string, unknown>, action: string): boolean | null {
  return evaluateWriteConditionTruth(record, policy.compiledConditions, action)
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
    matches: (p) => policyMatchesRecord(p, args.record, args.action),
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

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A written string for a catalog `date` field must be exactly YYYY-MM-DD.
 * Policy literals for date fields are calendar dates and string values are
 * compared as strings, so another spelling of a forbidden date (an ISO
 * date-time such as "2024-01-01T00:00:00.000Z", padding, a short form) would
 * evaluate as a different value and slip past a date-equality deny, while the
 * database casts it to the forbidden date. Date instances are compared as
 * instants and stay accepted. Only the written fields are checked: stored
 * rows are expected to hydrate date columns as YYYY-MM-DD strings or Dates.
 */
function assertCanonicalDateValues(bundle: AbacPolicyBundle, record: Record<string, unknown>, fields: readonly string[]): void {
  const catalog = bundle.fieldCatalog
  for (const field of fields) {
    if (!Object.hasOwn(catalog, field) || catalog[field]?.type !== "date" || !Object.hasOwn(record, field)) continue
    const value = record[field]
    if (typeof value === "string" && (!CALENDAR_DATE.test(value) || parseRfc3339Timestamp(value) === null)) {
      throw new ValidationError("date fields take YYYY-MM-DD", { field })
    }
  }
}

/**
 * Enforce a write against the post-image `record`. For updates, callers pass
 * the durable pre-image as `existing`: the field-write tier and the record
 * decision are then required to permit the write under BOTH images, so a patch
 * cannot escape a restricting policy by changing the attributes its condition
 * reads.
 */
export function enforceAbacWrite(args: {
  bundle: AbacPolicyBundle
  action: string
  record: Record<string, unknown>
  existing?: Record<string, unknown>
  changedFields?: string[]
}): void {
  assertVerifiedAbacBundle(args.bundle)
  if (args.action !== "delete") assertCanonicalDateValues(args.bundle, args.record, args.changedFields ?? Object.keys(args.record))
  if (args.action !== "delete") {
    assertPolicyWritableFields({
      policies: args.bundle.policies,
      moduleKey: args.bundle.moduleKey,
      action: args.action,
      record: args.record,
      ...(args.existing !== undefined ? { existing: args.existing } : {}),
      ...(args.changedFields !== undefined ? { changedFields: args.changedFields } : {}),
    })
  }

  const images = args.existing !== undefined ? [args.existing, args.record] : [args.record]
  for (const image of images) {
    const evaluation = evaluateWriteAccessForRecordDetailed({
      policies: args.bundle.policies,
      moduleKey: args.bundle.moduleKey,
      action: args.action,
      record: image,
    })

    if (evaluation.allowed) continue

    throw new ForbiddenError(evaluation.message, {
      reasonCode: evaluation.reasonCode,
      moduleKey: args.bundle.moduleKey,
      action: args.action,
      policy: evaluation.policyMeta,
      evidence: evaluation.evidence,
    })
  }
}
