import { Predicate, type PredicateNode } from "./predicate"
import { buildTieredPolicyOutcome } from "./policyTierResolver"
import type { AbacPolicyBundle, AbacReadScope } from "./abacTypes"
import { assertVerifiedAbacBundle } from "./abacBundleIntegrity"
import { markTrustedPredicate } from "./trustedPredicate"

function combineOr(filters: PredicateNode[]): PredicateNode {
  if (filters.length === 0) return Predicate.alwaysFalse()
  const first = filters[0]
  return filters.length === 1 && first !== undefined ? first : Predicate.or(...filters)
}

function combineAnd(filters: PredicateNode[]): PredicateNode {
  if (filters.length === 0) return Predicate.alwaysTrue()
  const first = filters[0]
  return filters.length === 1 && first !== undefined ? first : Predicate.and(...filters)
}

export function buildActionScope(args: {
  bundle: AbacPolicyBundle
  action: string
}): AbacReadScope {
  assertVerifiedAbacBundle(args.bundle)
  const defaultEffect = (args.bundle as AbacPolicyBundle).defaultEffect

  const relevant = args.bundle.policies.filter(
    (policy) => policy.moduleKey === args.bundle.moduleKey && policy.payload.actions.includes(args.action),
  )
  if (relevant.length === 0) {
    return {
      filter: markTrustedPredicate(defaultEffect === "allow" ? Predicate.alwaysTrue() : Predicate.alwaysFalse()),
      ...(args.bundle.cacheScopeKey !== undefined ? { cacheScopeKey: args.bundle.cacheScopeKey } : {}),
    }
  }

  const filter = buildTieredPolicyOutcome({
    policies: relevant.map((policy) => ({
      effect: policy.effect,
      priority: policy.priority,
      match: policy.compiledConditions,
    })),
    getPriority: (policy) => policy.priority,
    getEffect: (policy) => policy.effect,
    getMatch: (policy) => policy.match,
    ops: {
      alwaysTrue: () => Predicate.alwaysTrue(),
      alwaysFalse: () => Predicate.alwaysFalse(),
      and: combineAnd,
      or: combineOr,
      not: (expression) => Predicate.not(expression),
    },
  })

  // A mandatory scope: query budgets validate it separately from caller filters.
  return { filter: markTrustedPredicate(filter), ...(args.bundle.cacheScopeKey !== undefined ? { cacheScopeKey: args.bundle.cacheScopeKey } : {}) }
}
