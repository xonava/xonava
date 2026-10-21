import { expect, it } from "vitest"
import { ConflictError, type ExecutionScopeId } from "@xonava/core/domain"
import { reconstructAsOf, type NewTemporalRevision, type TemporalHistoryStore, type TemporalResource, type TemporalRevision } from "@xonava/core/temporal"
import { forAllAsync, scaledRuns } from "../../../core/src/__tests__/differential/harness.js"
import { TIMING_SCALE } from "../../../core/src/__tests__/timing.js"
import {
  RESOURCES, RefTemporal, T0, describeOps, generateOps, legalNext, shrinkOps, sortDump,
  type AppendOutcome, type Kind, type Op, type PageOutcome, type ReconstructResult, type Revision, type Snap, type State, type TableDump,
} from "./temporalStoreDifferentialModel.js"

export interface TemporalStoreDifferentialDriver {
  /** Property-name suffix, e.g. "postgres". */
  label: string
  store: TemporalHistoryStore<State>
  /** Deletes every head, revision and snapshot row. */
  reset(): Promise<void>
  /** Raw table contents, read with SQL independent of the adapter. */
  dump(): Promise<TableDump>
  /** True when a rejected append raises ConflictError (PostgreSQL, MySQL); D1 surfaces the database's own abort error. */
  conflictErrors: boolean
  /** True for errors a caller is expected to retry (a MySQL deadlock victim); the append rolled back as a whole. */
  retryable?(error: unknown): boolean
  lifecycleRuns?: number
  concurrencyRuns?: number
  /** Slow transports (Miniflare D1) use short sequences and compare the tables only at the end. */
  light?: boolean
  /** Upper bound of concurrent workers (the connection pool size). */
  maxWorkers?: number
}

export const PROPERTY_TIMEOUT_MS = Math.ceil(300_000 * Math.max(1, scaledRuns(100) / 100) * TIMING_SCALE)

const resourceOf = (r: number): TemporalResource => ({ ...RESOURCES[r]!, scopeId: RESOURCES[r]!.scopeId as ExecutionScopeId })

function normalize(rev: TemporalRevision<State>): Revision {
  return { revision: rev.revision, at: rev.occurredAt.getTime(), kind: rev.kind, state: rev.state, version: rev.entityVersion ?? null, eventId: rev.eventId ?? null, auditId: rev.auditId ?? null }
}

function toNew(r: number, kind: Kind, at: number, state: State | null, extras: { version?: number; eventId?: string; auditId?: string }): NewTemporalRevision<State> {
  return {
    ...resourceOf(r), occurredAt: new Date(at), kind, state,
    ...(extras.version === undefined ? {} : { entityVersion: extras.version }),
    ...(extras.eventId === undefined ? {} : { eventId: extras.eventId }),
    ...(extras.auditId === undefined ? {} : { auditId: extras.auditId }),
  }
}

function classify(driver: TemporalStoreDifferentialDriver, error: unknown): "ConfigurationError" | "conflict" {
  if (error instanceof Error && error.name === "ConfigurationError") return "ConfigurationError"
  if (driver.conflictErrors) { if (error instanceof ConflictError) return "conflict"; throw error }
  if (error instanceof Error) return "conflict"
  throw error
}

async function append(driver: TemporalStoreDifferentialDriver, value: NewTemporalRevision<State>): Promise<{ ok: Revision } | { error: "ConfigurationError" | "conflict" }> {
  for (let attempt = 0; ; attempt++) {
    try { return { ok: normalize(await driver.store.append(value)) } } catch (error) {
      if (driver.retryable?.(error) && attempt < 25) continue
      return { error: classify(driver, error) }
    }
  }
}

