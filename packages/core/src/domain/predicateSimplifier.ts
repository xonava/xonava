import { Predicate, type PredicateNode } from "./predicate"

export function simplifyPredicate(node: PredicateNode): PredicateNode {
  if (node.kind === "and") {
    const simplified = node.filters.map(simplifyPredicate)
    const hasFalse = simplified.some((c) => c.kind === "literal" && c.value === false)
    if (hasFalse) return Predicate.literal(false)
    const filtered = simplified.filter((c) => !(c.kind === "literal" && c.value === true))
    if (filtered.length === 0) return Predicate.literal(true)
    const first = filtered[0]
    if (filtered.length === 1 && first !== undefined) return first
    return Predicate.and(...filtered)
  }
  if (node.kind === "or") {
    const simplified = node.filters.map(simplifyPredicate)
    const hasTrue = simplified.some((c) => c.kind === "literal" && c.value === true)
    if (hasTrue) return Predicate.literal(true)
    const filtered = simplified.filter((c) => !(c.kind === "literal" && c.value === false))
    if (filtered.length === 0) return Predicate.literal(false)
    const first = filtered[0]
    if (filtered.length === 1 && first !== undefined) return first
    return Predicate.or(...filtered)
  }
  if (node.kind === "not") {
    const inner = simplifyPredicate(node.filter)
    if (inner.kind === "literal") return Predicate.literal(!inner.value)
    return Predicate.not(inner)
  }
  return node
}

export function isAlwaysTrue(node: PredicateNode): boolean {
  return node.kind === "literal" && node.value === true
}

export function isAlwaysFalse(node: PredicateNode): boolean {
  return node.kind === "literal" && node.value === false
}
