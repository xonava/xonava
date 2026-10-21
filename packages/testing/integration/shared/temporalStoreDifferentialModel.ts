import type { Rng } from "../../../core/src/__tests__/differential/harness.js"

/**
 * Pure reference model of the temporal history capability (docs/spec/temporal.md), independent of the stores and of the
 * core implementation: per resource a contiguous revision history with a lifecycle (created, then updated or deleted,
 * restored only after deletion) and chronological instants, honest acceleration snapshots (first save wins), bounded
 * revision pages, and point-in-time reconstruction found by a plain scan. The reconstruction oracle is the brute-force
 * scan of primitiveTemporal.differential.test.ts.
 */

export type Kind = "created" | "updated" | "deleted" | "restored"
export type State = Record<string, unknown>

export const T0 = Date.UTC(2026, 0, 1)

export interface ResourceSpec { scopeId: string; entityType: string; entityId: string }

/** Identities that differ only by case, trailing space or non-ASCII text must be distinct resources. */
export const RESOURCES: readonly ResourceSpec[] = [
  { scopeId: "tenant-a", entityType: "invoice", entityId: "e1" },
  { scopeId: "tenant-a", entityType: "invoice", entityId: "E1" },
  { scopeId: "Tenant-A", entityType: "invoice", entityId: "e1" },
  { scopeId: "tenant-a", entityType: "Invoice", entityId: "e1" },
  { scopeId: "tenant-a ", entityType: "invoice", entityId: "e1" },
  { scopeId: "tenänt-é", entityType: "invoice", entityId: "e1" },
]

export interface Extras { version?: number; eventId?: string; auditId?: string }

export type BadVariant = "deleted-with-state" | "created-null-state" | "bad-event-id" | "bad-entity-id" | "array-state" | "negative-version"

export type Op =
  | { k: "append"; r: number; kind: Kind; at: number; state: State | null; extras: Extras }
  /** A malformed revision: rejected by validation with ConfigurationError, touching nothing. */
  | { k: "bad"; r: number; variant: BadVariant; at: number }
  /** Saves the honest snapshot of `revision` (0 = the empty history); `conflicting` instead saves a different state at an already-saved revision. */
  | { k: "snapshot"; r: number; revision: number; conflicting: boolean }
  | { k: "reconstruct"; r: number; asOf: number; pageSize: number; maxRevisions: number }
  | { k: "page"; r: number; after: number; asOf: number; limit: number }
  | { k: "latestSnapshot"; r: number; asOf: number }

export interface Revision { revision: number; at: number; kind: Kind; state: State | null; version: number | null; eventId: string | null; auditId: string | null }
export interface Snap { revision: number; at: number; state: State | null }

export type AppendOutcome = { ok: Revision } | { error: "conflict" }
export interface ReconstructionOutcome { revision: number | null; state: State | null; deleted: boolean; replayed: number }
export type ReconstructResult = { ok: ReconstructionOutcome } | { error: "ConfigurationError" }
export interface PageOutcome { items: Revision[]; hasMore: boolean }

export interface RawRevision extends Revision { scopeId: string; entityType: string; entityId: string }
export interface RawHead { scopeId: string; entityType: string; entityId: string; revision: number; at: number; kind: Kind }
export interface RawSnapshot extends Snap { scopeId: string; entityType: string; entityId: string }
export interface TableDump { heads: RawHead[]; revisions: RawRevision[]; snapshots: RawSnapshot[] }

export const EMPTY_SNAPSHOT_AT = T0 - 1000

const identity = (r: ResourceSpec) => ({ scopeId: r.scopeId, entityType: r.entityType, entityId: r.entityId })

/** The next revision is legal iff the lifecycle allows the kind and the instant is not before the head's. */
export function legalNext(head: Revision | undefined, kind: Kind, at: number): boolean {
  if (head === undefined) return kind === "created"
  if (at < head.at) return false
  return head.kind === "deleted" ? kind === "restored" : kind === "updated" || kind === "deleted"
}

export class RefTemporal {
  readonly histories: Revision[][] = RESOURCES.map(() => [])
  readonly snaps: Map<number, Snap>[] = RESOURCES.map(() => new Map())