async function reconstruct(driver: TemporalStoreDifferentialDriver, op: Extract<Op, { k: "reconstruct" }>): Promise<ReconstructResult> {
  try {
    const out = await reconstructAsOf(driver.store, resourceOf(op.r), new Date(op.asOf), { pageSize: op.pageSize, maxRevisions: op.maxRevisions })
    expect(out.asOf.getTime()).toBe(op.asOf)
    return { ok: { revision: out.revision, state: out.state, deleted: out.deleted, replayed: out.replayedRevisions } }
  } catch (error) {
    if (error instanceof Error && error.name === "ConfigurationError") return { error: "ConfigurationError" }
    throw error
  }
}

async function expectTables(driver: TemporalStoreDifferentialDriver, model: RefTemporal, what: string): Promise<void> {
  expect(sortDump(await driver.dump()), what).toEqual(model.dump())
}

const BAD_BASE = (at: number) => ({ kind: "updated" as Kind, at, state: { x: 1 } as State | null })

export async function runTemporal(driver: TemporalStoreDifferentialDriver, ops: Op[]): Promise<void> {
  await driver.reset()
  const model = new RefTemporal()
  for (const [index, op] of ops.entries()) {
    const step = `step ${index} ${op.k}`
    switch (op.k) {
      case "append": {
        const expected: AppendOutcome = model.append(op)
        const actual = await append(driver, toNew(op.r, op.kind, op.at, op.state, op.extras))
        expect(actual, step).toEqual(expected)
        break
      }
      case "bad": {
        const base = BAD_BASE(op.at)
        const value = toNew(op.r, base.kind, base.at, base.state, {})
        const mutated: Record<typeof op.variant, NewTemporalRevision<State>> = {
          "deleted-with-state": { ...value, kind: "deleted" },
          "created-null-state": { ...value, kind: "created", state: null },
          "bad-event-id": { ...value, eventId: "bad id!" },
          "bad-entity-id": { ...value, entityId: "bad id!" },
          "array-state": { ...value, state: [] as never },
          "negative-version": { ...value, entityVersion: -1 },
        }
        expect(await append(driver, mutated[op.variant]), step).toEqual({ error: "ConfigurationError" })
        break
      }
      case "snapshot": {
        const snap = model.snapshotFor(op)
        if (snap !== null) {
          await driver.store.saveSnapshot({ ...resourceOf(op.r), revision: snap.revision, occurredAt: new Date(snap.at), state: snap.state })
          model.saveSnapshot(op.r, snap)
        }
        break
      }
      case "reconstruct":
        expect(await reconstruct(driver, op), step).toEqual(model.reconstruct(op))
        break
      case "page": {
        const page = await driver.store.revisions(resourceOf(op.r), { afterRevision: op.after, asOf: new Date(op.asOf), limit: op.limit })
        const actual: PageOutcome = { items: page.items.map(normalize), hasMore: page.hasMore }
        expect(actual, step).toEqual(model.page(op.r, op.after, op.asOf, op.limit))
        break
      }
      case "latestSnapshot": {
        const found = await driver.store.latestSnapshot(resourceOf(op.r), new Date(op.asOf))
        const actual: Snap | null = found === null ? null : { revision: found.revision, at: found.occurredAt.getTime(), state: found.state }
        expect(actual, step).toEqual(model.latestSnapshot(op.r, op.asOf))
        break
      }
    }
    if (!driver.light) await expectTables(driver, model, `tables after step ${index}`)
  }
  await expectTables(driver, model, "final tables")
}

/**
 * Registers the sequential store-vs-reference differential: lifecycle (create, update, delete, restore) with
 * chronology and transition rejections, optional version/event/audit ids, honest snapshots, snapshot lookup, bounded
 * pages with more rows than the limit, point-in-time reconstruction at random instants, and isolation between
 * resources that differ only by case, trailing space or non-ASCII text. Deterministic integration tests of the same
 * stores live in integration/{pg,mysql,d1}/temporal*.integration.test.ts and are not duplicated here.
 */
