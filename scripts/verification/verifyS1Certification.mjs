import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
const runId = process.env.FRAMEWORK_CONFORMANCE_RUN_ID ?? "local-s1"
const directory = resolve("artifacts/framework-conformance", runId, "s1")
const run = args => execFileSync("npm", args, { cwd: process.cwd(), stdio: "inherit", env: process.env, shell: process.platform === "win32" })
run(["run", "typecheck"])
run(["run", "test", "-w", "core", "--", "--run", "src/security", "src/operation/__tests__/authorizationPlanEnforcement.test.ts", "src/domain/__tests__/authority.test.ts", "src/domain/__tests__/frameworkAuthorization.test.ts", "src/domain/__tests__/abacAuthorizer.test.ts", "src/domain/__tests__/abacNormalization.test.ts"])
run(["run", "test", "-w", "adapters", "--", "--run", "src/http/crudHandlers/__tests__/authorizationTrustBoundary.test.ts", "src/http/crudHandlers/__tests__/fieldVisibilityAdversarial.test.ts", "src/http/crudHandlers/__tests__/updateToctou.test.ts"])
const sources = ["packages/core/src/security/authorizedExecutionPlan.ts", "packages/core/src/operation/authorizationPlanEnforcement.ts", "packages/core/src/operation/standardOperationPipeline.ts", "packages/core/src/operation/atomicBatchOperationPipeline.ts", "packages/core/src/domain/frameworkAuthorization.ts", "packages/core/src/security/authorizationFacts.ts", "packages/core/src/domain/authority.ts", "packages/core/src/query/projection.ts"]
const sourceManifest = await Promise.all(sources.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(resolve(path))).digest("hex") })))
await mkdir(directory, { recursive: true })
await writeFile(resolve(directory, "authorization-conformance.json"), `${JSON.stringify({ phase: "S1", status: "proven", runId, scenarios: ["all-execution-scopes", "host-facts-not-decisions", "fail-closed-operation-decision", "execution-plan-pipeline-enforcement", "mandatory-row-predicate", "readable-writable-field-intersection", "audit-obligation", "step-up-mfa", "step-up-recent-authentication", "mask-redact-partial-hash", "relationship-fact-revalidation", "fact-change-race", "impersonation-no-bypass", "nested-operation-authorization", "read-model-scope", "public-write-misconfiguration", "delegation-empty-resource-denial", "redacted-privileged-trace"].map(id => ({ id, status: "passed" })), durability: "N/A — S1 adds no durable format", migration: { state: "not-required" }, sourceManifest }, null, 2)}\n`)
console.log(`S1 certification verified: ${directory}`)
