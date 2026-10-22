import { defineConfig, mergeConfig } from "vitest/config"
import type { Plugin } from "vite"
import base, { timingScale } from "./vitest.config.js"
const certificationTimeout = (Number(process.env.FRAMEWORK_CRASH_REPETITIONS ?? "1") >= 20 ? 180_000 : 30_000) * timingScale

// The N-1 upgrade suite (integration/upgrade) loads the previous published release through the npm aliases
// `xonava-core-prev` / `xonava-adapters-prev`. The previous adapters import "@xonava/core", which would resolve to the
// workspace (current) core, so inside those two packages the specifier is rewritten to the previous core: the old
// stack really is the old stack, never old adapters on new core.
const PREVIOUS_RELEASE_FILE = /[\\/]node_modules[\\/]xonava-(?:core|adapters)-prev[\\/].*\.js$/
const previousRelease: Plugin = {
  name: "xonava-previous-release",
  enforce: "pre",
  transform(code, id) {
    if (!PREVIOUS_RELEASE_FILE.test(id.split("?")[0]!)) return null
    return { code: code.replace(/(["'])@xonava\/core(\/[^"']*)?\1/g, (_match, quote: string, subpath: string | undefined) => `${quote}xonava-core-prev${subpath ?? ""}${quote}`), map: null }
  },
}

export default mergeConfig(base, defineConfig({ plugins: [previousRelease], test: { server: { deps: { inline: [/xonava-(?:core|adapters)-prev/] } }, include: ["integration/**/*.test.ts", "conformance/guarantees/**/*.test.ts", "crash/**/*.test.ts"], testTimeout: certificationTimeout, hookTimeout: certificationTimeout, fileParallelism: false } }))
