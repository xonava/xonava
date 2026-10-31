import type { PredicateNode } from "../domain/predicate.js"
import type { CursorPageInfo, OffsetPageInfo, PaginationPlan, OffsetPaginationPlan, ResolvedCursorPaginationPlan } from "./pagination.js"
import type { ProjectionSpec } from "./projection.js"
import type { ReadConsistency } from "./readConsistency.js"

export interface SortSpec { readonly field: string; readonly direction: "asc" | "desc"; readonly nulls?: "first" | "last" }
export interface SearchPlan { readonly text: string }
export interface QueryPlan {
  readonly filter?: PredicateNode
  readonly sort?: readonly SortSpec[]
  readonly pagination?: PaginationPlan
  readonly projection?: ProjectionSpec
  readonly consistency?: ReadConsistency
  readonly search?: SearchPlan
}
export interface QueryOptions { readonly filter?: PredicateNode; readonly sort?: readonly SortSpec[]; readonly pagination?: OffsetPaginationPlan | ResolvedCursorPaginationPlan; readonly projection?: ProjectionSpec; readonly consistency?: ReadConsistency }
/**
 * One page of rows. `rowCount` (the total number of rows matching the filter and scope) is present only when an
 * offset request set `includeTotal: true`. Cursor pages never carry a total; they report `pageInfo.hasNextPage` and
 * `pageInfo.hasPreviousPage` instead.
 */
export interface ListResult<T> { readonly rows: T[]; readonly rowCount?: number; readonly page: number; readonly pageSize: number; readonly pageInfo?: OffsetPageInfo | CursorPageInfo }