  head(r: number): Revision | undefined { return this.histories[r]![this.histories[r]!.length - 1] }

  append(op: Extract<Op, { k: "append" }>): AppendOutcome {
    const history = this.histories[op.r]!
    if (!legalNext(this.head(op.r), op.kind, op.at)) return { error: "conflict" }
    const rev: Revision = { revision: history.length + 1, at: op.at, kind: op.kind, state: op.state, version: op.extras.version ?? null, eventId: op.extras.eventId ?? null, auditId: op.extras.auditId ?? null }
    history.push(rev)
    return { ok: rev }
  }

  /** The snapshot a `snapshot` op saves, or null when the op does not apply (nothing to snapshot, or nothing to conflict with). */
  snapshotFor(op: Extract<Op, { k: "snapshot" }>): Snap | null {
    const history = this.histories[op.r]!
    if (op.revision > history.length) return null
    const honest: Snap = op.revision === 0 ? { revision: 0, at: EMPTY_SNAPSHOT_AT, state: null } : { revision: op.revision, at: history[op.revision - 1]!.at, state: history[op.revision - 1]!.state }
    if (!op.conflicting) return honest
    if (!this.snaps[op.r]!.has(op.revision) || op.revision === 0) return null
    return { ...honest, state: { conflicting: true, revision: op.revision } }
  }

  saveSnapshot(r: number, snap: Snap): void { if (!this.snaps[r]!.has(snap.revision)) this.snaps[r]!.set(snap.revision, snap) }

  latestSnapshot(r: number, asOf: number): Snap | null {
    let best: Snap | null = null
    for (const snap of this.snaps[r]!.values()) if (snap.at <= asOf && (best === null || snap.revision > best.revision)) best = snap
    return best
  }

  page(r: number, after: number, asOf: number, limit: number): PageOutcome {
    const eligible = this.histories[r]!.filter((rev) => rev.revision > after && rev.at <= asOf)
    return { items: eligible.slice(0, limit), hasMore: eligible.length > limit }
  }

  /** State at the instant by scanning the whole history; independent of snapshots. */
  scan(r: number, asOf: number): { revision: number | null; state: State | null; deleted: boolean } {
    let last: Revision | undefined
    for (const rev of this.histories[r]!) if (rev.at <= asOf) last = rev
    return { revision: last?.revision ?? null, state: last?.state ?? null, deleted: last !== undefined && last.state === null }
  }

  reconstruct(op: Extract<Op, { k: "reconstruct" }>): ReconstructResult {
    const truth = this.scan(op.r, op.asOf)
    const base = this.latestSnapshot(op.r, op.asOf)?.revision ?? 0
    const replayed = Math.max((truth.revision ?? 0) - base, 0)
    if (replayed > op.maxRevisions) return { error: "ConfigurationError" }
    return { ok: { ...truth, replayed } }
  }

  dump(): TableDump {
    const dump: TableDump = { heads: [], revisions: [], snapshots: [] }
    for (const [r, history] of this.histories.entries()) {
      const id = identity(RESOURCES[r]!)
      for (const rev of history) dump.revisions.push({ ...id, ...rev })
      const head = history[history.length - 1]
      if (head) dump.heads.push({ ...id, revision: head.revision, at: head.at, kind: head.kind })
      for (const snap of this.snaps[r]!.values()) dump.snapshots.push({ ...id, ...snap })
    }
    return sortDump(dump)
  }
}

const cmp = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0)
const byKey = (a: { scopeId: string; entityType: string; entityId: string; revision: number }, b: typeof a): number => cmp(a.scopeId, b.scopeId) || cmp(a.entityType, b.entityType) || cmp(a.entityId, b.entityId) || cmp(a.revision, b.revision)
export function sortDump(dump: TableDump): TableDump {
  return { heads: [...dump.heads].sort(byKey), revisions: [...dump.revisions].sort(byKey), snapshots: [...dump.snapshots].sort(byKey) }
}

// ---------------------------------------------------------------------------------------------------------------
// Generation

const WORDS = ["alpha", "é", "日本", "a b", "", "quote\"d", "back\\slash", "line\nbreak"]

