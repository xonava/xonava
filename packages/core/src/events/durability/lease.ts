import type { ExecutionScopeId } from "../../domain"

export interface LeaseResourceKey { readonly namespace: string; readonly resourceId: string; readonly scopeId: ExecutionScopeId }
export interface FencedLease {
  readonly resource: LeaseResourceKey
  readonly owner: string
  readonly claimToken: string
  readonly fencingToken: number
  readonly acquiredAt: string
  readonly expiresAt: string
}
export interface LeasePort {
  acquire(resource: LeaseResourceKey, owner: string, durationMs: number): Promise<FencedLease | null>
  renew(lease: FencedLease, durationMs: number): Promise<FencedLease>
  release(lease: FencedLease): Promise<void>
  assertCurrent(lease: FencedLease): Promise<void>
}
