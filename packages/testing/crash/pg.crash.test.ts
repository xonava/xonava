import { afterAll, describe, expect, it } from "vitest"
import { DURABLE_FAILPOINTS, isPreCommitFailpoint } from "./failpoints.js"
import { runPgUntilFailpoint } from "./pgProcessHarness.js"
import { connectPg, openPgFixture, pgCertificationUrl } from "../integration/pg/database.js"
import { writeCrashEvidence } from "../src/conformance/guaranteeEvidence.js"
const repetitions = Number.parseInt(process.env.FRAMEWORK_CRASH_REPETITIONS ?? "1", 10)
if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error("FRAMEWORK_CRASH_REPETITIONS must be a positive integer")
describe("PostgreSQL process crash/replay", () => {
  for (const failpoint of DURABLE_FAILPOINTS) it(`recovers at ${failpoint}`, async () => {
    for (let run = 0; run < repetitions; run += 1) {
      const setup = await openPgFixture(); await setup.end()
      await runPgUntilFailpoint(pgCertificationUrl(), failpoint, "execute")
      let db = await connectPg(); const n = Number((await db.query("SELECT count(*) n FROM framework_test.records")).rows[0].n); await db.end()
      if (isPreCommitFailpoint(failpoint)) expect(n).toBe(0)
      await runPgUntilFailpoint(pgCertificationUrl(), failpoint, "recover")
      db = await connectPg()
      const counts: number[] = []
      for (const table of ["records", "audit", "outbox", "cache_generations", "idempotency", "sequences", "temporal_heads", "temporal_revisions"])
        counts.push(Number((await db.query(`SELECT count(*) n FROM framework_test.${table}`)).rows[0].n))
      expect(counts).toEqual([1, 1, 1, 1, 1, 1, 1, 1]); await db.end()
    }
  })
})
afterAll(async () => { await writeCrashEvidence("pg", DURABLE_FAILPOINTS, repetitions) })
