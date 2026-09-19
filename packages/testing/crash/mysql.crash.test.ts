import { afterAll, describe, expect, it } from "vitest"
import mysql from "mysql2/promise"
import { DURABLE_FAILPOINTS, isPreCommitFailpoint } from "./failpoints.js"
import { runMySqlUntilFailpoint } from "./mysqlProcessHarness.js"
import { mysqlCertificationUrl, openMySqlFixture } from "../integration/mysql/database.js"
import { writeCrashEvidence } from "../src/conformance/guaranteeEvidence.js"
const repetitions = Number.parseInt(process.env.FRAMEWORK_CRASH_REPETITIONS ?? "1", 10)
if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error("FRAMEWORK_CRASH_REPETITIONS must be a positive integer")
describe("MySQL process crash/replay", () => {
  for (const failpoint of DURABLE_FAILPOINTS) it(`recovers at ${failpoint}`, async () => {
    for (let run = 0; run < repetitions; run += 1) {
      const setup = await openMySqlFixture(); await setup.pool.end()
      await runMySqlUntilFailpoint(mysqlCertificationUrl(), failpoint, "execute")
      let db = await mysql.createConnection(mysqlCertificationUrl())
      let [rows] = await db.query("SELECT COUNT(*) n FROM records")
      if (isPreCommitFailpoint(failpoint)) expect(Number((rows as { n: number }[])[0]!.n)).toBe(0)
      await db.end()
      await runMySqlUntilFailpoint(mysqlCertificationUrl(), failpoint, "recover")
      db = await mysql.createConnection(mysqlCertificationUrl())
      const counts: number[] = []
      for (const table of ["records", "audit", "outbox", "cache_generations", "idempotency", "atomic_records", "leases", "jobs", "job_progress", "job_executions", "schedules", "workflows", "workflow_signals", "sequences", "temporal_heads", "temporal_revisions"]) { [rows] = await db.query(`SELECT COUNT(*) n FROM ${table}`); counts.push(Number((rows as { n: number }[])[0]!.n)) }
      expect(counts).toEqual([1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1])
      await db.end()
    }
  })
})
afterAll(async () => { await writeCrashEvidence("mysql", DURABLE_FAILPOINTS, repetitions) })
