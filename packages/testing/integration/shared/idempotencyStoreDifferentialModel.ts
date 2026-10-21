import type { Rng } from "../../../core/src/__tests__/differential/harness.js"

/**
 * Reference idempotency store for the real-database differential.
 *
 * Written from the idempotency contract (packages/core/src/events/durability/idempotency.ts, docs/spec/events/idempotency.md),
 * not from any SQL adapter:
 *
 *  - `acquire` atomically reserves a (scope, key) identity. The same key with a different fingerprint conflicts; a
 *    completed reservation replays its durable response; a business-committed one reports its receipt; an in-progress
 *    one reports `in-progress` until its lease lapses, after which a same-fingerprint caller takes it over with a new
 *    token (the old token is dead).
 *  - `renew` / `abandon` / `markCommitted` are fenced by (fingerprint, token) and apply only to an in-progress row;
 *    `complete` only to a business-committed one. A lost fence is an error (renew, commit, complete) or a no-op (abandon).
 *  - Finalization is claim-fenced: `claim` leases business-committed rows with pending invalidations that carry no live
 *    claim; `ack` / `completeClaimed` need the live claim token.
 *
 * Time. Lease and claim liveness are decided by the DATABASE clock in every adapter, so the reference never lets either
 * lapse on its own: reservations and claims use one-hour leases and only an explicit `expireLease` / `expireClaim` op
 * lapses them, which the driver realises by rewriting the timestamp two hours into the database's past.
 */

export const HOUR = 3_600_000

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export const SLOTS = [
  { scope: "tenant:t1:orders", key: "key-a" },
  { scope: "tenant:t1:orders", key: "key-b" },
  { scope: "tenant:t2:orders", key: "key-a" },
  { scope: "platform:default", key: "key-c" },
] as const
export const FINGERPRINTS = ["fp-one", "fp-two"] as const
export const BOGUS_TOKEN = "bogus-token"
export const OWNERS = ["finalizer-1", "finalizer-2"] as const

export type TokenChoice = "cur" | "stale" | "bogus"
export type FpChoice = "cur" | "other"
export interface Fence { slot: number; tok: TokenChoice; fp: FpChoice }
export interface ResourceSpec { entity: string; id: string; version?: number }
export type LeaseChoice = "hour" | "default" | "zero"

export type Op =
  | { k: "acquire"; slot: number; fp: 0 | 1; lease: LeaseChoice }
  | { k: "renew"; fence: Fence; badLease?: boolean }
  | { k: "abandon"; fence: Fence }
  | { k: "commit"; fence: Fence; resource?: ResourceSpec; inv?: string[] }
  | { k: "complete"; fence: Fence; result: Json }
  | { k: "claim"; limit: number | "default" | "zero"; owner: number | "empty"; explicitToken: boolean }
  | { k: "ack"; fence: Fence; ctok: TokenChoice }
  | { k: "completeClaimed"; fence: Fence; ctok: TokenChoice; result: Json }
  | { k: "expireLease"; slot: number }
  | { k: "expireClaim"; slot: number }

export type Status = "in-progress" | "business-committed" | "completed"

export interface RefClaim { owner: string; token: string }
export interface RefRow {
  slot: number
  fingerprint: string
  token: string
  status: Status
  /** Canonical JSON of the completed response. */
  result: string | null
  resource: ResourceSpec | null
  /** Pending invalidation obligations (deduplicated, first-seen order); null once none are pending. */
  invalidations: string[] | null
  claim: RefClaim | null
  leaseExpired: boolean
  claimExpired: boolean
}

export type AcquireOutcome =
  | { o: "acquired"; token: string }
  | { o: "replay"; result: string }
  | { o: "in-progress" }
  | { o: "conflict" }
  | { o: "business-committed"; token: string; resource: ResourceSpec | null; invalidations: string[] }

function canon(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canon(record[key])}`).join(",")}}`
}

export function canonicalJson(value: unknown): string { return canon(value) }

export interface RefClaimed { slot: number; fingerprint: string; token: string; invalidations: string[]; claimToken: string; owner: string }

export class RefStore {
  readonly rows = new Map<number, RefRow>()
  /** Every reservation token ever issued for a slot, oldest first. */
  readonly issued = new Map<number, string[]>()
  /** Every claim token ever applied to a slot, oldest first. */
  readonly claimed = new Map<number, string[]>()
  private tokenCounter = 0
  private claimCounter = 0
  onEvent: (event: string) => void = () => undefined

  newToken(): string { return `tok#${++this.tokenCounter}` }
  newClaimToken(): string { return `claim#${++this.claimCounter}` }

  private issue(slot: number): string {
    const token = this.newToken()
    this.issued.set(slot, [...(this.issued.get(slot) ?? []), token])
    return token
  }

