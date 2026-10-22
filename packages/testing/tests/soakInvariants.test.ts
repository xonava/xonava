import { describe, expect, it } from "vitest"
import type { JobExecution } from "@xonava/core/execution"
import type { WorkflowInstance } from "@xonava/core/workflow"
import type { SoakRow, SoakSql, SoakTable } from "../soak/backends.js"
import {
  expectedOccurrences, historyViolations, jobConsistencyViolations, leftInFlight, nonTerminalJobs, nonTerminalWorkflows, recordedViolations, scheduleViolations, signalViolations,
  type JobRow, type RunRow, type ScheduleObservation, type ViolationRow, type WorkflowObservation,
} from "../soak/invariants.js"
import { createSoakJobDefinition, type SoakJobPayload } from "../soak/workload.js"
import type { DbReceipt } from "../integration/shared/workflowSignalBuffering.js"

// Every soak invariant must fire on a violation: a checker that cannot fail would make a green 30-minute run meaningless.

const MINUTE = 60_000
const FIRST = Date.UTC(2031, 0, 1, 0, 0, 0)
const key = (id: string, minute: number): string => `schedule:${id}:${new Date(FIRST + minute * MINUTE).toISOString()}`

describe("job invariants", () => {
  const jobs: JobRow[] = [{ id: "a", status: "succeeded", attempts: 1, maxAttempts: 3 }, { id: "b", status: "dead_letter", attempts: 3, maxAttempts: 3 }]
  const runs: RunRow[] = [{ unit: "job:a", attempt: 1, outcome: "success" }, { unit: "job:b", attempt: 1, outcome: "retry" }, { unit: "job:b", attempt: 2, outcome: null }]
  const scripts = new Map([["a", "ok"], ["b", "always-retry"]])

  it("passes a clean fixture", () => {
    expect(nonTerminalJobs(jobs)).toEqual([])
    expect(jobConsistencyViolations(jobs, runs, scripts)).toEqual([])
    expect(historyViolations([{ jobId: "a", terminalRows: 1 }])).toEqual([])
  })
  it("reports a job that is not terminal", () => {
    for (const status of ["pending", "running", "retrying"]) expect(nonTerminalJobs([{ ...jobs[0]!, status }])).toEqual([`job a ended ${status}`])
  })
  it("reports attempts beyond the budget", () => {
    expect(jobConsistencyViolations([{ ...jobs[1]!, attempts: 4 }], runs, scripts)).toEqual(expect.arrayContaining([expect.stringContaining("exceed the budget")]))
  })
  it("reports a handler run beyond the recorded attempts, and more runs than attempts", () => {
    expect(jobConsistencyViolations([jobs[0]!], [{ unit: "job:a", attempt: 2, outcome: "success" }], scripts)).toEqual(expect.arrayContaining([expect.stringContaining("ran attempt 2")]))
    expect(jobConsistencyViolations([jobs[0]!], [{ unit: "job:a", attempt: 1, outcome: "success" }, { unit: "job:a", attempt: 1, outcome: null }], scripts)).toEqual(expect.arrayContaining([expect.stringContaining("2 handler runs for 1 attempts")]))
  })
  it("reports a status that disagrees with the handler history", () => {
    expect(jobConsistencyViolations([jobs[0]!], [{ unit: "job:a", attempt: 1, outcome: "retry" }], scripts)).toEqual([expect.stringContaining("no handler run reported success")])
    expect(jobConsistencyViolations([{ ...jobs[0]!, id: "c" }], [{ unit: "job:c", attempt: 1, outcome: "success" }], new Map([["c", "permanent"]]))).toEqual([expect.stringContaining("(permanent) succeeded")])
  })
  it("reports two terminal history rows for one job", () => {
    expect(historyViolations([{ jobId: "a", terminalRows: 2 }, { jobId: "b", terminalRows: 1 }])).toEqual(["job a has 2 terminal history rows"])
  })
})

describe("schedule invariants", () => {
  const schedule = (storedKeys: string[], nextMinute = 3): ScheduleObservation => ({ id: "s", nextRunAt: FIRST + nextMinute * MINUTE, storedKeys })
  const cutoff = FIRST + 2.5 * MINUTE

  it("passes a clean fixture", () => {
    expect(scheduleViolations([schedule([key("s", 0), key("s", 1), key("s", 2)])], FIRST, cutoff)).toEqual([])
    expect(expectedOccurrences(FIRST + 3 * MINUTE, FIRST)).toBe(3)
  })
  it("reports a lost occurrence", () => {
    expect(scheduleViolations([schedule([key("s", 0), key("s", 2)])], FIRST, cutoff)).toEqual([`s: occurrence lost: ${key("s", 1)}`])
  })
  it("reports a duplicated occurrence", () => {
    expect(scheduleViolations([schedule([key("s", 0), key("s", 1), key("s", 1), key("s", 2)])], FIRST, cutoff)).toEqual(["s: an occurrence is stored more than once"])
  })
  it("reports an occurrence beyond next_run_at, a missing next_run_at, and a schedule still due", () => {
    expect(scheduleViolations([schedule([key("s", 0), key("s", 1), key("s", 2), key("s", 3)])], FIRST, cutoff)).toEqual([`s: unexpected occurrence ${key("s", 3)}`])
    expect(scheduleViolations([{ id: "s", nextRunAt: null, storedKeys: [] }], FIRST, cutoff)).toEqual(["s has no next_run_at"])
    expect(scheduleViolations([schedule([key("s", 0), key("s", 1)], 2)], FIRST, cutoff)).toEqual([expect.stringContaining("is not past the cutoff")])
  })
})