export function defineTemporalDifferential(driver: TemporalStoreDifferentialDriver): void {
  it(`temporal history matches the reference model (${driver.label})`, async () => {
    await forAllAsync(`temporal store lifecycle differential (${driver.label})`, (rng) => generateOps(rng, driver.light ? { min: 5, max: 12 } : {}), (ops) => runTemporal(driver, ops), {
      runs: driver.lifecycleRuns ?? 60, shrink: shrinkOps, describe: describeOps, maxShrinkSteps: 100,
    })
  }, PROPERTY_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------------------------------------------
// Snapshot equivalence

interface EquivalenceCase { kinds: Kind[]; gaps: number[]; probes: number[]; pageSize: number; snapshotRevisions: number[] }

/** Saving snapshots after the fact must not change any reconstruction (revision, state, deleted), only how much is replayed. */
export function defineSnapshotEquivalence(driver: TemporalStoreDifferentialDriver): void {
  it(`snapshots do not change reconstruction results (${driver.label})`, async () => {
    await forAllAsync(`temporal store snapshot equivalence (${driver.label})`, (rng): EquivalenceCase => {
      const kinds: Kind[] = ["created"]
      let deleted = false
      const n = 1 + rng.int(driver.light ? 8 : 14)
      for (let i = 0; i < n; i++) { if (deleted) { kinds.push("restored"); deleted = false } else if (rng.bool(0.3)) { kinds.push("deleted"); deleted = true } else kinds.push("updated") }
      return { kinds, gaps: kinds.map(() => rng.pick([0, 1, 1, 10, 1000])), probes: Array.from({ length: 6 }, () => rng.int(3000) - 200), pageSize: rng.pick([1, 2, 3, 250]), snapshotRevisions: rng.subset(kinds.map((_, i) => i + 1), 0.4) }
    }, async (c) => {
      await driver.reset()
      const model = new RefTemporal()
      let at = T0
      for (const [i, kind] of c.kinds.entries()) {
        at += c.gaps[i]!
        const op = { k: "append" as const, r: 0, kind, at, state: kind === "deleted" ? null : { rev: i + 1 }, extras: {} }
        model.append(op)
        expect(await append(driver, toNew(0, kind, at, op.state, {}))).toEqual({ ok: model.head(0) })
      }
      const instants = [...c.probes.map((p) => T0 + p), ...model.histories[0]!.flatMap((rev) => [rev.at - 1, rev.at])]
      const run = async (): Promise<Array<{ revision: number | null; state: State | null; deleted: boolean; replayed: number }>> => {
        const out = []
        for (const asOf of instants) {
          const result = await reconstruct(driver, { k: "reconstruct", r: 0, asOf, pageSize: c.pageSize, maxRevisions: 10_000 })
          if (!("ok" in result)) throw new Error(`reconstruction at ${asOf} failed`)
          out.push(result.ok)
        }
        return out
      }
      const before = await run()
      for (const revision of c.snapshotRevisions) {
        const snap = model.snapshotFor({ k: "snapshot", r: 0, revision, conflicting: false })!
        await driver.store.saveSnapshot({ ...resourceOf(0), revision, occurredAt: new Date(snap.at), state: snap.state })
        model.saveSnapshot(0, snap)
      }
      const after = await run()
      for (const [i, asOf] of instants.entries()) {
        const truth = model.scan(0, asOf)
        expect({ revision: before[i]!.revision, state: before[i]!.state, deleted: before[i]!.deleted }, `unsnapshotted at ${asOf}`).toEqual(truth)
        expect({ revision: after[i]!.revision, state: after[i]!.state, deleted: after[i]!.deleted }, `snapshotted at ${asOf}`).toEqual(truth)
        expect(after[i]!.replayed, `replay at ${asOf}`).toBe((model.reconstruct({ k: "reconstruct", r: 0, asOf, pageSize: 1, maxRevisions: 10_000 }) as { ok: { replayed: number } }).ok.replayed)
        expect(after[i]!.replayed).toBeLessThanOrEqual(before[i]!.replayed)
      }
    }, { runs: driver.lifecycleRuns ?? 50, describe: (c) => JSON.stringify(c) })
  }, PROPERTY_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------------------------------------------
// Concurrency

interface UpdateRaceCase { workers: number; rounds: number; burst: boolean; entities: number; plan: number[][] }
interface MixedRaceCase { workers: number; rounds: number; burst: boolean; plan: Kind[][] }

const RACE_AT = T0 + 10

/**
 * Several workers append `updated` revisions to a few entities at the same instant. Revision allocation serialises per
 * entity: the returned numbers are exactly 2..n+1 (after the creation), the table holds the same contiguous revisions
 * with the state each worker wrote, the head ends at n+1 and reconstruction at the instant returns the last one.
 */
export function defineConcurrentAppends(driver: TemporalStoreDifferentialDriver): void {
  it(`concurrent appends to one entity serialise without gaps or duplicate revisions (${driver.label})`, async () => {
    await forAllAsync(`temporal store concurrent appends (${driver.label})`, (rng): UpdateRaceCase => {
      const workers = 2 + rng.int(Math.min(driver.maxWorkers ?? 10, 10) - 1)
      const rounds = 2 + rng.int(driver.light ? 3 : 5)
      const entities = 1 + rng.int(3)
      return { workers, rounds, burst: rng.bool(0.4), entities, plan: Array.from({ length: workers }, () => Array.from({ length: rounds }, () => rng.int(entities))) }
    }, async (c) => {
      await driver.reset()
      for (let r = 0; r < c.entities; r++) expect(await append(driver, toNew(r, "created", T0, { uid: -1 }, {}))).toMatchObject({ ok: { revision: 1 } })
      const written = new Map<string, number>()
      const perEntity: number[][] = Array.from({ length: c.entities }, () => [])
      let uid = 0
      const work = async (w: number): Promise<void> => {
        const step = async (r: number): Promise<void> => {
          const id = uid++
          const out = await append(driver, toNew(r, "updated", RACE_AT, { uid: id }, {}))
          if (!("ok" in out)) throw new Error(`worker ${w}: unexpected ${JSON.stringify(out)}`)
          perEntity[r]!.push(out.ok.revision)
          written.set(`${r}:${out.ok.revision}`, id)
        }
        if (c.burst) await Promise.all(c.plan[w]!.map(step))
        else for (const r of c.plan[w]!) await step(r)
      }
      await Promise.all(c.plan.map((_, w) => work(w)))
      const dump = await driver.dump()
      for (let r = 0; r < c.entities; r++) {
        const revisions = perEntity[r]!.sort((a, b) => a - b)
        expect(revisions, `revisions of entity ${r}`).toEqual(Array.from({ length: revisions.length }, (_, i) => i + 2))
        const rows = dump.revisions.filter((row) => row.scopeId === RESOURCES[r]!.scopeId && row.entityType === RESOURCES[r]!.entityType && row.entityId === RESOURCES[r]!.entityId).sort((a, b) => a.revision - b.revision)
        expect(rows.map((row) => row.revision), `stored revisions of entity ${r}`).toEqual(Array.from({ length: revisions.length + 1 }, (_, i) => i + 1))
        for (const row of rows.slice(1)) expect((row.state as { uid: number }).uid, `state of ${r}:${row.revision}`).toBe(written.get(`${r}:${row.revision}`))
        const head = dump.heads.find((h) => h.scopeId === RESOURCES[r]!.scopeId && h.entityType === RESOURCES[r]!.entityType && h.entityId === RESOURCES[r]!.entityId)
        expect(head?.revision, `head of entity ${r}`).toBe(revisions.length + 1)
        expect(await reconstruct(driver, { k: "reconstruct", r, asOf: RACE_AT, pageSize: 3, maxRevisions: 10_000 }), `reconstruction of ${r}`).toMatchObject({ ok: { revision: revisions.length + 1, deleted: false } })
      }
    }, { runs: driver.concurrencyRuns ?? 50, describe: (c) => JSON.stringify(c) })
  }, PROPERTY_TIMEOUT_MS)
}

/**
 * Workers race arbitrary kinds on one entity that does not exist yet. Whatever the interleaving, the accepted appends
 * must form a gapless, duplicate-free stream of lifecycle-legal revisions beginning with exactly one creation, each
 * accepted append must be the row stored under its returned revision, and every rejected append must leave no trace.
 */
export function defineConcurrentLifecycle(driver: TemporalStoreDifferentialDriver): void {
  it(`racing lifecycle appends accept a gapless, legal stream and reject the rest (${driver.label})`, async () => {
    await forAllAsync(`temporal store concurrent lifecycle (${driver.label})`, (rng): MixedRaceCase => {
      const workers = 2 + rng.int(Math.min(driver.maxWorkers ?? 10, 10) - 1)
      const rounds = 1 + rng.int(driver.light ? 3 : 4)
      return { workers, rounds, burst: rng.bool(0.4), plan: Array.from({ length: workers }, () => Array.from({ length: rounds }, () => rng.pick(["created", "created", "updated", "updated", "deleted", "restored"] as const))) }
    }, async (c) => {
      await driver.reset()
      const accepted = new Map<number, { kind: Kind; uid: number }>()
      let rejected = 0
      let total = 0
      let uid = 0
      const work = async (w: number): Promise<void> => {
        const step = async (kind: Kind): Promise<void> => {
          const id = uid++
          total++
          const out = await append(driver, toNew(0, kind, RACE_AT, kind === "deleted" ? null : { uid: id }, {}))
          if ("ok" in out) { expect(accepted.has(out.ok.revision), `duplicate revision ${out.ok.revision}`).toBe(false); accepted.set(out.ok.revision, { kind, uid: id }) } else if (out.error === "conflict") rejected++
          else throw new Error(`worker ${w}: unexpected ${JSON.stringify(out)}`)
        }
        if (c.burst) await Promise.all(c.plan[w]!.map(step))
        else for (const kind of c.plan[w]!) await step(kind)
      }
      await Promise.all(c.plan.map((_, w) => work(w)))
      expect(accepted.size + rejected, "every append is accepted or rejected").toBe(total)
      const dump = await driver.dump()
      const rows = dump.revisions.filter((row) => row.scopeId === RESOURCES[0]!.scopeId && row.entityId === RESOURCES[0]!.entityId).sort((a, b) => a.revision - b.revision)
      expect(rows.map((row) => row.revision), "stored revisions").toEqual(Array.from({ length: accepted.size }, (_, i) => i + 1))
      let head: Revision | undefined
      for (const row of rows) {
        const entry = accepted.get(row.revision)!
        expect(row.kind, `kind of revision ${row.revision}`).toBe(entry.kind)
        if (entry.kind !== "deleted") expect((row.state as { uid: number }).uid, `state of revision ${row.revision}`).toBe(entry.uid)
        expect(legalNext(head, row.kind, row.at), `revision ${row.revision} (${row.kind}) is a legal successor`).toBe(true)
        head = row
      }
      if (rows.length > 0) {
        expect(dump.heads).toEqual([{ ...RESOURCES[0]!, revision: rows.length, at: RACE_AT, kind: rows[rows.length - 1]!.kind }])
        expect(await reconstruct(driver, { k: "reconstruct", r: 0, asOf: RACE_AT, pageSize: 2, maxRevisions: 10_000 })).toMatchObject({ ok: { revision: rows.length } })
      } else expect(dump.heads).toEqual([])
    }, { runs: driver.concurrencyRuns ?? 50, describe: (c) => JSON.stringify(c) })
  }, PROPERTY_TIMEOUT_MS)
}
