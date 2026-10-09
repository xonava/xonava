export interface TierDecision<TPolicy> {
  allowed: boolean
  reason:
    | "ALLOW_POLICY_MATCHED"
    | "DENY_POLICY_MATCHED"
    | "NO_POLICY_MATCHED"
    | "NO_RELEVANT_POLICY"
  priority?: number
  matchedPolicies: TPolicy[]
  decidingPolicies: TPolicy[]
}

/**
 * Resolve the highest tier that a record (possibly) matches. `matches` may
 * return `null` for UNKNOWN (three-valued predicate truth); the decision then
 * agrees with the compiled query scope (`buildTieredPolicyOutcome`):
 * an UNKNOWN policy shadows lower tiers, an UNKNOWN deny matches (fail
 * closed), and an UNKNOWN allow never grants.
 */
export function resolveTieredDecision<TPolicy>(args: {
  policies: TPolicy[]
  getPriority(policy: TPolicy): number
  getEffect(policy: TPolicy): "allow" | "deny"
  matches(policy: TPolicy): boolean | null
  defaultEffect?: "allow" | "deny"
}): TierDecision<TPolicy> {
  if (args.policies.length === 0) {
    return {
      allowed: args.defaultEffect === "allow",
      reason: "NO_RELEVANT_POLICY",
      matchedPolicies: [],
      decidingPolicies: [],
    }
  }

  const priorities = Array.from(new Set(args.policies.map((p) => args.getPriority(p)))).sort((a, b) => b - a)

  for (const priority of priorities) {
    const tier = args.policies.filter((p) => args.getPriority(p) === priority)
    const truths = new Map(tier.map((p) => [p, args.matches(p)] as const))
    const matched = tier.filter((p) => truths.get(p) !== false)

    if (matched.length === 0) continue

    // Fail closed: only an explicit "allow" can allow; any other effect denies.
    const denies = matched.filter((p) => args.getEffect(p) !== "allow")

    if (denies.length > 0) {
      return {
        allowed: false,
        reason: "DENY_POLICY_MATCHED",
        priority,
        matchedPolicies: matched,
        decidingPolicies: denies,
      }
    }

    const allows = matched.filter((p) => truths.get(p) === true)
    if (allows.length === 0) {
      // Only UNKNOWN allows: the tier still shadows lower tiers but grants nothing.
      return {
        allowed: false,
        reason: "NO_POLICY_MATCHED",
        priority,
        matchedPolicies: [],
        decidingPolicies: [],
      }
    }

    return {
      allowed: true,
      reason: "ALLOW_POLICY_MATCHED",
      priority,
      matchedPolicies: allows,
      decidingPolicies: allows,
    }
  }

  return {
    allowed: args.defaultEffect === "allow",
    reason: "NO_POLICY_MATCHED",
    matchedPolicies: [],
    decidingPolicies: [],
  }
}
