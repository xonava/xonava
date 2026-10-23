import { describe, expect, it } from "vitest"
import { readSoakConfig, selectedAdapters } from "./config.js"
import { runSoak, writeSoakEvidence } from "./orchestrator.js"

/**
 * `npm run soak`: the job, schedule and workflow dispatchers under random worker kills, short leases and clock skew for
 * SOAK_MINUTES (default 30) per database. See CONTRIBUTING.md, "Soak testing".
 */
const config = readSoakConfig()
const { run, notConfigured } = selectedAdapters()
const log = (message: string): void => { process.stdout.write(`[soak] ${message}\n`) }

describe("soak", () => {
  for (const adapter of notConfigured) {
    it(`${adapter}: not configured`, () => { log(`${adapter} was NOT run: its database URL is not configured (FRAMEWORK_TEST_${adapter === "pg" ? "PG" : "MYSQL"}_URL)`) })
  }
  for (const adapter of run) {
    it(`${adapter}: no invariant is violated under kills, short leases and clock skew`, async () => {
      const report = await runSoak(adapter, config, (message) => log(`${adapter}: ${message}`))
      const path = await writeSoakEvidence(report)
      log(`${adapter}: ${report.status} in ${Math.round(report.durationMs / 1000)}s; evidence ${path}`)
      log(`${adapter}: ${JSON.stringify({ kills: report.kills, jobs: report.jobs, schedules: { occurrences: report.schedules.occurrences }, workflows: report.workflows, invariants: report.invariants })}`)
      expect(report.violations).toEqual([])
    }, config.minutes * 60_000 + config.drainTimeoutMs + 5 * 60_000)
  }
})
