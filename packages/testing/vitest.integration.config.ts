import { defineConfig, mergeConfig } from "vitest/config"
import base, { timingScale } from "./vitest.config.js"
const certificationTimeout = (Number(process.env.FRAMEWORK_CRASH_REPETITIONS ?? "1") >= 20 ? 180_000 : 30_000) * timingScale

export default mergeConfig(base, defineConfig({ test: { include: ["integration/**/*.test.ts", "conformance/guarantees/**/*.test.ts", "crash/**/*.test.ts"], testTimeout: certificationTimeout, hookTimeout: certificationTimeout, fileParallelism: false } }))
