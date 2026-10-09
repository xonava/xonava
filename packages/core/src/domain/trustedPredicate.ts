import type { PredicateNode } from "./predicate"

/**
 * Identity brand for framework-built mandatory scopes (structural tenant/row
 * scopes and ABAC action scopes). A caller-supplied predicate can never carry
 * it: the brand is held in a module-private WeakSet keyed by object identity,
 * so a parsed, cloned, or forged copy of a scope is untrusted.
 *
 * Query budgets (validateQueryPlan) limit the work a CALLER may ask for. A
 * trusted scope only ever narrows a query and is bounded by policy
 * normalization, so it is validated against separate hard limits instead of
 * the caller's budget; see core/query/queryBudget.
 *
 * FRAMEWORK-INTERNAL. It is exported from core/domain only because adapters
 * (which can import nothing but the package barrels) brand the structural
 * scopes they build. Never wrap a caller-supplied or caller-influenced
 * predicate: the brand exempts it from the caller's query budget (it does not
 * grant or widen access, but it removes the work bound on that predicate).
 */
const trusted = new WeakSet<object>()

/** Framework-internal: brands a framework-built mandatory scope (see above). */
export function markTrustedPredicate<T extends PredicateNode>(node: T): T {
  if (node !== null && typeof node === "object") trusted.add(node)
  return node
}

export function isTrustedPredicate(node: unknown): boolean {
  return node !== null && typeof node === "object" && trusted.has(node)
}
