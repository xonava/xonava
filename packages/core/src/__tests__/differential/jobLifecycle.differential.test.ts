import { describe, expect, it, vi } from "vitest"
import { forAllAsync, scaledRuns } from "./harness"
import { describeJobScenario, generateCalmJobScenario, generateJobScenario, shrinkJobScenario } from "./jobArbitraries"
import { runScenario, type JobScenario } from "./jobModel"
import { TIMING_SCALE } from "../timing"

vi.setConfig({ testTimeout: 120_000 * Math.max(1, scaledRuns(100) / 100) * TIMING_SCALE })

async function check(scenario: JobScenario): Promise<void> {
  const outcome = await runScenario(scenario)
  expect(outcome.violations, outcome.violations.join("\n")).toEqual([])
}

describe("job dispatcher against an in-memory store model", () => {
  it("keeps every lifecycle invariant under random worker interleavings", async () => {
    await forAllAsync("job dispatcher: random interleavings keep fencing, attempt and liveness invariants", generateJobScenario, check, {
      runs: 250, shrink: shrinkJobScenario, describe: describeJobScenario,
    })
  })

  it("matches the transition model exactly with a single healthy worker and no faults", async () => {
    await forAllAsync("job dispatcher: calm single-worker runs match the transition model", generateCalmJobScenario, check, {
      runs: 250, shrink: shrinkJobScenario, describe: describeJobScenario,
    })
  })
})
