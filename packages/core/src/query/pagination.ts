export interface OffsetPaginationPlan {
  readonly kind: "offset"
  readonly page: number
  readonly pageSize: number
  /**
   * Opt in to the total row count (`ListResult.rowCount`). Off by default: without it the repository runs no COUNT
   * query and `rowCount` is absent. The total counts rows matching the caller's filter and scope, never a cursor.
   */
  readonly includeTotal?: boolean
}
export interface CursorPaginationPlan { readonly kind: "cursor"; readonly after?: string; readonly before?: string; readonly limit: number }
export type PaginationPlan = OffsetPaginationPlan | CursorPaginationPlan
/** Verified, decoded cursor boundary passed from a transport to persistence. */
export interface ResolvedCursorPaginationPlan { readonly kind: "cursor"; readonly direction: "after" | "before"; readonly values?: readonly (string | number | boolean | null)[]; readonly limit: number }
export interface OffsetPageInfo { readonly kind: "offset"; readonly page: number; readonly pageSize: number; /** Present only when the offset request set `includeTotal: true`. */ readonly rowCount?: number }
export interface CursorPageInfo { readonly kind: "cursor"; readonly startCursor?: string; readonly endCursor?: string; readonly hasNextPage: boolean; readonly hasPreviousPage: boolean }
