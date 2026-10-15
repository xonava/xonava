import { certificationContext, createSourceManifest, runNpm, verifiedScenarioEvidence, writeCertificationArtifact } from "./certificationSupport.mjs"
const { runId, directory } = certificationContext("local-th1", "th1")
runNpm(["run", "typecheck", "-w", "@xonava/core"])
runNpm(["run", "test", "-w", "@xonava/core", "--", "--run", "src/temporal/__tests__/temporal.test.ts"])
const testFile = "packages/core/src/temporal/__tests__/temporal.test.ts"
const sourceManifest = await createSourceManifest(["packages/core/src/temporal/types.ts", "packages/core/src/temporal/temporal.ts", "packages/core/src/temporal/index.ts", testFile, "docs/spec/temporal.md"])
const scenarios = await verifiedScenarioEvidence([
  { id: "as-of", testFile, testName: "reconstructs state at exact historical instants" },
  { id: "snapshot", testFile, testName: "starts from a snapshot and replays only later revisions" },
  { id: "lifecycle", testFile, testName: "represents deletion and restoration explicitly" },
  { id: "contiguity", testFile, testName: "rejects gaps, foreign resources, future records, and empty continuing pages" },
  { id: "bounded-replay", testFile, testName: "bounds replay across pages" },
])
await writeCertificationArtifact(directory, "temporal-history-conformance.json", { phase: "TH1", status: "proven", runId, scenarios, sourceManifest })
console.log(`TH1 certification verified: ${directory}`)
