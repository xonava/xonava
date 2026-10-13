import {execFileSync} from "node:child_process"
import {createHash} from "node:crypto"
import {mkdir,readFile,writeFile} from "node:fs/promises"
import {resolve} from "node:path"

const runId=process.env.FRAMEWORK_CONFORMANCE_RUN_ID??"local-mysql1"
const directory=resolve("artifacts/framework-conformance",runId,"mysql1")
if(!process.env.FRAMEWORK_TEST_MYSQL_URL)throw new Error("MYSQL1 certification requires FRAMEWORK_TEST_MYSQL_URL")
const env={...process.env,FRAMEWORK_CONFORMANCE_RUN_ID:runId,FRAMEWORK_CONFORMANCE_PHASE:"mysql1",FRAMEWORK_CRASH_REPETITIONS:"20"}
const run=args=>execFileSync("npm",args,{cwd:process.cwd(),stdio:"inherit",env,shell:process.platform==="win32"})
run(["run","typecheck"])
run(["run","test:framework:integration:mysql"])
run(["run","test:framework:conformance:mysql"])
run(["run","test:framework:race:mysql"])
run(["run","test:framework:crash:mysql"])

const guarantees=JSON.parse(await readFile(resolve(directory,"mysql-guarantees.json"),"utf8"))
const crash=JSON.parse(await readFile(resolve(directory,"mysql-crash-replay.json"),"utf8"))
if(!Array.isArray(guarantees.records)||guarantees.records.length<13||guarantees.records.some(record=>record.status!=="proven"))throw new Error("MYSQL1 guarantee evidence is incomplete")
if(crash.status!=="proven"||crash.repetitions<20||crash.processIsolation!==true||crash.freshVerifier!==true||crash.failpoints?.some(entry=>entry.status!=="proven"||entry.partialCommitViolations!==0))throw new Error("MYSQL1 crash/replay evidence is incomplete")
const sources=[
 "packages/adapters/src/drizzle-mysql/drizzleRepository.ts","packages/adapters/src/drizzle-mysql/drizzlePersistenceProvider.ts","packages/adapters/src/drizzle-mysql/drizzleIdempotencyStore.ts","packages/adapters/src/drizzle-mysql/drizzleAuditSink.ts","packages/adapters/src/drizzle-mysql/drizzleOutboxSink.ts","packages/adapters/src/drizzle-mysql/mysqlAtomicBackends.ts","packages/adapters/src/drizzle-mysql/mysqlTagGenerationStore.ts","packages/adapters/src/drizzle-mysql/drizzleJobStore.ts","packages/adapters/src/drizzle-mysql/drizzleJobProgressStore.ts","packages/adapters/src/drizzle-mysql/drizzleScheduleStore.ts","packages/adapters/src/drizzle-mysql/drizzleWorkflowStore.ts","packages/testing/fixtures/mysql/migrations/0001_framework.sql","packages/testing/fixtures/mysql/migrations/0002_workflow_signal_buffering.sql","packages/testing/fixtures/mysql/migrations/0003_schedule_next_run_nullable.sql","packages/testing/fixtures/mysql/migrations/0004_job_partition_head_index.sql","packages/testing/conformance/guarantees/mysql.conformance.test.ts","packages/testing/crash/mysql.crash.test.ts","packages/testing/crash/mysqlWorkerEntry.mjs"
]
const sourceManifest=await Promise.all(sources.map(async path=>({path,sha256:createHash("sha256").update(await readFile(resolve(path))).digest("hex")})))
const scenarios=["tenant-scoped-repository","conditional-occ","interactive-rollback","durable-idempotency","atomic-audit","idempotent-outbox","atomic-cache-generation","fenced-inbox","fenced-outbox-delivery","fenced-lease","fenced-job-progress","partition-serialized-jobs","fenced-schedules","fenced-workflows","process-crash-replay"]
await mkdir(directory,{recursive:true})
await writeFile(resolve(directory,"mysql1-conformance.json"),`${JSON.stringify({schema:"framework.mysql1-certification",schemaVersion:1,phase:"MYSQL1",status:"proven",runId,database:"MySQL 8.0",crashRepetitions:20,scenarios:scenarios.map(id=>({id,status:"passed"})),sourceManifest},null,2)}\n`)
console.log(`MYSQL1 certification verified: ${directory}`)