export function generateState(rng: Rng, tag: number): State {
  const state: State = { tag, n: rng.int(1000) - 500, s: rng.pick(WORDS), nested: { list: [1, 2.5, null, true, rng.pick(WORDS)], flag: rng.bool() } }
  if (rng.bool(0.2)) state.empty = {}
  return state
}

export function generateExtras(rng: Rng): Extras {
  const extras: Extras = {}
  if (rng.bool(0.5)) extras.version = rng.pick([0, 1, 7, 1_000_000])
  if (rng.bool(0.4)) extras.eventId = `evt-${rng.int(50)}`
  if (rng.bool(0.4)) extras.auditId = `aud:${rng.int(50)}`
  return extras
}

const GAPS = [0, 0, 1, 1, 5, 1000]
const KINDS: readonly Kind[] = ["created", "updated", "deleted", "restored"]

export interface GenerateOptions { min?: number; max?: number }

export function generateOps(rng: Rng, options: GenerateOptions = {}): Op[] {
  const scratch = new RefTemporal()
  const count = (options.min ?? 12) + rng.int((options.max ?? 40) - (options.min ?? 12) + 1)
  const ops: Op[] = []
  let clock = T0
  const maxAt = (): number => Math.max(clock, ...scratch.histories.map((h) => h[h.length - 1]?.at ?? 0))
  const interesting = (r: number): number => {
    const history = scratch.histories[r]!
    if (history.length > 0 && rng.bool(0.7)) return history[rng.int(history.length)]!.at + rng.pick([-1, 0, 0, 1])
    return T0 - 2000 + rng.int(maxAt() - T0 + 5000)
  }
  for (let i = 0; i < count; i++) {
    const r = rng.bool(0.75) ? rng.int(3) : rng.int(RESOURCES.length)
    const roll = rng.int(100)
    let op: Op
    if (roll < 52) {
      const head = scratch.head(r)
      let kind: Kind
      let at: number
      if (rng.bool(0.8)) {
        kind = head === undefined ? "created" : head.kind === "deleted" ? "restored" : rng.bool(0.25) ? "deleted" : "updated"
        at = (head?.at ?? clock) + rng.pick(GAPS)
      } else {
        kind = rng.pick(KINDS)
        at = (head?.at ?? clock) + rng.pick([-5, -1, 0, 0, 3])
      }
      op = { k: "append", r, kind, at, state: kind === "deleted" ? null : generateState(rng, i), extras: generateExtras(rng) }
      scratch.append(op)
      clock = Math.max(clock, at)
    } else if (roll < 56) {
      op = { k: "bad", r, variant: rng.pick(["deleted-with-state", "created-null-state", "bad-event-id", "bad-entity-id", "array-state", "negative-version"] as const), at: clock }
    } else if (roll < 68) {
      const history = scratch.histories[r]!
      const conflicting = rng.bool(0.2)
      op = { k: "snapshot", r, revision: rng.int(history.length + 1), conflicting }
      const snap = scratch.snapshotFor(op)
      if (snap) scratch.saveSnapshot(r, snap)
    } else if (roll < 88) {
      const pageSize = rng.pick([1, 2, 3, 5, 250])
      const maxRevisions = rng.pick([1, 2, 3, 5, 10_000, 10_000])
      op = { k: "reconstruct", r, asOf: interesting(r), pageSize: Math.min(pageSize, maxRevisions), maxRevisions }
    } else if (roll < 96) {
      op = { k: "page", r, after: rng.pick([0, 0, 1, 2, 5]), asOf: interesting(r), limit: rng.pick([1, 2, 3, 4, 100]) }
    } else {
      op = { k: "latestSnapshot", r, asOf: interesting(r) }
    }
    ops.push(op)
  }
  return ops
}

export function* shrinkOps(ops: Op[]): Generator<Op[]> {
  for (let size = Math.ceil(ops.length / 2); size >= 1; size = Math.floor(size / 2)) {
    for (let start = 0; start + size <= ops.length; start += size) yield [...ops.slice(0, start), ...ops.slice(start + size)]
    if (size === 1) break
  }
}

export function describeOps(ops: Op[]): string {
  return ops.map((op, i) => `${i}: ${JSON.stringify(op)}`).join("\n")
}
