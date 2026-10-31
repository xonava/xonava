import { defineConfig, mergeConfig } from "vitest/config"
import base from "./vitest.config.js"
// The soak is a long-running run, never part of `npm test`: it is started explicitly with `npm run soak`.
const merged = mergeConfig(base, defineConfig({ test: { testTimeout: 4 * 60 * 60_000, hookTimeout: 10 * 60_000, fileParallelism: false } }))
// mergeConfig concatenates arrays; the soak must run only its own files.
export default defineConfig({ ...merged, test: { ...merged.test, include: ["soak/**/*.test.ts"] } })