const instance = (id: string, status: WorkflowInstance["status"], n: number): WorkflowInstance => ({
  id, workflowType: "soak.flow", workflowVersion: 1, executionScope: { kind: "tenant", tenantId: "t" }, status, currentStep: "gate", variables: { n, target: 2 },
  stepAttempt: 0, compensationStack: [], waitingSignal: null, wakeAt: null, outcome: status === "succeeded" ? "succeeded" : null, revision: 5,
  leaseOwner: null, claimToken: null, leaseExpiresAt: null, createdAt: new Date(FIRST), updatedAt: new Date(FIRST),
})
const receipt = (id: string, instanceId: string, seq: number, consumed: boolean): DbReceipt => ({ id, instanceId, name: "tick", seq, consumed, consumedRevision: consumed ? seq + 1 : null })

describe("workflow invariants", () => {
  const clean = (): WorkflowObservation => ({
    ids: ["w"], instances: [instance("w", "succeeded", 2)], signalsPerWorkflow: 2,
    receipts: [receipt("w:s0", "w", 1, true), receipt("w:s1", "w", 2, true)], useCount: new Map([["w:s0", 1], ["w:s1", 1]]),
  })

  it("passes a clean fixture", () => {
    const observation = clean()
    expect(nonTerminalWorkflows(observation.ids, observation.instances)).toEqual([])
    expect(signalViolations(observation)).toEqual([])
  })
  it("reports a workflow that is not terminal or missing", () => {
    expect(nonTerminalWorkflows(["w"], [instance("w", "waiting", 1)])).toEqual(["workflow w is not terminal"])
    expect(nonTerminalWorkflows(["w"], [])).toEqual(["workflow w is not terminal"])
  })
  it("reports a receipt that resumed two waits", () => {
    expect(signalViolations({ ...clean(), useCount: new Map([["w:s0", 2], ["w:s1", 1]]) })).toEqual(expect.arrayContaining([expect.stringContaining("receipt w:s0 resumed 2 different waits")]))
  })
  it("reports a lost signal: an instance waiting while a receipt of its signal is pending", () => {
    const waiting: WorkflowInstance = { ...instance("w", "waiting", 1), waitingSignal: "tick" }
    expect(signalViolations({ ids: ["w"], instances: [waiting], signalsPerWorkflow: 2, receipts: [receipt("w:s0", "w", 1, false)], useCount: new Map() })).toEqual([expect.stringContaining("(lost signal)")])
  })
  it("reports a succeeded instance with an unconsumed receipt, a wrong count, or a receipt not used exactly once", () => {
    expect(signalViolations({ ...clean(), receipts: [receipt("w:s0", "w", 1, true), receipt("w:s1", "w", 2, false)] })).toEqual(expect.arrayContaining([expect.stringContaining("1/2 receipts consumed")]))
    expect(signalViolations({ ...clean(), instances: [instance("w", "succeeded", 1)] })).toEqual([expect.stringContaining("succeeded with n=1")])
    expect(signalViolations({ ...clean(), useCount: new Map([["w:s0", 1]]) })).toEqual([expect.stringContaining("not used by exactly one wait")])
  })
  it("reports a receipt that resumed a wait without being marked consumed", () => {
    expect(signalViolations({ ids: ["w"], instances: [instance("w", "cancelled", 0)], signalsPerWorkflow: 2, receipts: [receipt("w:s0", "w", 1, false)], useCount: new Map([["w:s0", 1]]) })).toEqual(expect.arrayContaining([expect.stringContaining("is not marked consumed")]))
  })
})

describe("in-flight bookkeeping", () => {
  it("reports work left in flight", () => {
    expect(leftInFlight([])).toEqual([])
    expect(leftInFlight([{ unit: "job:a", worker: "w1" }])).toEqual(["job:a still held by w1"])
  })
})

