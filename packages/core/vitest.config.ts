import { defineConfig } from "vitest/config"
// Release certification multiplies every differential property's case count with
// DIFFERENTIAL_SCALE, so per-test time budgets scale with it (default 1: unchanged).
const parsedScale = Number(process.env.DIFFERENTIAL_SCALE)
const timeoutScale = Number.isFinite(parsedScale) ? Math.max(1, parsedScale) : 1
export default defineConfig({
  test: {
    testTimeout: Math.ceil(5_000 * timeoutScale),
    hookTimeout: Math.ceil(10_000 * timeoutScale),
    include: ["src/**/*.test.ts"],
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
        lines: 94,
        statements: 90,
        functions: 96,
        branches: 86,
      },
    },
  },
})
