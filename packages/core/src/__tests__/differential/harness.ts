/**
 * Deterministic property/differential harness for core.
 *
 * Every run derives its own seed from a base seed and the run index, so a
 * failure is reproducible exactly: the error names `DIFFERENTIAL_SEED` and
 * `DIFFERENTIAL_RUN`. A failing case is greedily shrunk when the property
 * supplies a shrinker, and the smallest failing case is reported.
 *
 * Environment:
 * - `DIFFERENTIAL_SCALE`  multiplies every property's run count (default 1).
 * - `DIFFERENTIAL_SEED`   overrides the base seed of every property.
 * - `DIFFERENTIAL_RUN`    runs only that run index (replay one failure).
 * - `DIFFERENTIAL_REPORT_DIR` when set, every property that passes appends one
 *   JSON line (name, base seed, scale, runs) to a per-worker file in that
 *   directory. The release check uses it as evidence; unset, the
 *   harness writes nothing.
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { threadId } from "node:worker_threads"

export interface Rng {
  /** Uniform 32-bit unsigned integer. */
  next(): number
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number
  /** True with probability `probability` (default 0.5). */
  bool(probability?: number): boolean
  pick<T>(values: readonly T[]): T
  /** A random subset, keeping the input order. */
  subset<T>(values: readonly T[], probability?: number): T[]
  /** A shuffled copy. */
  shuffle<T>(values: readonly T[]): T[]
}

/** mulberry32: small, fast, and good enough for test-case generation. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (t ^ (t >>> 14)) >>> 0
  }
  const int = (maxExclusive: number): number => {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new RangeError("int() needs a positive integer bound")
    return next() % maxExclusive
  }
  return {
    next,
    int,
    bool: (probability = 0.5) => next() / 0x1_0000_0000 < probability,
    pick: (values) => {
      if (values.length === 0) throw new RangeError("pick() needs a non-empty list")
      return values[int(values.length)]!
    },
    subset: (values, probability = 0.5) => values.filter(() => next() / 0x1_0000_0000 < probability),
    shuffle: (values) => {
      const out = [...values]
      for (let index = out.length - 1; index > 0; index--) {
        const swap = int(index + 1)
        ;[out[index], out[swap]] = [out[swap]!, out[index]!]
      }
      return out
    },
  }
}

/** FNV-1a over a string, used to give every property a stable default seed. */
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function runSeed(base: number, run: number): number {
  return hashSeed(`${base >>> 0}:${run}`)
}

