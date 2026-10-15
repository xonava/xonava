import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { verifiedScenarioEvidence } from "./certificationSupport.mjs"

const runId = process.env.FRAMEWORK_CONFORMANCE_RUN_ID ?? "local-w1"
const directory = resolve("artifacts/framework-conformance", runId, "w1")
const run = args => execFileSync("npm", args, { cwd: process.cwd(), stdio: "inherit", env: process.env, shell: process.platform === "win32" })
if (!process.env.FRAMEWORK_TEST_PG_URL && !process.env.DATABASE_URL) throw new Error("W1 certification requires a real PostgreSQL URL")
run(["run","typecheck"])
run(["run","test","-w","@xonava/core","--","--run","src/workflow/__tests__/workflow.test.ts"])
run(["run","test","-w","@xonava/testing","--","--config","vitest.integration.config.ts","integration/pg/w1.integration.test.ts"])
run(["run","test","-w","@xonava/testing","--","--config","vitest.integration.config.ts","integration/d1/w1.integration.test.ts"])
const sources=["packages/core/src/workflow/types.ts","packages/core/src/workflow/workflowDefinition.ts","packages/core/src/workflow/workflowRegistry.ts","packages/core/src/workflow/workflowStateMachine.ts","packages/core/src/workflow/workflowContext.ts","packages/core/src/workflow/workflowDispatcher.ts","packages/core/src/workflow/store.ts","packages/adapters/src/drizzle-pg/drizzleWorkflowStore.ts","packages/adapters/src/drizzle-d1/drizzleWorkflowStore.ts","packages/testing/integration/pg/w1.integration.test.ts","packages/testing/integration/d1/w1.integration.test.ts"]
const sourceManifest=await Promise.all(sources.map(async path=>({path,sha256:createHash("sha256").update(await readFile(resolve(path))).digest("hex")})))
const scenarios=["crash-between-step-and-next-claim","duplicate-signal","retry","compensation","stale-worker-fence","workflow-version-migration","cancellation-while-waiting","durable-timer","bounded-durable-variables","multi-datasource-step-sequencing","postgres-atomic-transition","d1-atomic-transition"]
const core="packages/core/src/workflow/__tests__/workflow.test.ts",pg="packages/testing/integration/pg/w1.integration.test.ts",d1="packages/testing/integration/d1/w1.integration.test.ts"
const evidence=await verifiedScenarioEvidence([
  {id:scenarios[0],testFile:core,testName:"recovers after a crash by retaining the durable pending transition"},{id:scenarios[1],testFile:pg,testName:"fences transitions and deduplicates signals"},{id:scenarios[2],testFile:core,testName:"supports retries and durable timers"},{id:scenarios[3],testFile:core,testName:"runs compensation to a terminal failed outcome"},{id:scenarios[4],testFile:core,testName:"does not execute a workflow step after its lease is lost"},{id:scenarios[5],testFile:core,testName:"upcasts old workflow variables deterministically"},{id:scenarios[6],testFile:core,testName:"cancels waiting workflows and enters compensation when required"},{id:scenarios[7],testFile:core,testName:"supports retries and durable timers"},{id:scenarios[8],testFile:core,testName:"bounds durable workflow variables"},{id:scenarios[9],testFile:core,testName:"sequences multiple datasources as distinct steps"},{id:scenarios[10],testFile:pg,testName:"fences transitions and deduplicates signals"},{id:scenarios[11],testFile:d1,testName:"fences transitions and deduplicates signals"},
])
await mkdir(directory,{recursive:true})
await writeFile(resolve(directory,"workflow-conformance.json"),`${JSON.stringify({phase:"W1",status:"proven",runId,adapterScope:"Real PostgreSQL transactions and Miniflare D1 atomic statements/batches",scenarios:evidence,sourceManifest},null,2)}\n`)
console.log(`W1 certification verified: ${directory}`)
