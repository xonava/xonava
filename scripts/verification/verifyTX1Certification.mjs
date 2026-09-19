import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const runId = process.env.FRAMEWORK_CONFORMANCE_RUN_ID ?? "local-tx1"
const directory = resolve("artifacts/framework-conformance", runId, "tx1")
const run = args => execFileSync("npm", args, { cwd: process.cwd(), stdio: "inherit", env: process.env, shell: process.platform === "win32" })

run(["run", "typecheck"])
run(["run", "test", "-w", "core", "--", "--run", "src/certification/__tests__/tx1Contracts.test.ts", "src/bootstrap/__tests__/runtimeCapabilities.test.ts"])
run(["run", "test", "-w", "adapters", "--", "--run", "src/drizzle-pg/__tests__/drizzlePersistenceProvider.test.ts", "src/drizzle-d1/__tests__/drizzlePersistenceProvider.test.ts"])

const sources = [
  "packages/core/src/persistence/capabilities.ts",
  "packages/core/src/persistence/provider.ts",
  "packages/core/src/persistence/bulk.ts",
  "packages/core/src/persistence/streaming.ts",
  "packages/adapters/src/drizzle-pg/drizzlePersistenceProvider.ts",
  "packages/adapters/src/drizzle-d1/drizzlePersistenceProvider.ts",
]
const sourceManifest = await Promise.all(sources.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(resolve(path))).digest("hex") })))
await mkdir(directory, { recursive: true })
await writeFile(resolve(directory, "persistence-capabilities-conformance.json"), `${JSON.stringify({
  phase: "TX1",
  status: "proven",
  runId,
  claims: {
    pg: {
      "transaction.interactive": "proven",
      "transaction.atomicBatch": "unsupported",
      "locking.pessimistic": "unsupported",
      "bulk.versioned.atomic": "unsupported",
      "bulk.versioned.partial": "unsupported",
      "read.streaming": "unsupported",
      "read.boundedPagedScan": "proven",
    },
    d1: {
      "transaction.interactive": "unsupported",
      "transaction.atomicBatch": "proven",
      "locking.pessimistic": "unsupported",
      "bulk.versioned.atomic": "unsupported",
      "bulk.versioned.partial": "unsupported",
      "read.streaming": "unsupported",
      "read.boundedPagedScan": "proven",
    },
  },
  assertions: [
    "production-requires-proven-status-and-evidence",
    "experimental-never-satisfies-production",
    "interactive-transaction-is-provider-interface",
    "pessimistic-locking-is-explicit-and-never-emulated",
    "versioned-bulk-items-require-expected-version",
    "bulk-atomic-and-partial-modes-are-explicit",
    "streaming-requires-positive-batch-cancellation-and-deadline",
    "adapters-do-not-claim-unimplemented-lock-bulk-or-streaming",
  ],
  migration: { state: "not-required", rollback: "remove additive optional contracts before API freeze" },
  durability: "N/A — TX1 adds no durable format",
  sourceManifest,
}, null, 2)}\n`)
console.log(`TX1 certification verified: ${directory}`)
