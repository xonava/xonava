import type { ListResult, QueryOptions } from "@xonava/core/query"

/**
 * Pages already-filtered in-memory rows the way the repository contract expects: offset pages carry a total only
 * when `includeTotal` is true; cursor pages carry hasNextPage/hasPreviousPage and never a total.
 */
export function pageInMemoryRows<T>(rows: readonly T[], options: QueryOptions | undefined, defaultPageSize: number): ListResult<T> {
  const requested = options?.pagination
  if (requested?.kind === "cursor") {
    const sort = options?.sort ?? []
    const compare = (a: Record<string, unknown>, b: Record<string, unknown>): number => {
      for (const item of sort) {
        const left = a[item.field] as string | number
        const right = b[item.field] as string | number
        if (left === right) continue
        return (left < right ? -1 : 1) * (item.direction === "asc" ? 1 : -1)
      }
      return 0
    }
    const ordered = rows.map((row) => row as Record<string, unknown>).sort(compare)
    const forward = requested.direction === "after"
    const directed = forward ? ordered : [...ordered].reverse()
    const boundary = requested.values
      ? Object.fromEntries(sort.map((item, index) => [item.field, requested.values![index]]))
      : undefined
    const past = boundary ? directed.filter((row) => (forward ? compare(row, boundary) > 0 : compare(row, boundary) < 0)) : directed
    const window = past.slice(0, requested.limit + 1)
    const hasMore = window.length > requested.limit
    const page = window.slice(0, requested.limit)
    return {
      rows: (forward ? page : page.reverse()) as T[],
      page: 1,
      pageSize: requested.limit,
      pageInfo: {
        kind: "cursor",
        hasNextPage: forward ? hasMore : boundary !== undefined,
        hasPreviousPage: forward ? boundary !== undefined : hasMore,
      },
    }
  }
  const page = requested?.page ?? 1
  const pageSize = requested?.pageSize ?? defaultPageSize
  const start = (page - 1) * pageSize
  return {
    rows: rows.slice(start, start + pageSize) as T[],
    ...(requested?.includeTotal === true ? { rowCount: rows.length } : {}),
    page,
    pageSize,
  }
}
