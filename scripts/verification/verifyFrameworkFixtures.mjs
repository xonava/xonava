import { access, readFile } from "node:fs/promises"
const required = [
  "packages/testing/fixtures/postgres/migrations/0001_framework.sql",
  "packages/testing/fixtures/postgres/bootstrap.ts",
  "packages/testing/fixtures/postgres/reset.ts",
  "packages/testing/fixtures/d1/migrations/0001_framework.sql",
  "packages/testing/fixtures/d1/bootstrap.ts",
  "packages/testing/fixtures/d1/reset.ts",
  "packages/testing/fixtures/mysql/migrations/0001_framework.sql",
  "packages/testing/fixtures/mysql/bootstrap.ts",
  "packages/testing/integration/pg/repository.integration.test.ts",
  "packages/testing/integration/pg/transaction.integration.test.ts",
  "packages/testing/integration/pg/durability.integration.test.ts",
  "packages/testing/integration/d1/repository.integration.test.ts",
  "packages/testing/integration/d1/atomicBatch.integration.test.ts",
  "packages/testing/integration/d1/durability.integration.test.ts",
  "packages/testing/integration/mysql/repository.integration.test.ts",
  "packages/testing/integration/mysql/transaction.integration.test.ts",
  "packages/testing/integration/mysql/idempotency.integration.test.ts",
  "packages/testing/integration/mysql/job.integration.test.ts",
  "packages/testing/integration/mysql/schedule.integration.test.ts",
  "packages/testing/integration/mysql/workflow.integration.test.ts",
  "packages/testing/crash/pgWorkerEntry.mjs",
  "packages/testing/crash/d1WorkerEntry.mjs",
  "packages/testing/crash/mysqlWorkerEntry.mjs",
  "packages/testing/crash/processHarness.ts",
  "packages/testing/crash/failpoints.ts",
  "packages/testing/crash/oracle.ts",
  "packages/testing/conformance/guarantees/pg.conformance.test.ts",
  "packages/testing/conformance/guarantees/d1.conformance.test.ts",
  "packages/testing/conformance/guarantees/mysql.conformance.test.ts",
]
for (const path of required) {
  await access(new URL(`../../${path}`, import.meta.url))
  const source = await readFile(new URL(`../../${path}`, import.meta.url), "utf8")
  if (/apps\/|clinic/i.test(source)) throw new Error(`consumer import detected in ${path}`)
}
const rootPackage = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"))
const commands = ["test:framework:integration:pg", "test:framework:integration:d1", "test:framework:integration:mysql", "test:framework:conformance:pg", "test:framework:conformance:d1", "test:framework:conformance:mysql", "test:framework:race:pg", "test:framework:race:d1", "test:framework:race:mysql", "test:framework:crash:pg", "test:framework:crash:d1", "test:framework:crash:mysql"]
for (const command of commands) {
  const script = rootPackage.scripts?.[command]
  if (typeof script !== "string" || !script.includes("testing")) throw new Error(`missing independent framework command: ${command}`)
  if (/clinic|apps\//i.test(script)) throw new Error(`consumer dependency in command: ${command}`)
}
console.log("Framework-owned PostgreSQL, D1 and MySQL fixtures verified")
