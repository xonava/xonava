import { afterAll, describe, expect, it } from "vitest"
import { DURABLE_FAILPOINTS, isPreCommitFailpoint } from "./failpoints.js"
import { assertCrashOracle, readD1Oracle } from "./oracle.js"
import { runUntilFailpoint } from "./processHarness.js"
import { openD1Fixture, temporaryD1Fixture } from "../integration/d1/database.js"
import { writeCrashEvidence } from "../src/conformance/guaranteeEvidence.js"
const repetitions = Number.parseInt(process.env.FRAMEWORK_CRASH_REPETITIONS ?? "1", 10)
if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error("FRAMEWORK_CRASH_REPETITIONS must be a positive integer")

describe("D1 process crash/replay", () => {
  for (const failpoint of DURABLE_FAILPOINTS) it(`recovers at ${failpoint}`, async () => {
    for (let run = 0; run < repetitions; run += 1) {
      const f = await temporaryD1Fixture(); const path = f.persistPath; await f.close()
      if (!path) throw new Error("persistent D1 fixture path missing")
      await runUntilFailpoint(path, failpoint, "execute")
      let verifier = await openD1Fixture(path)
      const afterCrash = await readD1Oracle(verifier.db); assertCrashOracle(afterCrash); await verifier.close()
      if (isPreCommitFailpoint(failpoint)) expect(afterCrash.business).toBe(0)
      await runUntilFailpoint(path, failpoint, "recover")
      verifier = await openD1Fixture(path); const recovered = await readD1Oracle(verifier.db); assertCrashOracle(recovered)
      expect(recovered).toEqual({ business: 1, audit: 1, outbox: 1, cacheGeneration: 1, receipt: 1, version: 1 })
      expect(await verifier.db.prepare("SELECT value FROM framework_sequences WHERE scope_id='t' AND name='invoice' AND period='all'").first("value")).toBe(1)
      expect(await verifier.db.prepare("SELECT count(*) AS count FROM framework_temporal_revisions WHERE scope_id='t' AND entity_type='record' AND entity_id='r'").first("count")).toBe(1)
      await verifier.close(); await f.cleanup()
    }
  })
})
afterAll(async () => { await writeCrashEvidence("d1", DURABLE_FAILPOINTS, repetitions) })
