import { ValidationError } from "../domain/errors.js"
import type { SortSpec } from "./queryPlan.js"
export type CursorDirection = "after" | "before"
export type CursorValue = string | number | boolean | null
export interface CursorPayloadV1 {
  readonly format: "framework.cursor"
  readonly version: 1
  readonly direction: CursorDirection
  readonly values: readonly CursorValue[]
  readonly routeHash: string
  readonly queryHash: string
  readonly scopeHash: string
  readonly sortHash: string
  /** Optional expiry (Unix ms), integrity-protected; decodeCursor rejects the cursor afterwards. */
  readonly expiresAt?: number
}
export function assertStableCursorSort(sort: readonly SortSpec[], uniqueFields: readonly string[], nullableFields: readonly string[] = []): void {
  if (sort.length === 0) throw new ValidationError("cursor ordering must not be empty")
  if (!uniqueFields.includes(sort.at(-1)?.field ?? "")) throw new ValidationError("cursor ordering must end with a unique deterministic tie breaker")
  if (new Set(sort.map(item => item.field)).size !== sort.length) throw new ValidationError("cursor ordering contains duplicate fields")
  for (const item of sort) { if (!item.field.trim()) throw new ValidationError("cursor sort field must be non-empty"); if (nullableFields.includes(item.field) && !item.nulls) throw new ValidationError("nullable cursor sort requires explicit null ordering") }
}
export function assertCursorBinding(payload: CursorPayloadV1, expected: Pick<CursorPayloadV1, "routeHash" | "queryHash" | "scopeHash" | "sortHash">): void {
  for (const key of ["routeHash", "queryHash", "scopeHash", "sortHash"] as const) if (payload[key] !== expected[key]) throw new ValidationError(`cursor ${key} binding mismatch`)
}
