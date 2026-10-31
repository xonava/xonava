import { test, type BenchCompareOptions } from "vitest"

/**
 * Shared vitest bench options. Samples are collected for a fixed time slice so
 * `scripts/verification/verifyBenchmarks.mjs` can compare a stable statistic
 * (the median) with the committed baseline in `benchmarks/baseline.json`.
 */
export const BENCH_OPTIONS = { time: 500, warmupTime: 150, warmupIterations: 50, iterations: 100 } as const

/**
 * Registers one benchmark. Vitest 5 runs a benchmark from inside a test through the `bench` fixture, so each benchmark is a
 * test of the same name whose single benchmark is measured with the given run options.
 */
export function bench(name: string, fn: () => unknown, options: BenchCompareOptions = BENCH_OPTIONS): void {
  test(name, { timeout: 60_000 }, async ({ bench: registerBench }) => { await registerBench(name, fn).run(options) })
}
