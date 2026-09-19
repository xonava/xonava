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

export function resolveTieredDecision<TPolicy>(args: {
  policies: TPolicy[]
  getPriority(policy: TPolicy): number
  getEffect(policy: TPolicy): "allow" | "deny"
  matches(policy: TPolicy): boolean
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
    const matched = tier.filter((p) => args.matches(p))

    if (matched.length === 0) continue

    const denies = matched.filter((p) => args.getEffect(p) === "deny")

    if (denies.length > 0) {
      return {
        allowed: false,
        reason: "DENY_POLICY_MATCHED",
        priority,
        matchedPolicies: matched,
        decidingPolicies: denies,
      }
    }

    return {
      allowed: true,
      reason: "ALLOW_POLICY_MATCHED",
      priority,
      matchedPolicies: matched,
      decidingPolicies: matched,
    }
  }

  return {
    allowed: args.defaultEffect === "allow",
    reason: "NO_POLICY_MATCHED",
    matchedPolicies: [],
    decidingPolicies: [],
  }
}
