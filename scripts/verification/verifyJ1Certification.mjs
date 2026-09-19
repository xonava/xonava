import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const runId = process.env.FRAMEWORK_CONFORMANCE_RUN_ID ?? "local-j1"
const directory = resolve("artifacts/framework-conformance", runId, "j1")
const run = args => execFileSync("npm", args, { cwd: process.cwd(), stdio: "inherit", env: process.env, shell: process.platform === "win32" })

if (!process.env.FRAMEWORK_TEST_PG_URL && !process.env.DATABASE_URL) throw new Error("J1 certification requires a real PostgreSQL URL")
run(["run", "typecheck"])
run(["run", "test", "-w", "core", "--", "--run", "src/execution/__tests__/jobRegistry.test.ts", "src/execution/__tests__/j1Contracts.test.ts", "src/execution/__tests__/dispatcher.test.ts", "src/execution/__tests__/scheduleDispatcher.test.ts"])
// Keep the real runtimes in separate Vitest processes. On Windows, workerd can
// abort during concurrent PostgreSQL/native runtime startup even though each
// adapter is healthy in isolation.
run(["run", "test", "-w", "testing", "--", "--config", "vitest.integration.config.ts", "integration/pg/j1.integration.test.ts"])
run(["run", "test", "-w", "testing", "--", "--config", "vitest.integration.config.ts", "integration/d1/j1.integration.test.ts"])

const sources = [
  "packages/core/src/execution/types.ts",
  "packages/core/src/execution/executionContext.ts",
  "packages/core/src/execution/jobRegistry.ts",
  "packages/core/src/execution/jobProgress.ts",
  "packages/core/src/execution/scheduleLifecycle.ts",
  "packages/core/src/execution/scheduleDispatcher.ts",
  "packages/adapters/src/drizzle-pg/drizzleJobProgressStore.ts",
  "packages/adapters/src/drizzle-d1/drizzleJobProgressStore.ts",
  "packages/adapters/src/drizzle-pg/drizzleScheduleStore.ts",
  "packages/adapters/src/drizzle-d1/drizzleScheduleStore.ts",
  "packages/testing/integration/pg/j1.integration.test.ts",
  "packages/testing/integration/d1/j1.integration.test.ts",
]
const sourceManifest = await Promise.all(sources.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(resolve(path))).digest("hex") })))
const scenarios = ["canonical-execution-scope", "noncanonical-scope-consistency-rejection", "payload-upcast", "missing-upcaster-dead-letter-error", "checkpoint-size-bound", "progress-fencing", "progress-optimistic-sequence-contract", "postgres-progress-atomic-write", "d1-progress-atomic-write", "stale-claim-checkpoint-rejection", "schedule-pause", "schedule-effective-window", "finite-occurrence", "calendar-exclusion", "job-dispatch-regression", "schedule-dispatch-regression"]
await mkdir(directory, { recursive: true })
await writeFile(resolve(directory, "job-scheduler-conformance.json"), `${JSON.stringify({ phase: "J1", status: "proven", runId, adapterScope: "Concrete PostgreSQL and Miniflare D1 progress/checkpoint stores verified against live fixtures", scenarios: scenarios.map(id => ({ id, status: "passed" })), sourceManifest }, null, 2)}\n`)
console.log(`J1 certification verified: ${directory}`)
