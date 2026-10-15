import { ConfigurationError, StaleClaimError } from "@xonava/core/domain"
import type { FencedLease, LeasePort, LeaseResourceKey } from "@xonava/core/events"
import { validateLeaseDuration, validateLeaseOwner } from "./lease"

export interface AtomicLeaseBackend {
  transition<T>(resource: LeaseResourceKey, change: (current: FencedLease | null, backendNow: Date, freshToken: () => string) => { lease: FencedLease | null; result: T }): Promise<T>
  read(resource: LeaseResourceKey): Promise<{ lease: FencedLease | null; backendNow: Date }>
}
const sameOwner = (current: FencedLease | null, lease: FencedLease, now: Date) => current !== null && current.claimToken === lease.claimToken && current.fencingToken === lease.fencingToken && current.owner === lease.owner && now.getTime() < Date.parse(current.expiresAt)

export class FencedLeaseStore implements LeasePort {
  constructor(private readonly backend: AtomicLeaseBackend) {}
  acquire(resource: LeaseResourceKey, owner: string, durationMs: number): Promise<FencedLease | null> {
    validateLeaseOwner(owner); const duration = validateLeaseDuration(durationMs)
    return this.backend.transition(resource, (current, now, freshToken) => {
      if (current && now.getTime() < Date.parse(current.expiresAt)) return { lease: current, result: null }
      const next: FencedLease = { resource, owner, claimToken: freshToken(), fencingToken: (current?.fencingToken ?? 0) + 1, acquiredAt: now.toISOString(), expiresAt: new Date(now.getTime() + duration).toISOString() }
      return { lease: next, result: next }
    })
  }
  renew(lease: FencedLease, durationMs: number): Promise<FencedLease> { const duration = validateLeaseDuration(durationMs); return this.backend.transition(lease.resource, (current, now) => { if (!sameOwner(current, lease, now)) throw new StaleClaimError(); const next = { ...current!, expiresAt: new Date(now.getTime() + duration).toISOString() }; return { lease: next, result: next } }) }
  release(lease: FencedLease): Promise<void> { return this.backend.transition(lease.resource, (current, now) => { if (!sameOwner(current, lease, now)) throw new StaleClaimError(); return { lease: null, result: undefined } }) }
  async assertCurrent(lease: FencedLease): Promise<void> { const { lease: current, backendNow } = await this.backend.read(lease.resource); if (!sameOwner(current, lease, backendNow)) throw new StaleClaimError() }
}

export function assertLeaseBackendTime(now: unknown): asserts now is Date { if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new ConfigurationError("Lease backend must provide authoritative time") }
