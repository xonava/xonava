import { certificationContext, createSourceManifest, runNpm, verifiedScenarioEvidence, writeCertificationArtifact } from "./certificationSupport.mjs"
const { runId, directory } = certificationContext("local-n1", "n1")
runNpm(["run", "typecheck", "-w", "core"])
runNpm(["run", "test", "-w", "core", "--", "--run", "src/sequence/__tests__/sequence.test.ts"])
const testFile = "packages/core/src/sequence/__tests__/sequence.test.ts"
const sourceManifest = await createSourceManifest(["packages/core/src/sequence/types.ts", "packages/core/src/sequence/sequence.ts", "packages/core/src/sequence/index.ts", testFile, "docs/spec/sequence.md"])
const scenarios = await verifiedScenarioEvidence([
  { id: "formatting", testFile, testName: "allocates scoped values and formats without changing the stored number" },
  { id: "utc-reset", testFile, testName: "derives reset buckets in UTC" },
  { id: "provider-validation", testFile, testName: "rejects invalid provider output" },
])
await writeCertificationArtifact(directory, "sequence-numbering-conformance.json", { phase: "N1", status: "proven", runId, scenarios, sourceManifest })
console.log(`N1 certification verified: ${directory}`)
