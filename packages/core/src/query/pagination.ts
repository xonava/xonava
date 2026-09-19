export interface OffsetPaginationPlan { readonly kind: "offset"; readonly page: number; readonly pageSize: number }
export interface CursorPaginationPlan { readonly kind: "cursor"; readonly after?: string; readonly before?: string; readonly limit: number }
export type PaginationPlan = OffsetPaginationPlan | CursorPaginationPlan
/** Verified, decoded cursor boundary passed from a transport to persistence. */
export interface ResolvedCursorPaginationPlan { readonly kind: "cursor"; readonly direction: "after" | "before"; readonly values?: readonly (string | number | boolean | null)[]; readonly limit: number }
export interface OffsetPageInfo { readonly kind: "offset"; readonly page: number; readonly pageSize: number; readonly rowCount: number }
export interface CursorPageInfo { readonly kind: "cursor"; readonly startCursor?: string; readonly endCursor?: string; readonly hasNextPage: boolean; readonly hasPreviousPage: boolean }
