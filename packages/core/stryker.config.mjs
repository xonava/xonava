// Mutation testing for @xonava/core (Q5). Gate: core >= 80 % (TODO quality table).
//
// `npm run test:mutation -w @xonava/core` mutates the whole package and is the enforcing command: it exits
// non-zero when the score falls below thresholds.break. Until the per-module work packages land the
// package is below the gate, so it is expected to fail; it is deliberately not part of `npm test` or any verify script.
//
// Run one module alone. The break threshold still applies; set XONAVA_MUTATION_BREAK=0 to only measure:
//   XONAVA_MUTATION_BREAK=0 npm run test:mutation -w @xonava/core -- --mutate "src/<module>/**/*.ts,!src/**/__tests__/**"
// The incremental file (.stryker-tmp/incremental.json) is gitignored; reuse it to re-run only changed mutants.
// Mutation runs execute tests in parallel workers on a busy machine; loosen the wall-clock budgets of timing-sensitive
// tests (see vitest.config.ts) so that a slow dry run is not mistaken for a failing suite.
process.env.XONAVA_TIMING_SCALE ??= "4"
// Marks a mutation run: Stryker worker processes inherit it, so heavy tests (e.g. 60 000-iteration loops, 200 kB timing checks) can shrink under instrumentation.
process.env.XONAVA_MUTATION_RUN = "1"

// Gate from the quality table; XONAVA_MUTATION_BREAK overrides it for baseline measurements.
const gate = Number(process.env.XONAVA_MUTATION_BREAK ?? "80")

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  vitest: { configFile: "vitest.config.ts" },
  mutate: ["src/**/*.ts", "!src/**/*.test.ts", "!src/**/__tests__/**", "!src/**/*.d.ts"],
  coverageAnalysis: "perTest",
  incremental: true,
  incrementalFile: ".stryker-tmp/incremental.json",
  // Mutate in place: a sandbox copy would break the tsconfig.base.json and cross-package paths of the monorepo.
  // Stryker restores the originals afterwards; if a run is killed, `git checkout -- src` undoes any leftover mutation.
  inPlace: true,
  tempDirName: ".stryker-tmp/sandbox",
  cleanTempDir: true,
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: ".stryker-tmp/reports/mutation.json" },
  thresholds: { high: 90, low: Math.max(gate, 70), break: gate },
  timeoutMS: 10000,
  timeoutFactor: 2,
  concurrency: 4,
  ignoreStatic: true,
}
