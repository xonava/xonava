import { Predicate, type PredicateNode } from "../domain/predicate.js"

export type EntityLifecyclePolicy<TRow = Record<string, unknown>> =
  | { readonly kind: "hard-delete" }
  | { readonly kind: "soft-delete"; readonly deletedAtField: keyof TRow & string }
  | { readonly kind: "append-only" }

export interface CompiledEntityLifecycle {
  readonly kind: EntityLifecyclePolicy["kind"]
  readonly activeRowFilter?: PredicateNode
  readonly deletedAtField?: string
  readonly protectedFields: readonly string[]
  readonly deleteStrategy: "hard" | "occ-soft" | "forbidden"
  readonly restoreStrategy: "none" | "occ-restore" | "forbidden"
}

export function compileEntityLifecycle<TRow>(policy: EntityLifecyclePolicy<TRow>): CompiledEntityLifecycle {
  if (policy.kind === "soft-delete") return Object.freeze({ kind: policy.kind, deletedAtField: policy.deletedAtField, activeRowFilter: Predicate.isNull(policy.deletedAtField), protectedFields: Object.freeze([policy.deletedAtField]), deleteStrategy: "occ-soft", restoreStrategy: "occ-restore" })
  if (policy.kind === "append-only") return Object.freeze({ kind: policy.kind, protectedFields: Object.freeze([]), deleteStrategy: "forbidden", restoreStrategy: "forbidden" })
  return Object.freeze({ kind: policy.kind, protectedFields: Object.freeze([]), deleteStrategy: "hard", restoreStrategy: "none" })
}
