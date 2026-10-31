/**
 * Shared helpers for tests whose outcome depends on elapsed time.
 *
 * A test that compares wall-clock time with a fixed budget fails on a loaded machine although the code is fine.
 * Two kinds of assertion exist, and they need different treatment:
 *
 * - Complexity (linear versus quadratic): use `expectNearLinear`. It compares the cost of an input with the cost
 *   of one `factor` times smaller, measured back to back in the same process, so machine speed cancels out.
 * - A real latency guarantee (a deadline that must be honoured, an operation that must not hang): keep the bound
 *   and scale it with `scaledMs`.
 *
 * `XONAVA_TIMING_SCALE` (default 1, 4 under `--coverage`, set by the vitest configs) is the multiplier for both.
 * Run the tests on a loaded machine with `XONAVA_TIMING_SCALE=4`.
 */
const parsedScale = Number(process.env.XONAVA_TIMING_SCALE ?? "1")

/** Multiplier for time budgets: at least 1, so a malformed value never tightens a test. */
export const TIMING_SCALE: number = Number.isFinite(parsedScale) ? Math.max(1, parsedScale) : 1

/** A latency budget scaled for a slow or loaded machine. */
export function scaledMs(ms: number): number {
  return Math.ceil(ms * TIMING_SCALE)
}

export interface NearLinearOptions {
  /** The large input size. The small one is `size / factor`. */
  size: number
  /** How much smaller the small input is. Linear cost grows by this factor, quadratic cost by its square. Default 4. */
  factor?: number
  /** Measurements per size; the fastest counts, because interference only ever adds time. Default 5. */
  runs?: number
  /** Timings below this are noise; the small cost is never taken as lower than it. Default 2 ms. */
  floorMs?: number
  /** Very loose absolute backstop for the large input, scaled by `XONAVA_TIMING_SCALE`. Default 5 s. */
  ceilingMs?: number
}

export interface NearLinearResult {
  smallMs: number
  largeMs: number
}

/**
 * CPU time of this process in milliseconds. Unlike the wall clock it does not run while the process waits for a CPU, so
 * a machine running other suites at the same time inflates it far less. The work measured here is CPU-bound.
 */
function cpuMs(): number {
  const { user, system } = process.cpuUsage()
  return (user + system) / 1_000
}

async function bestOf(runs: number, work: () => unknown): Promise<number> {
  let best = Number.POSITIVE_INFINITY
  for (let run = 0; run < runs; run++) {
    const started = cpuMs()
    await work()
    best = Math.min(best, cpuMs() - started)
  }
  return best
}

/**
 * Fails when the cost grows faster than linearly. Cost is the CPU time of this process, not the wall clock. `prepare(n)` builds an input of size `n` (not timed) and returns the
 * function to time. The large cost must stay below `max(small, floorMs) * factor² / 2`: twice as much as linear growth
 * needs at `factor` 4 (8 against 4), half of what quadratic growth takes (8 against 16). A very loose absolute
 * ceiling stays as a backstop for the case where both sizes are slow.
 */
export async function expectNearLinear(prepare: (size: number) => () => unknown, options: NearLinearOptions): Promise<NearLinearResult> {
  const factor = options.factor ?? 4
  const runs = options.runs ?? 5
  const floorMs = options.floorMs ?? 2
  const ceilingMs = scaledMs(options.ceilingMs ?? 5_000)
  const small = prepare(Math.max(1, Math.floor(options.size / factor)))
  const large = prepare(options.size)
  await small() // warm up: compilation and caches must not count against the small size
  const smallMs = await bestOf(runs, small)
  const largeMs = await bestOf(runs, large)
  const limit = Math.max(smallMs, floorMs) * (factor * factor) / 2
  if (largeMs > limit) throw new Error(`cost grew faster than linearly: ${(options.size / factor).toFixed(0)} units took ${smallMs.toFixed(2)} ms, ${options.size} units took ${largeMs.toFixed(2)} ms (limit ${limit.toFixed(2)} ms for ${factor}x the input)`)
  if (largeMs > ceilingMs) throw new Error(`${options.size} units took ${largeMs.toFixed(2)} ms, above the absolute ceiling of ${ceilingMs} ms`)
  return { smallMs, largeMs }
}
