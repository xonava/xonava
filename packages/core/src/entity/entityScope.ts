import type { PredicateNode } from "../domain/predicate.js"

export type EntityScopeDefinition<TRow = Record<string, unknown>> =
  | { readonly kind: "tenant"; readonly field?: keyof TRow & string }
  | { readonly kind: "application"; readonly field: keyof TRow & string }
  | { readonly kind: "platform"; readonly acknowledged: true; readonly scopeFilter?: PredicateNode }
  | { readonly kind: "system"; readonly acknowledged: true; readonly scopeFilter?: PredicateNode }

export interface CompiledEntityScope {
  readonly kind: EntityScopeDefinition["kind"]
  readonly field?: string
  readonly structuralFilter?: PredicateNode
}

export function compileEntityScope<TRow>(scope: EntityScopeDefinition<TRow>, tenantField?: keyof TRow & string): CompiledEntityScope {
  if (scope.kind === "tenant") {
    const field = scope.field ?? tenantField
    return Object.freeze({ kind: "tenant", ...(field ? { field } : {}) })
  }
  if (scope.kind === "application") return Object.freeze({ kind: "application", field: scope.field })
  return Object.freeze({ kind: scope.kind, ...(scope.scopeFilter ? { structuralFilter: scope.scopeFilter } : {}) })
}
