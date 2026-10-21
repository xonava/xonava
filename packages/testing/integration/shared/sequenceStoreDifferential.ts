import { expect, it } from "vitest"
import { allocateSequence, type SequenceAllocation, type SequenceStore } from "@xonava/core/sequence"
import type { ExecutionScopeId } from "@xonava/core/domain"
import { forAllAsync, scaledRuns, type Rng } from "../../../core/src/__tests__/differential/harness.js"
import {
  EXOTIC_SCOPES, HOUR, INVALID_SCOPES, NAMES, RefSequence, SCOPES, ZONES, compareCounters, counterKey, describeAlloc, describeOps, generateDef, generateOps, nextBoundary, oraclePeriod, shrinkOps,
  type AllocSpec, type Counter, type DefSpec, type Op, type RefOutcome,
} from "./sequenceStoreDifferentialModel.js"

/** Raw `sequences` row, read with SQL independent of the adapter. */
export type RawSequenceRow = Counter

export interface SequenceStoreDifferentialDriver {
  /** Property-name suffix, e.g. "postgres". */
  label: string
  store: SequenceStore
  /** Deletes every counter row. */
  reset(): Promise<void>
  dump(): Promise<RawSequenceRow[]>
  /** Writes a counter row directly (for boundary values). */
  seed(scope: string, name: string, period: string, value: number): Promise<void>
  /**
   * Runs `fn` with a store bound to one database transaction, then commits or rolls back. Absent where the database has
   * no interactive transactions (D1 commits an allocation together with its consumer in one batch instead).
   */
  transact?<T>(commit: boolean, fn: (store: SequenceStore) => Promise<T>): Promise<T>
  /** D1 only: `nextWithStatements` with a consumer statement that records the allocated value. */
  batchAllocate?(scope: string, name: string, period: string, failConsumer: boolean): Promise<{ value: number; consumed: number[] }>
  /** Known store deviations (each one a finding), pinned by it.fails regressions. */
  deviations?: { trailingSpaceScope?: string; nonAsciiScope?: string }
  /** True for errors a caller is expected to retry as a whole transaction (a MySQL deadlock victim). */
  retryable?(error: unknown): boolean
  /** Base run count of the sequential property. */
  lifecycleRuns?: number
  /** Base run count of the concurrency properties. */
  concurrencyRuns?: number
  /** Slow transports (Miniflare D1) use short sequences and compare the table only at the end of one. */
  light?: boolean
  /** Upper bound of concurrent workers (the connection pool size). */
  maxWorkers?: number
}

export const PROPERTY_TIMEOUT_MS = Math.ceil(300_000 * Math.max(1, scaledRuns(100) / 100))

const toDefinition = (def: DefSpec, name: string) => ({
  name, reset: def.reset, padding: def.padding, timeZone: def.timeZone,
  ...(def.reset === "never" ? {} : { periodFormat: def.periodFormat }),
  ...(def.prefix === undefined ? {} : { prefix: def.prefix }),
  ...(def.periodSeparator === undefined ? {} : { periodSeparator: def.periodSeparator }),
})

type Outcome = RefOutcome

async function allocate(store: SequenceStore, spec: AllocSpec): Promise<Outcome> {
  try {
    const out: SequenceAllocation = await allocateSequence(store, { scopeId: spec.scope as ExecutionScopeId, definition: toDefinition(spec.def, spec.name), at: new Date(spec.at) })
    return { ok: { scope: out.scopeId, name: out.name, period: out.period, value: out.value, formatted: out.formatted } }
  } catch (error) {
    if (error instanceof Error && error.name === "ConfigurationError") return { error: "ConfigurationError" }
    throw error
  }
}

function describeOutcome(outcome: Outcome): string { return JSON.stringify(outcome) }

function expectSameOutcome(actual: Outcome, expected: Outcome, what: string): void {
  expect(describeOutcome(actual), what).toBe(describeOutcome(expected))
}

async function expectTable(driver: SequenceStoreDifferentialDriver, model: RefSequence, what: string): Promise<void> {
  const actual = (await driver.dump()).sort(compareCounters)
  expect(actual, what).toEqual(model.dump())
}

