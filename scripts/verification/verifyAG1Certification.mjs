import { certificationContext, createSourceManifest, runNpm, verifiedScenarioEvidence, writeCertificationArtifact } from "./certificationSupport.mjs"
const { runId, directory } = certificationContext("local-ag1", "ag1")
runNpm(["run", "typecheck", "-w", "@xonava/core"])
runNpm(["run", "lint", "-w", "@xonava/core"])
runNpm(["run", "test", "-w", "@xonava/core", "--", "--run", "src/aggregate/__tests__/aggregate.test.ts"])
const testFile = "packages/core/src/aggregate/__tests__/aggregate.test.ts"
const scenarios = await verifiedScenarioEvidence([
  { id: "compiled-boundary", testFile, testName: "compiles an immutable named boundary" },
  { id: "atomic-transition", testFile, testName: "validates both sides of an atomic-batch transition" },
  { id: "precommit-refusal", testFile, testName: "rejects an invalid proposed transition before commit" },
  { id: "transaction-scope", testFile, testName: "runs both loads and mutation inside the same serializable transaction" },
  { id: "rollback", testFile, testName: "throws inside the transaction so the provider can roll back" },
  { id: "phase-specific", testFile, testName: "supports phase-specific invariants" },
  { id: "exact-membership", testFile, testName: "requires exact declared snapshot membership" },
  { id: "capability-refusal", testFile, testName: "rejects uncompiled definitions and providers without transactions" },
  { id: "exception-normalization", testFile, testName: "normalizes invariant exceptions as configuration failures" },
])
const sourceManifest = await createSourceManifest(["packages/core/src/aggregate/types.ts", "packages/core/src/aggregate/aggregate.ts", "packages/core/src/aggregate/index.ts", testFile, "docs/spec/aggregate.md"])
await writeCertificationArtifact(directory, "aggregate-consistency-conformance.json", { phase: "AG1", status: "proven", runId, scenarios, sourceManifest })
console.log(`AG1 certification verified: ${directory}`)
