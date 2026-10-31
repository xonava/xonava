import { StaleClaimError } from "@xonava/core/domain"
import type { FencedLease, LeasePort, LeaseResourceKey } from "@xonava/core/events"
import type { Rng } from "../../../core/src/__tests__/differential/harness.js"

/**
 * Reference model of the fenced lease contract (`LeasePort`), derived from the port and the lease rules of the spec:
 * - one holder per resource; a live lease (now < expiresAt) cannot be acquired by anyone, including its own owner;
 * - every grant gets a fresh claim token and a fencing token strictly greater than every earlier one for the resource,
 *   whether the previous lease was released or expired;
 * - renew / release / assertCurrent succeed only for the live lease whose owner, claim token and fencing token all match,
 *   judged against the STORED lease and the database clock, never against the caller's copy (its `expiresAt` included);
 * - duration (1 ms .. 24 h) and owner (non-empty) are validated before the store is touched.
 *
 * Time: the model always runs "now" at T0 and `advance(ms)` shifts every stored timestamp ms into the past, exactly what the
 * database drivers do to the real rows.
 */

export const T0 = Date.UTC(2030, 5, 1)
export const MINUTE = 60_000
export const HOUR = 3_600_000
export const DAY = 24 * HOUR
export const DURATIONS = [MINUTE, 5 * MINUTE, HOUR, DAY] as const
/** Whole-minute advances: a lease either lapses exactly (gap 0) or is at least one minute away from lapsing, so real-clock drift never matters. */
export const ADVANCES = [MINUTE, 5 * MINUTE, HOUR, 2 * HOUR, DAY, DAY + HOUR] as const
export const OWNERS = ["w1", "w2", "w3"] as const

const A = "tenant:a" as never
const B = "tenant:b" as never
/** Cells differ in exactly one key part each (case, trailing space, namespace, scope) so identifier collation and key mixing show up. */
export const CELLS: readonly LeaseResourceKey[] = [
  { scopeId: A, namespace: "jobs", resourceId: "r1" },
  { scopeId: A, namespace: "jobs", resourceId: "R1" },
  { scopeId: B, namespace: "jobs", resourceId: "r1" },
  { scopeId: A, namespace: "other", resourceId: "r1" },
  { scopeId: A, namespace: "jobs", resourceId: "r1 " },
]
export const keyOf = (resource: LeaseResourceKey): string => `${resource.scopeId}:${resource.namespace}:${resource.resourceId}`

export type Ref = "latest" | "previous" | "renewed" | "wrongToken" | "wrongFence" | "wrongOwner" | "forgedExpiry" | "unissued"
export type Op =
  | { t: "acquire"; cell: number; owner: string; durationMs: number }
  | { t: "renew"; cell: number; ref: Ref; durationMs: number }
  | { t: "release"; cell: number; ref: Ref }
  | { t: "assert"; cell: number; ref: Ref }
  | { t: "advance"; ms: number }

/** Something that offers the lease port and, besides it, direct access to the stored row and the clock that decides expiry. */
export interface LeaseSide {
  store: LeasePort
  /** Moves the clock forward by shifting every stored timestamp ms into the past. */
  advance(ms: number): Promise<void>
  /** The stored lease of a resource (SQL, independent of the adapter) and the database clock in ms, read together. */
  peek(resource: LeaseResourceKey): Promise<{ lease: FencedLease | null; nowMs: number }>
}

const validDuration = (value: number): boolean => Number.isFinite(value) && value >= 1 && value <= DAY

export class ModelLease implements LeaseSide {
  readonly store: LeasePort = this
  private readonly rows = new Map<string, FencedLease>()
  /** Highest fencing token ever granted per resource: survives release and expiry. */
  private readonly floor = new Map<string, number>()
  private tokens = 0

  private live(resource: LeaseResourceKey): FencedLease | null {
    const lease = this.rows.get(keyOf(resource))
    return lease !== undefined && T0 < Date.parse(lease.expiresAt) ? lease : null
  }
  private matches(resource: LeaseResourceKey, lease: FencedLease): FencedLease | null {
    const current = this.live(resource)
    return current !== null && current.claimToken === lease.claimToken && current.fencingToken === lease.fencingToken && current.owner === lease.owner ? current : null
  }

