type PolicyEffect = "allow" | "deny"

export interface TieredExpressionOps<TExpression> {
  alwaysTrue(): TExpression
  alwaysFalse(): TExpression
  and(expressions: TExpression[]): TExpression
  or(expressions: TExpression[]): TExpression
  not(expression: TExpression): TExpression
}

export function buildTieredPolicyOutcome<TPolicy, TExpression>(args: {
  policies: TPolicy[]
  getPriority(policy: TPolicy): number
  getEffect(policy: TPolicy): PolicyEffect
  getMatch(policy: TPolicy): TExpression
  ops: TieredExpressionOps<TExpression>
}): TExpression {
  if (args.policies.length === 0) return args.ops.alwaysFalse()

  const groupedByPriority = new Map<number, TPolicy[]>()
  for (const policy of args.policies) {
    const priority = args.getPriority(policy)
    groupedByPriority.set(priority, [...(groupedByPriority.get(priority) ?? []), policy])
  }

  const sortedPriorities = Array.from(groupedByPriority.keys()).sort((a, b) => b - a)
  const allowAtTierClauses: TExpression[] = []
  let noHigherTierMatched = args.ops.alwaysTrue()

  for (const priority of sortedPriorities) {
    const tierPolicies = groupedByPriority.get(priority) ?? []
    const tierMatched = args.ops.or(tierPolicies.map((policy) => args.getMatch(policy)))
    const tierAllowMatched = args.ops.or(
      tierPolicies
        .filter((policy) => args.getEffect(policy) === "allow")
        .map((policy) => args.getMatch(policy)),
    )
    const tierDenyMatched = args.ops.or(
      tierPolicies
        // Fail closed: any effect other than an explicit "allow" denies.
        .filter((policy) => args.getEffect(policy) !== "allow")
        .map((policy) => args.getMatch(policy)),
    )

    allowAtTierClauses.push(args.ops.and([
      noHigherTierMatched,
      tierAllowMatched,
      args.ops.not(tierDenyMatched),
    ]))

    noHigherTierMatched = args.ops.and([
      noHigherTierMatched,
      args.ops.not(tierMatched),
    ])
  }

  return args.ops.or(allowAtTierClauses)
}