  acquire(slot: number, fingerprint: string, lease: LeaseChoice): AcquireOutcome | "throws" {
    if (lease === "zero") { this.onEvent("acquire.invalid-lease"); return "throws" }
    const row = this.rows.get(slot)
    if (!row) {
      const token = this.issue(slot)
      this.rows.set(slot, { slot, fingerprint, token, status: "in-progress", result: null, resource: null, invalidations: null, claim: null, leaseExpired: false, claimExpired: false })
      this.onEvent("acquire.fresh")
      return { o: "acquired", token }
    }
    if (row.fingerprint !== fingerprint) { this.onEvent("acquire.conflict"); return { o: "conflict" } }
    if (row.status === "completed") { this.onEvent("acquire.replay"); return { o: "replay", result: row.result! } }
    if (row.status === "business-committed") {
      this.onEvent("acquire.business-committed")
      return { o: "business-committed", token: row.token, resource: row.resource, invalidations: row.invalidations ?? [] }
    }
    if (row.leaseExpired) {
      row.token = this.issue(slot)
      row.leaseExpired = false
      this.onEvent("acquire.takeover")
      return { o: "acquired", token: row.token }
    }
    this.onEvent("acquire.in-progress")
    return { o: "in-progress" }
  }

  private owned(slot: number, fingerprint: string, token: string, status: Status): RefRow | undefined {
    const row = this.rows.get(slot)
    return row && row.fingerprint === fingerprint && row.token === token && row.status === status ? row : undefined
  }

  renew(slot: number, fingerprint: string, token: string, badLease: boolean): boolean {
    if (badLease) { this.onEvent("renew.invalid-lease"); return false }
    const row = this.owned(slot, fingerprint, token, "in-progress")
    if (!row) { this.onEvent("renew.lost"); return false }
    row.leaseExpired = false
    this.onEvent("renew.ok")
    return true
  }

  abandon(slot: number, fingerprint: string, token: string): void {
    if (this.owned(slot, fingerprint, token, "in-progress")) { this.rows.delete(slot); this.onEvent("abandon.released") } else this.onEvent("abandon.noop")
  }

  commit(slot: number, fingerprint: string, token: string, resource: ResourceSpec | undefined, inv: readonly string[] | undefined): boolean {
    const row = this.owned(slot, fingerprint, token, "in-progress")
    if (!row) { this.onEvent("commit.lost"); return false }
    row.status = "business-committed"
    row.result = null
    row.resource = resource ? { ...resource } : null
    row.invalidations = inv && inv.length > 0 ? [...new Set(inv)] : null
    this.onEvent(row.invalidations ? "commit.with-invalidations" : "commit.no-invalidations")
    return true
  }

  complete(slot: number, fingerprint: string, token: string, result: Json): boolean {
    const row = this.owned(slot, fingerprint, token, "business-committed")
    if (!row) { this.onEvent("complete.lost"); return false }
    this.finish(row, result)
    this.onEvent("complete.ok")
    return true
  }

  private finish(row: RefRow, result: Json): void {
    row.status = "completed"
    row.result = canon(result)
    row.invalidations = null
    row.claim = null
    row.claimExpired = false
  }

  /** Rows `claim` may lease: business-committed, invalidations pending, no live claim. */
  claimCandidates(): number[] {
    return [...this.rows.values()]
      .filter((row) => row.status === "business-committed" && row.invalidations !== null && (row.claim === null || row.claimExpired))
      .map((row) => row.slot)
  }

  applyClaim(slots: readonly number[], owner: string, claimToken: string): RefClaimed[] {
    return slots.map((slot) => {
      const row = this.rows.get(slot)!
      row.claim = { owner, token: claimToken }
      row.claimExpired = false
      this.claimed.set(slot, [...(this.claimed.get(slot) ?? []), claimToken])
      this.onEvent(row.claim && this.claimed.get(slot)!.length > 1 ? "claim.reclaim" : "claim.fresh")
      return { slot, fingerprint: row.fingerprint, token: row.token, invalidations: [...row.invalidations!], claimToken, owner }
    })
  }

  private claimed_(slot: number, fingerprint: string, token: string, claimToken: string): RefRow | undefined {
    const row = this.owned(slot, fingerprint, token, "business-committed")
    return row && row.claim?.token === claimToken && !row.claimExpired ? row : undefined
  }

  ack(slot: number, fingerprint: string, token: string, claimToken: string): boolean {
    const row = this.claimed_(slot, fingerprint, token, claimToken)
    if (!row) { this.onEvent("ack.lost"); return false }
    row.invalidations = null
    row.claim = null
    row.claimExpired = false
    this.onEvent("ack.ok")
    return true
  }

  completeClaimed(slot: number, fingerprint: string, token: string, claimToken: string, result: Json): boolean {
    const row = this.claimed_(slot, fingerprint, token, claimToken)
    if (!row) { this.onEvent("completeClaimed.lost"); return false }
    this.finish(row, result)
    this.onEvent("completeClaimed.ok")
    return true
  }

