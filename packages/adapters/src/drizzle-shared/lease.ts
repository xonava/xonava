export const DEFAULT_LEASE_DURATION_MS = 30_000
export const MIN_LEASE_DURATION_MS = 1
export const MAX_LEASE_DURATION_MS = 24 * 60 * 60 * 1_000

export function validateLeaseDuration(value: number | undefined): number {
  const duration = value ?? DEFAULT_LEASE_DURATION_MS
  if (!Number.isFinite(duration) || duration < MIN_LEASE_DURATION_MS || duration > MAX_LEASE_DURATION_MS) {
    throw new Error("Idempotency lease duration must be finite and within the allowed bounds")
  }
  return duration
}

export function validateLeaseOwner(owner: string): void {
  if (!owner || typeof owner !== "string") throw new Error("claimOwner is required")
}

export function resolveLeaseLimit(limit: number | undefined): number {
  const resolved = limit ?? 100
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error("Idempotency finalizer limit must be a positive safe integer")
  }
  return Math.min(resolved, 100)
}