/** Just enough of SoakSql for the job handler's bookkeeping: primary-key inserts, the DELETE of its own marker and the outcome UPDATE. */
function memorySql(): { sql: SoakSql; rows(table: SoakTable): SoakRow[] } {
  const tables = new Map<SoakTable, SoakRow[]>()
  const keys: Record<SoakTable, readonly string[]> = { soak_inflight: ["unit"], soak_runs: ["unit", "attempt"], soak_violations: ["id"], soak_signal_uses: ["signal_id", "n_after"] }
  const rows = (table: SoakTable): SoakRow[] => { const found = tables.get(table) ?? []; tables.set(table, found); return found }
  const sql: SoakSql = {
    table: (name) => name,
    insertIgnore: async (table, row) => {
      const name = table as SoakTable
      if (rows(name).some((existing) => keys[name].every((column) => existing[column] === row[column]))) return false
      rows(name).push({ ...row })
      return true
    },
    run: async (statement, params = []) => {
      if (statement.startsWith("DELETE FROM soak_inflight")) {
        const before = rows("soak_inflight").length
        tables.set("soak_inflight", rows("soak_inflight").filter((row) => !(row.unit === params[0] && row.worker === params[1])))
        return before - rows("soak_inflight").length
      }
      if (statement.startsWith("UPDATE soak_runs")) {
        for (const row of rows("soak_runs")) if (row.unit === params[1] && row.attempt === params[2]) row.outcome = params[0]
        return 1
      }
      throw new Error(`unexpected statement ${statement}`)
    },
    all: async () => { throw new Error("not used") },
  }
  return { sql, rows }
}

describe("handler bookkeeping detects violations", () => {
  const execution = (jobId: string, attempt: number, payload: SoakJobPayload): JobExecution => ({
    executionId: `${jobId}-${attempt}`, jobId, jobType: "soak.job", jobVersion: 1, attempt, tenantId: null, executionScope: { kind: "system", systemKey: "framework" }, correlationId: jobId,
    startedAt: new Date(FIRST), metadata: {}, fencedEffect: {} as JobExecution["fencedEffect"], payload,
  })
  const violations = (rows: SoakRow[]): ViolationRow[] => rows.map((row) => ({ kind: String(row.kind), unit: String(row.unit), detail: String(row.detail) }))

  it("records nothing for sequential, distinct attempts", async () => {
    const { sql, rows } = memorySql()
    const definition = createSoakJobDefinition({ sql, workerId: "w1" })
    await definition.execute(execution("a", 1, { script: "retry-then-ok", ms: 1 }))
    await definition.execute(execution("a", 2, { script: "retry-then-ok", ms: 1 }))
    expect(violations(rows("soak_violations"))).toEqual([])
    expect(rows("soak_inflight")).toEqual([])
    expect(rows("soak_runs").map((row) => row.outcome)).toEqual(["retry", "success"])
  })
  it("reports two overlapping runs of one job", async () => {
    const { sql, rows } = memorySql()
    const first = createSoakJobDefinition({ sql, workerId: "w1" })
    const second = createSoakJobDefinition({ sql, workerId: "w2" })
    await Promise.all([first.execute(execution("a", 1, { script: "ok", ms: 30 })), second.execute(execution("a", 2, { script: "ok", ms: 30 }))])
    expect(recordedViolations(violations(rows("soak_violations")), "concurrent-execution")).toEqual([expect.stringContaining("job:a")])
  })
  it("reports two jobs of one partition running at the same time", async () => {
    const { sql, rows } = memorySql()
    const first = createSoakJobDefinition({ sql, workerId: "w1" })
    const second = createSoakJobDefinition({ sql, workerId: "w2" })
    await Promise.all([first.execute(execution("a", 1, { script: "ok", ms: 30, partition: "p0" })), second.execute(execution("b", 1, { script: "ok", ms: 30, partition: "p0" }))])
    expect(recordedViolations(violations(rows("soak_violations")), "concurrent-execution")).toEqual([expect.stringContaining("partition:p0")])
  })
  it("reports an attempt that starts twice", async () => {
    const { sql, rows } = memorySql()
    const definition = createSoakJobDefinition({ sql, workerId: "w1" })
    await definition.execute(execution("a", 1, { script: "ok", ms: 1 }))
    await definition.execute(execution("a", 1, { script: "ok", ms: 1 }))
    expect(recordedViolations(violations(rows("soak_violations")), "attempt-ran-twice")).toEqual([expect.stringContaining("job:a")])
  })
  it("leaves a marker in flight when the handler is killed (no cleanup runs), which the drain check reports", async () => {
    const { sql, rows } = memorySql()
    await sql.insertIgnore(sql.table("soak_inflight"), { unit: "job:a", worker: "w1", started_ms: 1 })
    expect(leftInFlight(rows("soak_inflight").map((row) => ({ unit: String(row.unit), worker: String(row.worker) })))).toEqual(["job:a still held by w1"])
  })
})