export async function runSequence(driver: SequenceStoreDifferentialDriver, ops: Op[]): Promise<void> {
  await driver.reset()
  const model = new RefSequence()
  for (const [index, op] of ops.entries()) {
    if (op.k === "alloc") {
      expectSameOutcome(await allocate(driver.store, op), model.alloc(op), `step ${index} alloc`)
    } else {
      const expected = model.tx(op)
      const actual = await driver.transact!(op.commit, async (store) => { const outcomes: Outcome[] = []; for (const spec of op.allocs) outcomes.push(await allocate(store, spec)); return outcomes })
      expect(actual.map(describeOutcome), `step ${index} tx outcomes`).toEqual(expected.map(describeOutcome))
    }
    if (!driver.light) await expectTable(driver, model, `table after step ${index}`)
  }
  await expectTable(driver, model, "final table")
}

/** Registers the sequential store-vs-reference differential (reset boundaries, zones, DST, formats, rollback). */
export function defineSequenceDifferential(driver: SequenceStoreDifferentialDriver): void {
  it(`sequence allocations match the reference model (${driver.label})`, async () => {
    await forAllAsync(`sequence store lifecycle differential (${driver.label})`, (rng) => generateOps(rng, { transactional: driver.transact !== undefined, ...(driver.light ? { min: 4, max: 9 } : {}) }), (ops) => runSequence(driver, ops), {
      runs: driver.lifecycleRuns ?? 60, shrink: shrinkOps, describe: describeOps, maxShrinkSteps: 100,
    })
  }, PROPERTY_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------------------------------------------
// Concurrency

interface ConcurrentCase { workers: number; rounds: number; burst: boolean; keys: AllocSpec[]; plan: number[][] }

/** Allocation specs on a few contested keys; some keys share (scope, name) but differ by period (day boundary). */
function generateKeys(rng: Rng): AllocSpec[] {
  const count = 1 + rng.int(3)
  const scope = rng.pick(SCOPES.slice(0, 3))
  const name = rng.pick(NAMES.slice(0, 3))
  const zone = rng.pick(ZONES)
  const def: DefSpec = { ...generateDef(rng, "day"), periodFormat: "iso", timeZone: zone }
  const base = Date.UTC(2026, 2, 1) + rng.int(300) * 24 * HOUR
  const boundary = nextBoundary("day", zone, base) ?? base
  const keys: AllocSpec[] = []
  for (let i = 0; i < count; i++) keys.push(rng.bool(0.7) ? { scope, name, def, at: boundary + (i === 0 ? -1 : i === 1 ? 0 : 24 * HOUR) } : { scope: rng.pick(SCOPES.slice(0, 3)), name: rng.pick(NAMES.slice(0, 3)), def, at: boundary })
  return keys
}

/**
 * Several workers allocate on the same few keys at once against the real database. Every (scope, name, period) must
 * receive exactly 1..n: no duplicates and no gaps, each worker sees strictly increasing values per key, formatted
 * values do not repeat, and the table ends at n.
 */
export function defineConcurrentAllocation(driver: SequenceStoreDifferentialDriver): void {
  it(`concurrent allocation yields 1..n per key with no gaps or duplicates (${driver.label})`, async () => {
    await forAllAsync(`sequence store concurrent allocation (${driver.label})`, (rng): ConcurrentCase => {
      const keys = generateKeys(rng)
      const workers = 2 + rng.int(Math.min(driver.maxWorkers ?? 10, 10) - 1)
      const rounds = 2 + rng.int(driver.light ? 3 : 6)
      return { workers, rounds, burst: rng.bool(0.4), keys, plan: Array.from({ length: workers }, () => Array.from({ length: rounds }, () => rng.int(keys.length))) }
    }, async (c) => {
      await driver.reset()
      const perWorker: Array<Array<{ key: number; out: Extract<Outcome, { ok: unknown }>["ok"] }>> = c.plan.map(() => [])
      const work = async (w: number): Promise<void> => {
        const step = async (key: number): Promise<void> => {
          const outcome = await allocate(driver.store, c.keys[key]!)
          if (!("ok" in outcome)) throw new Error(`worker ${w}: unexpected ${describeOutcome(outcome)}`)
          perWorker[w]!.push({ key, out: outcome.ok })
        }
        if (c.burst) await Promise.all(c.plan[w]!.map(step))
        else for (const key of c.plan[w]!) await step(key)
      }
      await Promise.all(c.plan.map((_, w) => work(w)))
      const byCounter = new Map<string, number[]>()
      const formatted = new Map<string, Set<string>>()
      for (const entries of perWorker) {
        const last = new Map<string, number>()
        for (const { key, out } of entries) {
          const counter = counterKey(out.scope, out.name, out.period)
          expect(out.period, "period").toBe(oraclePeriod("day", c.keys[key]!.at, c.keys[key]!.def.timeZone))
          ;(byCounter.get(counter) ?? byCounter.set(counter, []).get(counter)!).push(out.value)
          const seen = formatted.get(counter) ?? new Set<string>()
          expect(seen.has(out.formatted), `formatted ${out.formatted} repeated`).toBe(false)
          seen.add(out.formatted)
          formatted.set(counter, seen)
          if (!c.burst) {
            expect(out.value, `worker order on ${counter}`).toBeGreaterThan(last.get(counter) ?? 0)
            last.set(counter, out.value)
          }
        }
      }
      const rows = new Map((await driver.dump()).map((row) => [counterKey(row.scope, row.name, row.period), row.value]))
      expect(rows.size, "row count").toBe(byCounter.size)
      for (const [counter, values] of byCounter) {
        expect(values.sort((a, b) => a - b), `values of ${counter}`).toEqual(Array.from({ length: values.length }, (_, i) => i + 1))
        expect(rows.get(counter), `final value of ${counter}`).toBe(values.length)
      }
    }, { runs: driver.concurrencyRuns ?? 50, describe: (c) => `${c.workers} workers x ${c.rounds} rounds, burst=${c.burst}\nkeys:\n${c.keys.map(describeAlloc).join("\n")}\nplan: ${JSON.stringify(c.plan)}` })
  }, PROPERTY_TIMEOUT_MS)
}

interface TransactionCase { workers: number; rounds: number; key: AllocSpec; decisions: boolean[][] }

/**
 * Concurrent transactions that each allocate once and then commit or roll back. Because allocation serialises on the
 * counter row and a rollback returns the number, the committed values must be exactly 1..m (no gap from a rollback,
 * no duplicate), and the table must end at m. A transaction the database aborts as a deadlock victim (`retryable`) is
 * retried as a whole; it commits nothing, so it cannot affect the invariant.
 */
export function defineConcurrentTransactions(driver: SequenceStoreDifferentialDriver): void {
  if (driver.transact === undefined) return
  it(`concurrent transactions with rollbacks commit gapless numbers (${driver.label})`, async () => {
    await forAllAsync(`sequence store concurrent transactions (${driver.label})`, (rng): TransactionCase => {
      const workers = 2 + rng.int(Math.min(driver.maxWorkers ?? 8, 8) - 1)
      const rounds = 2 + rng.int(4)
      return { workers, rounds, key: { scope: rng.pick(SCOPES.slice(0, 3)), name: rng.pick(NAMES.slice(0, 3)), def: { reset: "month", periodFormat: "compact", padding: 4, timeZone: rng.pick(ZONES) }, at: Date.UTC(2026, 0, 15) }, decisions: Array.from({ length: workers }, () => Array.from({ length: rounds }, () => rng.bool(0.6))) }
    }, async (c) => {
      await driver.reset()
      const committed: number[] = []
      await Promise.all(c.decisions.map(async (decisions) => {
        for (const commit of decisions) {
          let outcome: Outcome | undefined
          for (let attempt = 0; outcome === undefined; attempt++) {
            try { outcome = await driver.transact!(commit, (store) => allocate(store, c.key)) } catch (error) { if (!driver.retryable?.(error) || attempt >= 25) throw error }
          }
          if (!("ok" in outcome)) throw new Error(`unexpected ${describeOutcome(outcome)}`)
          if (commit) committed.push(outcome.ok.value)
        }
      }))
      expect(committed.sort((a, b) => a - b), "committed values").toEqual(Array.from({ length: committed.length }, (_, i) => i + 1))
      const rows = await driver.dump()
      if (committed.length === 0) expect(rows, "no committed allocation leaves no row").toEqual([])
      else expect(rows.map((row) => row.value), "final counter").toEqual([committed.length])
    }, { runs: driver.concurrencyRuns ?? 50, describe: (c) => `${c.workers} workers, decisions=${JSON.stringify(c.decisions)}, key=${describeAlloc(c.key)}` })
  }, PROPERTY_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------------------------------------------
// Deterministic regressions

const SCOPE = "reg" as ExecutionScopeId

/** Deterministic cases that pin down the contract at its edges. */
export function defineSequenceRegressions(driver: SequenceStoreDifferentialDriver): void {
  const distinctScopes = async (scopes: readonly string[]): Promise<void> => {
    await driver.reset()
    for (const scope of scopes) expect(await driver.store.next(scope as ExecutionScopeId, "invoice", "all"), `first value of ${JSON.stringify(scope)}`).toBe(1)
    expect((await driver.dump()).length).toBe(scopes.length)
  }
  // A documented store deviation is pinned with it.fails: the suite stays green, and turns red (so the marker must go) once the store is fixed.
  const scopeTest = (flag: string | undefined) => (flag === undefined ? it : it.fails)

  it(`scope, name and period are compared byte-for-byte: case and tab differences are distinct counters (${driver.label})`, async () => {
    await distinctScopes(EXOTIC_SCOPES.caseAndTab)
    await driver.reset()
    for (const name of ["Invoice", "INVOICE", "invoice"]) expect(await driver.store.next("tenant-a" as ExecutionScopeId, name, "all"), `name ${name}`).toBe(1)
    for (const period of ["2026-01", "2026-1", "2026"]) expect(await driver.store.next("tenant-a" as ExecutionScopeId, "invoice", period), `period ${period}`).toBe(1)
  })

  scopeTest(driver.deviations?.trailingSpaceScope)(`scopes differing only in trailing spaces are distinct counters (${driver.label}${driver.deviations?.trailingSpaceScope === undefined ? "" : `, known deviation: ${driver.deviations.trailingSpaceScope}`})`, async () => {
    await distinctScopes(EXOTIC_SCOPES.trailingSpace)
  })

  scopeTest(driver.deviations?.nonAsciiScope)(`non-ASCII scopes are stored and distinct (${driver.label}${driver.deviations?.nonAsciiScope === undefined ? "" : `, known deviation: ${driver.deviations.nonAsciiScope}`})`, async () => {
    await distinctScopes(EXOTIC_SCOPES.nonAscii)
  })

  it(`monthly counter in Asia/Kolkata resets at local midnight, not 05:30 UTC; DST gaps and skipped days keep their own periods (${driver.label})`, async () => {
    await driver.reset()
    const month: DefSpec = { reset: "month", periodFormat: "compact", padding: 3, timeZone: "Asia/Kolkata", prefix: "INV-" }
    const at = (iso: string): AllocSpec => ({ scope: "reg", name: "inv", def: month, at: Date.parse(iso) })
    const seq = [
      ["2026-03-31T18:29:59.999Z", "INV-202603-001"], ["2026-03-31T18:29:59.999Z", "INV-202603-002"],
      ["2026-03-31T18:30:00.000Z", "INV-202604-001"], ["2026-03-31T18:30:00.001Z", "INV-202604-002"],
    ] as const
    for (const [iso, formatted] of seq) {
      const outcome = await allocate(driver.store, at(iso))
      expect(outcome, iso).toMatchObject({ ok: { formatted } })
    }
    // Sao Paulo's 2018 spring-forward happened at local midnight (00:00 became 01:00): the day 2018-11-04 starts at 01:00.
    const sp: DefSpec = { reset: "day", periodFormat: "iso", padding: 0, timeZone: "America/Sao_Paulo" }
    for (const [iso, period] of [["2018-11-04T02:59:59.999Z", "2018-11-03"], ["2018-11-04T03:00:00.000Z", "2018-11-04"]] as const) {
      expect(await allocate(driver.store, { scope: "reg", name: "sp", def: sp, at: Date.parse(iso) }), iso).toMatchObject({ ok: { period, value: 1 } })
    }
    // Apia skipped 2011-12-30 entirely: 2011-12-29T09:59Z (Dec 29 local) is followed directly by Dec 31.
    const apia: DefSpec = { reset: "day", periodFormat: "iso", padding: 0, timeZone: "Pacific/Apia" }
    for (const [iso, period] of [["2011-12-30T09:59:59.999Z", "2011-12-29"], ["2011-12-30T10:00:00.000Z", "2011-12-31"]] as const) {
      expect(await allocate(driver.store, { scope: "reg", name: "apia", def: apia, at: Date.parse(iso) }), iso).toMatchObject({ ok: { period, value: 1 } })
    }
    // The stored key carries no zone: the same local period allocated from two zones shares one counter.
    expect(await allocate(driver.store, { scope: "reg", name: "shared", def: { ...month, timeZone: "UTC" }, at: Date.parse("2026-04-10T00:00:00Z") })).toMatchObject({ ok: { value: 1 } })
    expect(await allocate(driver.store, { scope: "reg", name: "shared", def: { ...month, timeZone: "Pacific/Kiritimati" }, at: Date.parse("2026-04-10T00:00:00Z") })).toMatchObject({ ok: { value: 2 } })
  })

  it(`a local year outside 1..9999 is rejected before the store is touched (${driver.label})`, async () => {
    await driver.reset()
    const def: DefSpec = { reset: "day", periodFormat: "iso", padding: 0, timeZone: "Etc/GMT-14" }
    expect(await allocate(driver.store, { scope: "reg", name: "edge", def, at: Date.UTC(9999, 11, 31, 20) })).toEqual({ error: "ConfigurationError" })
    expect(await allocate(driver.store, { scope: "reg", name: "edge", def, at: Date.UTC(9999, 11, 31, 9) })).toMatchObject({ ok: { period: "9999-12-31", value: 1 } })
    for (const scope of INVALID_SCOPES) expect(await allocate(driver.store, { scope, name: "edge", def, at: 0 })).toEqual({ error: "ConfigurationError" })
    expect((await driver.dump()).map((row) => row.period)).toEqual(["9999-12-31"])
  })

  it(`the counter never loses precision: allocation past Number.MAX_SAFE_INTEGER fails instead of returning a rounded value (${driver.label})`, async () => {
    await driver.reset()
    await driver.seed("reg", "big", "all", Number.MAX_SAFE_INTEGER - 2)
    expect(await driver.store.next(SCOPE, "big", "all")).toBe(Number.MAX_SAFE_INTEGER - 1)
    expect(await driver.store.next(SCOPE, "big", "all")).toBe(Number.MAX_SAFE_INTEGER)
    await expect(driver.store.next(SCOPE, "big", "all")).rejects.toThrow()
  })

  if (driver.transact !== undefined) {
    it(`a rolled-back allocation returns its number; a committed one keeps it (${driver.label})`, async () => {
      await driver.reset()
      const def: DefSpec = { reset: "year", periodFormat: "iso", padding: 2, timeZone: "UTC" }
      const spec: AllocSpec = { scope: "reg", name: "tx", def, at: Date.UTC(2026, 5, 1) }
      expect(await driver.transact!(true, (store) => allocate(store, spec))).toMatchObject({ ok: { value: 1, formatted: "2026-01" } })
      expect(await driver.transact!(false, async (store) => [await allocate(store, spec), await allocate(store, spec)])).toMatchObject([{ ok: { value: 2 } }, { ok: { value: 3 } }])
      expect(await driver.transact!(true, (store) => allocate(store, spec))).toMatchObject({ ok: { value: 2, formatted: "2026-02" } })
      expect(await driver.dump()).toEqual([{ scope: "reg", name: "tx", period: "2026", value: 2 }])
    })
  }

  if (driver.batchAllocate !== undefined) {
    it(`a D1 consumer batch sees the allocated value and a failing consumer returns the number (${driver.label})`, async () => {
      await driver.reset()
      expect(await driver.batchAllocate!("reg", "batch", "2026", false)).toEqual({ value: 1, consumed: [1] })
      await expect(driver.batchAllocate!("reg", "batch", "2026", true)).rejects.toThrow()
      expect(await driver.batchAllocate!("reg", "batch", "2026", false)).toEqual({ value: 2, consumed: [1, 2] })
      expect(await driver.dump()).toEqual([{ scope: "reg", name: "batch", period: "2026", value: 2 }])
    })
  }
}
