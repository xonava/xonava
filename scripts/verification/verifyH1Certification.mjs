import { certificationContext, createSourceManifest, runNpm, verifiedTestScenarios, writeCertificationArtifact } from "./certificationSupport.mjs"
const { runId, directory } = certificationContext("local-h1", "h1");const run=runNpm
run(["run","typecheck"]);run(["run","lint","-w","@xonava/core"]);run(["run","test","-w","@xonava/core","--","--run","src/certification/__tests__/h1Contracts.test.ts"])
const sources=["packages/core/src/health/health.ts","packages/core/src/secrets/secrets.ts","packages/core/src/feature-flags/featureFlags.ts","packages/core/src/business-calendar/businessCalendar.ts"];const sourceManifest=await createSourceManifest(sources)
const scenarios=["liveness-separation","readiness-separation","critical-component-failure","noncritical-degradation","component-identity-validation","opaque-secret-reference","raw-secret-rejection","feature-fact-validation","feature-fact-expiry","business-calendar-port","ordered-working-windows","bounded-working-windows"]
const testPath="packages/core/src/certification/__tests__/h1Contracts.test.ts"
await writeCertificationArtifact(directory,"health-secrets-flags-calendar-conformance.json",{phase:"H1",status:"proven",runId,scenarios:await verifiedTestScenarios(scenarios,testPath),sourceManifest});console.log(`H1 certification verified: ${directory}`)
