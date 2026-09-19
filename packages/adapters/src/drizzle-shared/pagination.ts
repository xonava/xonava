import type { OffsetPaginationPlan } from "core/query"
import { ValidationError } from "core/domain"

export const DEFAULT_PAGE_SIZE = 20
export const DEFAULT_MAX_PAGE_SIZE = 100

function validatePaginationValue(name: "page" | "pageSize", value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError(`${name} must be a finite positive integer`)
  }
  return value
}

export function resolvePagination(
  pagination: OffsetPaginationPlan | undefined,
  maxPageSize: number,
  maxOffset?: number,
): { page: number; pageSize: number; offset: number } {
  const page = validatePaginationValue("page", pagination?.page ?? 1)
  const requestedPageSize = validatePaginationValue("pageSize", pagination?.pageSize ?? DEFAULT_PAGE_SIZE)
  const pageSize = Math.min(requestedPageSize, maxPageSize)
  const pageIndex = page - 1
  if (pageIndex > Math.floor(Number.MAX_SAFE_INTEGER / pageSize)) {
    throw new ValidationError("pagination offset exceeds the maximum safe integer")
  }
  const offset = pageIndex * pageSize
  if (maxOffset !== undefined && offset > maxOffset) {
    throw new ValidationError(`pagination offset exceeds the configured maximum of ${maxOffset}`)
  }
  return { page, pageSize, offset }
}
