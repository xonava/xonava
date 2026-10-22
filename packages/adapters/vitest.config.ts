import { defineConfig } from "vitest/config"
import path from "path"

const parsedTimingScale = Number(process.env.XONAVA_TIMING_SCALE ?? (process.argv.includes("--coverage") ? "4" : "1"))
const timingScale = Number.isFinite(parsedTimingScale) ? Math.max(1, parsedTimingScale) : 1
export default defineConfig({
  resolve: {
    alias: {
      "@xonava/adapters/drizzle-d1": path.resolve(import.meta.dirname, "src/drizzle-d1/index.ts"),
      "@xonava/adapters/drizzle-pg": path.resolve(import.meta.dirname, "src/drizzle-pg/index.ts"),
      "@xonava/testing": path.resolve(import.meta.dirname, "../testing/src/index.ts"),
      "@xonava/core": path.resolve(import.meta.dirname, "../core/src"),
      "@xonava/core/domain": path.resolve(import.meta.dirname, "../core/src/domain"),
      "@xonava/core/entity": path.resolve(import.meta.dirname, "../core/src/entity"),
      "@xonava/core/execution": path.resolve(import.meta.dirname, "../core/src/execution"),
      "@xonava/core/events": path.resolve(import.meta.dirname, "../core/src/events"),
      "@xonava/core/operation": path.resolve(import.meta.dirname, "../core/src/operation"),
      "@xonava/core/persistence": path.resolve(import.meta.dirname, "../core/src/persistence"),
      "@xonava/core/query": path.resolve(import.meta.dirname, "../core/src/query"),
      "@xonava/core/cache": path.resolve(import.meta.dirname, "../core/src/cache"),
      "@xonava/core/rate-limit": path.resolve(import.meta.dirname, "../core/src/rate-limit"),
      "@xonava/core/telemetry": path.resolve(import.meta.dirname, "../core/src/telemetry"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    // Hot-path benchmarks run through `npm run bench` (scripts/verification/verifyBenchmarks.mjs), never through `npm test`.
    benchmark: { include: ["src/**/__tests__/bench/*.bench.ts"] },
    env: {
      XONAVA_TIMING_SCALE: String(timingScale),
    },
    ...(timingScale > 1 ? { testTimeout: 5_000 * timingScale, hookTimeout: 10_000 * timingScale } : {}),
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
        // Enforced ratchet floors for the adapters package, measured when they were
        // introduced. Raise these only alongside tests; never lower them.
        lines: 76,
        statements: 67,
        functions: 70,
        branches: 61,
      },
    },
  },
})
