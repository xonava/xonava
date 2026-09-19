import { ValidationError } from "../domain/errors.js"
import type { PredicateNode } from "../domain/predicate.js"
import type { QueryPlan } from "./queryPlan.js"
export interface QueryBudget { readonly maxPredicateDepth: number; readonly maxPredicateNodes: number; readonly maxOrBranches: number; readonly maxInValues: number; readonly maxSortFields: number; readonly maxProjectionFields: number; readonly maxSearchBytes: number }
export const DEFAULT_QUERY_BUDGET: QueryBudget = Object.freeze({ maxPredicateDepth: 5, maxPredicateNodes: 50, maxOrBranches: 20, maxInValues: 100, maxSortFields: 5, maxProjectionFields: 50, maxSearchBytes: 4096 })
function positive(value: number, name: string): void { if (!Number.isSafeInteger(value) || value < 1) throw new ValidationError(`${name} must be a positive safe integer`) }
export function assertQueryBudget(budget: QueryBudget): void {
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) throw new ValidationError("query budget must be an object")
  for (const name of Object.keys(DEFAULT_QUERY_BUDGET) as (keyof QueryBudget)[]) positive(budget[name], name)
  for (const name of Object.keys(budget)) if (!Object.hasOwn(DEFAULT_QUERY_BUDGET, name)) throw new ValidationError(`Unknown query budget field ${name}`)
}
export function validateQueryPlan(plan: QueryPlan, budget: QueryBudget = DEFAULT_QUERY_BUDGET): void {
  assertQueryBudget(budget); let nodes = 0; let orBranches = 0
  const visit = (node: PredicateNode, depth: number): void => {
    nodes += 1; if (depth > budget.maxPredicateDepth) throw new ValidationError("query predicate exceeds maximum depth")
    if (nodes > budget.maxPredicateNodes) throw new ValidationError("query predicate exceeds maximum node count")
    if (node.kind === "or") { orBranches += node.filters.length; if (orBranches > budget.maxOrBranches) throw new ValidationError("query predicate exceeds maximum OR branches") }
    if (node.kind === "condition" && node.op === "in" && Array.isArray(node.value) && node.value.length > budget.maxInValues) throw new ValidationError("query predicate exceeds maximum IN values")
    if (node.kind === "and" || node.kind === "or") node.filters.forEach(child => visit(child, depth + 1))
    else if (node.kind === "not") visit(node.filter, depth + 1)
  }
  if (plan.filter) visit(plan.filter, 1)
  if ((plan.sort?.length ?? 0) > budget.maxSortFields) throw new ValidationError("query exceeds maximum sort fields")
  if ((plan.projection?.fields.length ?? 0) > budget.maxProjectionFields) throw new ValidationError("query exceeds maximum projection fields")
  if (plan.search && new TextEncoder().encode(plan.search.text).byteLength > budget.maxSearchBytes) throw new ValidationError("query search exceeds maximum UTF-8 bytes")
}
