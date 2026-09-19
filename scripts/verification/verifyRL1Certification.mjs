import { certificationContext, createSourceManifest, runNpm, verifiedScenarioEvidence, writeCertificationArtifact } from "./certificationSupport.mjs"

const { runId, directory } = certificationContext("local-rl1", "rl1")
runNpm(["run", "typecheck", "-w", "core"])
runNpm(["run", "lint", "-w", "core"])
runNpm(["run", "test", "-w", "core", "--", "--run", "src/rules/__tests__/ruleEngine.test.ts", "src/certification/__tests__/rl1Contracts.test.ts"])

const testFile = "packages/core/src/rules/__tests__/ruleEngine.test.ts"
const certificationFile = "packages/core/src/certification/__tests__/rl1Contracts.test.ts"
const scenarios = await verifiedScenarioEvidence([
  { id: "predicate-evaluation", testFile, testName: "evaluates matching predicates and returns declarative actions" },
  { id: "effective-window", testFile, testName: "uses inclusive starts and exclusive ends" },
  { id: "rule-version-selection", testFile, testName: "selects the highest active version of each rule key" },
  { id: "deterministic-order", testFile, testName: "orders all matches deterministically by priority then key" },
  { id: "global-conflict", testFile, testName: "selects one global highest-priority match" },
  { id: "grouped-conflict", testFile, testName: "resolves independently per conflict key and leaves ungrouped rules independent" },
  { id: "ambiguous-tie", testFile, testName: "fails closed on an ambiguous configured priority tie" },
  { id: "defensive-snapshot", testFile, testName: "defensively snapshots definitions, actions, facts, dates, and results" },
  { id: "data-only-boundary", testFile, testName: "rejects executable/accessor-backed or oversized data" },
  { id: "determinism", testFile: certificationFile, testName: "is deterministic for the same compiled definition, facts, and trusted time" },
  { id: "effect-separation", testFile: certificationFile, testName: "separates decisions from effect execution" },
])
const sourceManifest = await createSourceManifest([
  "packages/core/src/rules/types.ts",
  "packages/core/src/rules/snapshot.ts",
  "packages/core/src/rules/ruleEngine.ts",
  "packages/core/src/rules/index.ts",
  testFile,
  certificationFile,
  "docs/spec/rules.md",
])
await writeCertificationArtifact(directory, "business-rules-conformance.json", { phase: "RL1", status: "proven", runId, scenarios, sourceManifest })
console.log(`RL1 certification verified: ${directory}`)
