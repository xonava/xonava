/**
 * Shared vitest bench options. Samples are collected for a fixed time slice so
 * `scripts/verification/verifyBenchmarks.mjs` can compare a stable statistic
 * (the median) with the committed baseline in `benchmarks/baseline.json`.
 */
export const BENCH_OPTIONS = { time: 500, warmupTime: 150, warmupIterations: 50, iterations: 100 } as const