function envNumber(name: string): number | undefined {
  const raw = typeof process === "undefined" ? undefined : process.env[name]
  if (raw === undefined || raw === "") return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`)
  return value
}

export function scaledRuns(runs: number): number {
  const scale = envNumber("DIFFERENTIAL_SCALE") ?? 1
  return Math.max(1, Math.round(runs * scale))
}

export interface PropertyOptions<T> {
  /** Base number of generated cases (scaled by `DIFFERENTIAL_SCALE`). */
  runs?: number
  /** Base seed; defaults to a hash of the property name. */
  seed?: number
  /** Smaller variants of a failing case, tried greedily. */
  shrink?: (value: T) => Iterable<T>
  /** Human-readable form of a case for the failure report. */
  describe?: (value: T) => string
  /** Maximum shrink steps. */
  maxShrinkSteps?: number
}

function defaultDescribe(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item: unknown) => (item instanceof Date ? `Date(${item.toISOString()})` : item), 2)
  } catch {
    return String(value)
  }
}

function failureMessage(name: string, base: number, run: number, shrinkSteps: number, value: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error)
  return [
    `Property "${name}" failed (run ${run}, ${shrinkSteps} shrink step(s)).`,
    `Replay: DIFFERENTIAL_SEED=${base} DIFFERENTIAL_RUN=${run}`,
    `Case: ${value}`,
    `Reason: ${reason}`,
  ].join("\n")
}

interface Plan { name: string; base: number; baseRuns: number; scale: number; replayRun: number | undefined; runs: number[] }

function plan(name: string, options: { runs?: number; seed?: number }): Plan {
  const base = (envNumber("DIFFERENTIAL_SEED") ?? options.seed ?? hashSeed(name)) >>> 0
  const only = envNumber("DIFFERENTIAL_RUN")
  const baseRuns = options.runs ?? 200
  const count = scaledRuns(baseRuns)
  return { name, base, baseRuns, scale: envNumber("DIFFERENTIAL_SCALE") ?? 1, replayRun: only, runs: only === undefined ? Array.from({ length: count }, (_, index) => index) : [only] }
}

/**
 * Opt-in success evidence for release certification: one JSON line per
 * passing property, appended to a file owned by this worker (process and
 * thread) so concurrent workers never interleave writes. No-op when
 * `DIFFERENTIAL_REPORT_DIR` is unset.
 */
function reportSuccess(executed: Plan): void {
  const directory = typeof process === "undefined" ? undefined : process.env.DIFFERENTIAL_REPORT_DIR
  if (directory === undefined || directory === "") return
  const line = JSON.stringify({
    property: executed.name,
    seed: executed.base,
    scale: executed.scale,
    baseRuns: executed.baseRuns,
    runs: executed.runs.length,
    replayRun: executed.replayRun ?? null,
    passed: true,
    recordedAt: new Date().toISOString(),
  })
  mkdirSync(directory, { recursive: true })
  appendFileSync(join(directory, `properties-${process.pid}-${threadId}.jsonl`), `${line}\n`, "utf8")
}

/** Checks a synchronous property over generated cases; throws a replayable report on failure. */
export function forAll<T>(name: string, generate: (rng: Rng) => T, property: (value: T) => void, options: PropertyOptions<T> = {}): void {
  const executed = plan(name, options)
  const { base, runs } = executed
  const describe = options.describe ?? defaultDescribe
  const fails = (value: T): unknown => {
    try {
      property(value)
      return undefined
    } catch (error) {
      return error ?? new Error("property threw a nullish value")
    }
  }
  for (const run of runs) {
    const value = generate(createRng(runSeed(base, run)))
    let error = fails(value)
    if (error === undefined) continue
    let smallest = value
    let steps = 0
    const limit = options.maxShrinkSteps ?? 200
    if (options.shrink) {
      let improved = true
      while (improved && steps < limit) {
        improved = false
        for (const candidate of options.shrink(smallest)) {
          const candidateError = fails(candidate)
          if (candidateError !== undefined) {
            smallest = candidate
            error = candidateError
            steps++
            improved = true
            break
          }
        }
      }
    }
    throw new Error(failureMessage(name, base, run, steps, describe(smallest), error))
  }
  reportSuccess(executed)
}

/** Asynchronous variant of {@link forAll} (for real-database differentials). */
export async function forAllAsync<T>(name: string, generate: (rng: Rng) => T, property: (value: T) => Promise<void>, options: PropertyOptions<T> = {}): Promise<void> {
  const executed = plan(name, options)
  const { base, runs } = executed
  const describe = options.describe ?? defaultDescribe
  const fails = async (value: T): Promise<unknown> => {
    try {
      await property(value)
      return undefined
    } catch (error) {
      return error ?? new Error("property threw a nullish value")
    }
  }
  for (const run of runs) {
    const value = generate(createRng(runSeed(base, run)))
    let error = await fails(value)
    if (error === undefined) continue
    let smallest = value
    let steps = 0
    const limit = options.maxShrinkSteps ?? 100
    if (options.shrink) {
      let improved = true
      while (improved && steps < limit) {
        improved = false
        for (const candidate of options.shrink(smallest)) {
          const candidateError = await fails(candidate)
          if (candidateError !== undefined) {
            smallest = candidate
            error = candidateError
            steps++
            improved = true
            break
          }
        }
      }
    }
    throw new Error(failureMessage(name, base, run, steps, describe(smallest), error))
  }
  reportSuccess(executed)
}
