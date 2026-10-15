import { certificationContext, createSourceManifest, runNpm, verifiedScenarioEvidence, writeCertificationArtifact } from "./certificationSupport.mjs"
const { runId, directory } = certificationContext("local-ht1", "ht1")
runNpm(["run", "typecheck", "-w", "@xonava/adapters"])
runNpm(["run", "lint", "-w", "@xonava/adapters"])
runNpm(["run", "test", "-w", "@xonava/adapters", "--", "--run", "src/http/__tests__/frameworkAdapters.test.ts", "src/http/__tests__/nodeTransport.test.ts"])
const framework = "packages/adapters/src/http/__tests__/frameworkAdapters.test.ts", transport = "packages/adapters/src/http/__tests__/nodeTransport.test.ts"
const scenarios = await verifiedScenarioEvidence([
  { id: "idempotent-replay", testFile: framework, testName: "replays an actual idempotent framework write without executing it" },
  { id: "crud-occ", testFile: framework, testName: "executes compiled CRUD create/list/detail/update/delete with tenant scope and OCC" },
  { id: "disconnect-abort", testFile: transport, testName: "aborts the Fetch signal when the client disconnects during a handler" },
  { id: "stream-cancel", testFile: transport, testName: "cancels the Fetch response stream after the client disconnects" },
  { id: "chunked-limit", testFile: transport, testName: "enforces body limits for chunked requests without Content-Length" },
])
const sourceManifest = await createSourceManifest(["packages/adapters/src/http/frameworkAdapter.ts", "packages/adapters/src/http/nodeAdapter.ts", "packages/adapters/src/fastify/index.ts", "packages/adapters/src/hono/index.ts", "packages/adapters/src/express/index.ts", framework, transport, "docs/typescript/http-adapters.md"])
await writeCertificationArtifact(directory, "http-adapters-conformance.json", { phase: "HT1", status: "proven", runId, scenarios, sourceManifest })
console.log(`HT1 certification verified: ${directory}`)