  expireLease(slot: number): void {
    const row = this.rows.get(slot)
    if (row) { row.leaseExpired = true; this.onEvent(row.status === "in-progress" ? "expireLease.live" : "expireLease.inert") }
  }

  expireClaim(slot: number): void {
    const row = this.rows.get(slot)
    if (row?.claim) { row.claimExpired = true; this.onEvent("expireClaim.live") }
  }

  /** The reservation token a fence aims at. */
  tokenFor(slot: number, choice: TokenChoice): string {
    const row = this.rows.get(slot)
    const issued = this.issued.get(slot) ?? []
    if (choice === "cur") return row?.token ?? issued[issued.length - 1] ?? BOGUS_TOKEN
    if (choice === "stale") return issued.find((token) => token !== row?.token) ?? BOGUS_TOKEN
    return BOGUS_TOKEN
  }

  claimTokenFor(slot: number, choice: TokenChoice): string {
    const row = this.rows.get(slot)
    const history = this.claimed.get(slot) ?? []
    if (choice === "cur") return row?.claim?.token ?? history[history.length - 1] ?? BOGUS_TOKEN
    if (choice === "stale") return history.find((token) => token !== row?.claim?.token) ?? BOGUS_TOKEN
    return BOGUS_TOKEN
  }

  fingerprintFor(slot: number, choice: FpChoice): string {
    const current = this.rows.get(slot)?.fingerprint ?? FINGERPRINTS[0]
    return choice === "cur" ? current : current === FINGERPRINTS[0] ? FINGERPRINTS[1] : FINGERPRINTS[0]
  }
}

const RESULTS: readonly Json[] = [
  { id: "r1", total: 12 }, { ok: true, items: ["a", "b"] }, "created", 42, 0, true, false, null, "", [], [1, 2, 3], { nested: { deep: [1, { x: "y" }] } },
  { text: "unicode é中😀 \"quoted\" \\ back" },
]
const RESOURCES: readonly ResourceSpec[] = [
  { entity: "Order", id: "o-1", version: 1 }, { entity: "Order", id: "o-2" }, { entity: "Invoice", id: "i-9", version: 7 }, { entity: "Order", id: "o-3", version: 0 },
]
const INVALIDATIONS: readonly (readonly string[])[] = [
  ["orders"], ["orders", "invoices"], ["orders", "orders", "customers"], ["tag:a", "tag:b", "tag:a"], [],
]

export function generateOps(rng: Rng, size: { min: number; max: number } = { min: 14, max: 40 }): Op[] {
  const length = size.min + rng.int(size.max - size.min + 1)
  const slot = (): number => rng.int(SLOTS.length)
  const fence = (): Fence => ({
    slot: slot(),
    tok: rng.pick(["cur", "cur", "cur", "cur", "cur", "stale", "bogus"] as const),
    fp: rng.pick(["cur", "cur", "cur", "cur", "cur", "cur", "other"] as const),
  })
  const ops: Op[] = []
  for (let index = 0; index < length; index++) {
    const roll = index < 3 ? 0 : rng.int(100)
    let op: Op
    if (roll < 18) op = { k: "acquire", slot: slot(), fp: rng.bool(0.8) ? 0 : 1, lease: rng.pick(["hour", "hour", "hour", "default", "zero"] as const) }
    else if (roll < 26) op = { k: "renew", fence: fence(), ...(rng.bool(0.1) ? { badLease: true } : {}) }
    else if (roll < 33) op = { k: "abandon", fence: fence() }
    else if (roll < 50) {
      const inv = rng.pick(INVALIDATIONS)
      op = { k: "commit", fence: fence(), ...(rng.bool(0.7) ? { resource: rng.pick(RESOURCES) } : {}), ...(rng.bool(0.8) ? { inv: [...inv] } : {}) }
    }
    else if (roll < 60) op = { k: "complete", fence: fence(), result: rng.pick(RESULTS) }
    else if (roll < 72) op = { k: "claim", limit: rng.pick([1, 2, 5, 100, "default", "default", "zero"] as const), owner: rng.bool(0.95) ? rng.int(OWNERS.length) : "empty", explicitToken: rng.bool(0.6) }
    else if (roll < 80) op = { k: "ack", fence: fence(), ctok: rng.pick(["cur", "cur", "cur", "stale", "bogus"] as const) }
    else if (roll < 87) op = { k: "completeClaimed", fence: fence(), ctok: rng.pick(["cur", "cur", "cur", "stale", "bogus"] as const), result: rng.pick(RESULTS) }
    else if (roll < 93) op = { k: "expireLease", slot: slot() }
    else op = { k: "expireClaim", slot: slot() }
    ops.push(op)
  }
  return ops
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