  async acquire(resource: LeaseResourceKey, owner: string, durationMs: number): Promise<FencedLease | null> {
    if (typeof owner !== "string" || owner === "") throw new Error("owner")
    if (!validDuration(durationMs)) throw new Error("duration")
    if (this.live(resource) !== null) return null
    const key = keyOf(resource)
    const fencingToken = (this.floor.get(key) ?? 0) + 1
    this.floor.set(key, fencingToken)
    const lease: FencedLease = { resource, owner, claimToken: `m-${++this.tokens}`, fencingToken, acquiredAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + durationMs).toISOString() }
    this.rows.set(key, lease)
    return lease
  }
  async renew(lease: FencedLease, durationMs: number): Promise<FencedLease> {
    if (!validDuration(durationMs)) throw new Error("duration")
    const current = this.matches(lease.resource, lease)
    if (current === null) throw new StaleClaimError()
    const next = { ...current, expiresAt: new Date(T0 + durationMs).toISOString() }
    this.rows.set(keyOf(lease.resource), next)
    return next
  }
  async release(lease: FencedLease): Promise<void> {
    if (this.matches(lease.resource, lease) === null) throw new StaleClaimError()
    this.rows.delete(keyOf(lease.resource))
  }
  async assertCurrent(lease: FencedLease): Promise<void> {
    if (this.matches(lease.resource, lease) === null) throw new StaleClaimError()
  }
  async advance(ms: number): Promise<void> {
    for (const [key, lease] of this.rows) this.rows.set(key, { ...lease, acquiredAt: new Date(Date.parse(lease.acquiredAt) - ms).toISOString(), expiresAt: new Date(Date.parse(lease.expiresAt) - ms).toISOString() })
  }
  async peek(resource: LeaseResourceKey): Promise<{ lease: FencedLease | null; nowMs: number }> {
    return { lease: this.rows.get(keyOf(resource)) ?? null, nowMs: T0 }
  }
}

const minutes = (ms: number): number => Math.round(ms / MINUTE)

/** Driver-independent view of a lease: tokens by order of issue, times in whole minutes relative to the database clock. */
export function leaseView(lease: FencedLease | null, tokenIndex: (token: string) => number, nowMs: number): unknown {
  if (lease === null) return null
  return { owner: lease.owner, fence: lease.fencingToken, token: tokenIndex(lease.claimToken), acquiredMin: minutes(Date.parse(lease.acquiredAt) - nowMs), expiresMin: minutes(Date.parse(lease.expiresAt) - nowMs) }
}

/** What an observer sees of the stored row: only a lease that has not lapsed counts as held. */
export function heldView(lease: FencedLease | null, tokenIndex: (token: string) => number, nowMs: number): unknown {
  return lease !== null && nowMs < Date.parse(lease.expiresAt) ? leaseView(lease, tokenIndex, nowMs) : null
}

// ------------------------------------------------------------------------------------------------ generation

export function generateOp(rng: Rng): Op {
  const cell = rng.int(CELLS.length)
  const roll = rng.int(100)
  const ref = (): Ref => rng.pick<Ref>(["latest", "latest", "latest", "latest", "previous", "renewed", "wrongToken", "wrongFence", "wrongOwner", "forgedExpiry", "unissued"])
  if (roll < 30) {
    const owner = rng.bool(0.04) ? "" : rng.pick(OWNERS)
    const durationMs = rng.bool(0.06) ? rng.pick([0, -5, DAY + 1]) : rng.pick(DURATIONS)
    return { t: "acquire", cell, owner, durationMs }
  }
  if (roll < 50) return { t: "renew", cell, ref: ref(), durationMs: rng.bool(0.05) ? rng.pick([0, DAY + 1]) : rng.pick(DURATIONS) }
  if (roll < 62) return { t: "release", cell, ref: ref() }
  if (roll < 74) return { t: "assert", cell, ref: ref() }
  return { t: "advance", ms: rng.pick(ADVANCES) }
}

export function generateOps(rng: Rng, size: { min: number; max: number } = { min: 20, max: 50 }): Op[] {
  const count = size.min + rng.int(size.max - size.min + 1)
  return Array.from({ length: count }, () => generateOp(rng))
}

export function* shrinkOps(ops: Op[]): Generator<Op[]> {
  if (ops.length > 2) {
    yield ops.slice(0, Math.ceil(ops.length / 2))
    yield ops.slice(Math.floor(ops.length / 2))
  }
  for (let size = Math.min(8, ops.length - 1); size >= 1; size = Math.floor(size / 2)) {
    for (let start = 0; start + size <= ops.length; start += size) yield [...ops.slice(0, start), ...ops.slice(start + size)]
    if (size === 1) break
  }
}

export function describeOps(ops: Op[]): string {
  return ops.map((op, index) => `${index}: ${JSON.stringify(op)}`).join("\n")
}
