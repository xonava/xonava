import { execFileSync } from "node:child_process"
import { access } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

function fail(message) {
  throw new Error(`Release certification refused: ${message}`)
}

for (const name of ["FRAMEWORK_TEST_PG_URL", "FRAMEWORK_TEST_MYSQL_URL"]) {
  if (!process.env[name]?.trim()) fail(`${name} is required`)
}

const generatedRunId = `release-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`
const runId = process.env.FRAMEWORK_CONFORMANCE_RUN_ID?.trim() || generatedRunId
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) fail("FRAMEWORK_CONFORMANCE_RUN_ID contains unsafe path characters")
const runDirectory = resolve("artifacts/framework-conformance", runId)
try {
  await access(runDirectory)
  fail(`run directory already exists: ${runDirectory}`)
} catch (error) {
  if (error.message.startsWith("Release certification refused:")) throw error
  if (error.code !== "ENOENT") throw error
}
const verifierPath = fileURLToPath(new URL("./verifyFinalCertification.mjs", import.meta.url))
const sourceDigest = execFileSync(process.execPath, [verifierPath, "--source-digest"], { cwd: process.cwd(), encoding: "utf8" }).trim()
const env = {
  ...process.env,
  FRAMEWORK_CONFORMANCE_RUN_ID: runId,
  FRAMEWORK_CONFORMANCE_PHASE: "release",
  FRAMEWORK_CERTIFICATION_STARTED_AT: new Date().toISOString(),
  FRAMEWORK_CERTIFICATION_SOURCE_DIGEST: sourceDigest,
}

function npm(args, additions = {}) {
  execFileSync("npm", args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...env, ...additions },
    shell: process.platform === "win32",
  })
}

console.log(`Starting fresh framework release certification run ${runId}`)
npm(["run", "verify:framework-release:baseline"])
for (const adapter of ["pg", "mysql", "d1"]) npm(["run", `test:framework:crash:${adapter}`], { FRAMEWORK_CRASH_REPETITIONS: "20" })
npm(["run", "verify:framework:cert"])
console.log(`Framework release certification completed for run ${runId}`)
