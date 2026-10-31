import { defineConfig } from "vitest/config"
// Release certification multiplies every differential property's case count with
// DIFFERENTIAL_SCALE, so per-test time budgets scale with it (default 1: unchanged).
const parsedScale = Number(process.env.DIFFERENTIAL_SCALE)
// XONAVA_TIMING_SCALE (default 1, 4 under --coverage) loosens every wall-clock budget and vitest timeout for slow or loaded machines.
const parsedTimingScale = Number(process.env.XONAVA_TIMING_SCALE ?? (process.argv.includes("--coverage") ? "4" : "1"))
const timingScale = Number.isFinite(parsedTimingScale) ? Math.max(1, parsedTimingScale) : 1
const timeoutScale = (Number.isFinite(parsedScale) ? Math.max(1, parsedScale) : 1) * timingScale
export default defineConfig({
  test: {
    testTimeout: Math.ceil(5_000 * timeoutScale),
    hookTimeout: Math.ceil(10_000 * timeoutScale),
    env: { XONAVA_TIMING_SCALE: String(timingScale) },
    include: ["src/**/*.test.ts"],
    // Hot-path benchmarks run through `npm run bench` (scripts/verification/verifyBenchmarks.mjs), never through `npm test`.
    benchmark: { include: ["src/**/__tests__/bench/*.bench.ts"] },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/__tests__/**",
        "src/**/*.d.ts",
      ],
      thresholds: {
        // Enforced ratchet floors for the complete core, including defensive
        // error branches. Raise these only alongside tests; never lower them.
        lines: 96,
        statements: 90,
        functions: 96,
        branches: 90,
      },
    },
  },
})
