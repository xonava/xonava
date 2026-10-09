import { evaluatePredicateTruth } from "./evaluatePredicate"
import type { PredicateNode } from "./predicate"

function referencedFields(node: PredicateNode, out: Set<string>): Set<string> {
  switch (node.kind) {
    case "condition":
      out.add(node.field)
      break
    case "and":
    case "or":
      for (const filter of node.filters) referencedFields(filter, out)
      break
    case "not":
      referencedFields(node.filter, out)
      break
  }
  return out
}

/**
 * Three-valued policy match for a write. Updates and deletes keep UNKNOWN
 * (the row already passed the three-valued action scope). A create has no
 * query scope and omitted fields take storage defaults, so UNKNOWN caused by a
 * field ABSENT from the create body is not meaningful and counts as no match;
 * when every referenced field is present (including an explicit null) UNKNOWN
 * stays UNKNOWN and fails closed.
 */
export function evaluateWriteConditionTruth(
  record: Record<string, unknown>,
  predicate: PredicateNode,
  action: string,
): boolean | null {
  const truth = evaluatePredicateTruth(record, predicate)
  if (truth !== null || action !== "create") return truth
  for (const field of referencedFields(predicate, new Set())) {
    if (!Object.hasOwn(record, field)) return false
  }
  return null
}
