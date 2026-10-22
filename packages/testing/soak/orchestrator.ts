import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { scheduleCorrelationId } from "@xonava/core/execution"
import type { WorkflowInstance } from "@xonava/core/workflow"
import { signalLedgerViolations } from "../../core/src/__tests__/differential/workflowFixtures.js"
import { insertRow, readRows } from "../integration/shared/scheduleStoreDifferential.js"
import { scheduleRow } from "../integration/shared/scheduleStoreDifferentialScenarios.js"
import { connectSoak, hostSoakDatabase, type SoakConnection, type SoakDescriptor } from "./backends.js"
import type { SoakAdapter, SoakConfig } from "./config.js"
import { createSoakRng, type SoakRng } from "./rng.js"
import { JOB_TYPE, SIGNAL_NAME, WORKFLOW_TYPE, type JobScript, type SoakJobPayload } from "./workload.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const MINUTE = 60_000
const SIGNALS_PER_WORKFLOW = 3
const JOB_TERMINAL = ["succeeded", "failed", "dead_letter", "cancelled"]
const EXECUTION_TERMINAL = ["succeeded", "failed", "dead_letter"]
const WORKFLOW_TERMINAL = new Set(["succeeded", "failed", "cancelled", "compensation_failed"])
const SYSTEM = { scope: "system" } as const
const SYSTEM_SCOPE = { kind: "system", systemKey: "framework" } as const
const WORKFLOW_SCOPE = { kind: "tenant", tenantId: "soak" } as const

const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms) })
const count = (value: unknown): number => Number(value)

export interface SoakReport {
  schemaVersion: 1
  adapter: SoakAdapter
  status: "passed" | "failed"
  runId: string
  location: string
  config: Omit<SoakConfig, "runId">
  startedAt: string
  finishedAt: string
  durationMs: number
  loadDurationMs: number
  drainDurationMs: number
  kills: { total: number; simultaneous: number; respawns: number }
  jobs: { enqueued: number; total: number; byStatus: Record<string, number>; byScript: Record<string, number>; handlerRuns: number; handlerRunsByOutcome: Record<string, number>; killedMidRun: number; terminalHistoryRows: number }
  schedules: { count: number; occurrences: number; perSchedule: Record<string, number> }
  workflows: { started: number; cancelled: number; byStatus: Record<string, number>; signalsDelivered: number; signalsDuplicate: number; signalsRejected: number; signalsConsumed: number; signalResumes: number }
  workerMessages: { errors: number; dispatchErrors: number; samples: string[] }
  invariants: Record<string, { checked: number; violations: number }>
  violations: string[]
}

interface Worker { readonly id: string; readonly child: ChildProcess; readonly exited: Promise<void>; alive: boolean }

/**
 * One soak run against one database: workers are killed at random while jobs, schedules and workflows keep arriving, then
 * the system drains and every invariant is checked exactly (see verify()). Any violation fails the run.
 */
export async function runSoak(adapter: SoakAdapter, config: SoakConfig, log: (message: string) => void = () => undefined): Promise<SoakReport> {
  const startedAt = Date.now()
  const rng = createSoakRng(config.seed)
  const host = await hostSoakDatabase(adapter, config.runId)
  const connection = connectSoak(host.descriptor)
  try {
    return await execute(adapter, config, rng, host.location, host.descriptor, connection, startedAt, log)
  } finally {
    await connection.close().catch(() => undefined)
    await host.teardown().catch((error: unknown) => log(`teardown failed: ${String(error)}`))
  }
}

async function execute(adapter: SoakAdapter, config: SoakConfig, rng: SoakRng, location: string, descriptor: SoakDescriptor, connection: SoakConnection, startedAt: number, log: (message: string) => void): Promise<SoakReport> {
  const { sql } = connection
  const messages = { errors: 0, dispatchErrors: 0, samples: [] as string[] }
  const stats = { kills: 0, simultaneous: 0, respawns: 0, spawned: 0 }
  const workers = new Map<string, Worker>()
  let cutoff: number | undefined

  // --- workers -------------------------------------------------------------------------------------------------------
  const cleanInflight = async (workerId: string): Promise<void> => { await sql.run(`DELETE FROM ${sql.table("soak_inflight")} WHERE worker = ?`, [workerId]) }
  function spawnWorker(): Worker {
    const id = `w${++stats.spawned}`
    const offset = rng.between(-config.skewMs, config.skewMs)
    const child = spawn(process.execPath, ["--import", join(HERE, "register.mjs"), "--disable-warning=ExperimentalWarning", join(HERE, "worker.ts")], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, SOAK_DESCRIPTOR: JSON.stringify(descriptor), SOAK_WORKER_ID: id, SOAK_LEASE_MS: String(config.leaseMs), SOAK_WORKER_OFFSET_MS: String(offset) },
    })
    let stderr = ""
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + String(chunk)).slice(-2_000) })
    child.on("message", (message: { type?: string; source?: string; message?: string }) => {
      if (message.type === "error" || message.type === "dispatch-error") {
        if (message.type === "error") messages.errors += 1; else messages.dispatchErrors += 1
        if (messages.samples.length < 25) messages.samples.push(`${id} ${message.source}: ${message.message}`)
      }
    })
    const worker: Worker = {
      id, child, alive: true,
      exited: new Promise<void>((done) => {
        child.on("exit", (code, signal) => {
          worker.alive = false
          if (signal === null && code !== 0 && !stopping) messages.samples.push(`${id} exited unexpectedly with code ${String(code)}: ${stderr.trim().slice(-400)}`)
          done()
        })
      }),
    }
    workers.set(id, worker)
    if (cutoff !== undefined) child.send({ cmd: "cutoff", cutoff })
    return worker
  }
  let stopping = false
  const aliveWorkers = (): Worker[] => [...workers.values()].filter((worker) => worker.alive)
  async function kill(worker: Worker): Promise<void> {
    worker.child.kill("SIGKILL")
    await worker.exited
    stats.kills += 1
    // The killed handler is gone. Its request may still reach a database that has not caught up (D1), so clean twice,
    // both well inside the lease that a survivor has to wait out before it may reclaim the work.
    await cleanInflight(worker.id)
    void sleep(1_500).then(() => cleanInflight(worker.id)).catch(() => undefined)
  }
  for (let index = 0; index < config.workers; index += 1) spawnWorker()

  // --- schedules -----------------------------------------------------------------------------------------------------
  const firstRun = Math.ceil((Date.now() + 2_000) / MINUTE) * MINUTE
  const scheduleIds = Array.from({ length: config.schedules }, (_, index) => `soak-schedule-${index}`)
  for (const [index, id] of scheduleIds.entries()) {
    await insertRow(connection.scheduleDriver, scheduleRow(id, {
      jobType: JOB_TYPE, payload: JSON.stringify({ script: "ok", ms: 20 }), cronExpression: "* * * * *", misfirePolicy: "queue_all",
      overlapPolicy: index % 2 === 0 ? "allow" : "queue", nextRunAt: firstRun,
    }))
  }

  // --- producers -----------------------------------------------------------------------------------------------------
  const deadline = startedAt + config.minutes * MINUTE
  let draining = false
  const jobScripts = new Map<string, JobScript>()
  let jobsEnqueued = 0
  const workflowIds: string[] = []
  const cancelled = new Set<string>()
  const signalStats = { delivered: 0, duplicate: 0, rejected: 0 }
  const producerErrors: string[] = []
  const guarded = async (what: string, action: () => Promise<void>): Promise<void> => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try { await action(); return } catch (error) {
        if (attempt === 3) { producerErrors.push(`${what}: ${String((error as Error)?.message ?? error).slice(0, 200)}`); return }
        await sleep(200 * attempt)
      }
    }
  }
  const pickScript = (): JobScript => {
    const roll = rng.next()
    return roll < 0.55 ? "ok" : roll < 0.7 ? "retry-then-ok" : roll < 0.78 ? "permanent" : roll < 0.85 ? "always-retry" : roll < 0.9 ? "slow" : "ok"
  }
  async function produceJobs(): Promise<void> {
    while (Date.now() < deadline) {
      const n = ++jobsEnqueued
      const script = pickScript()
      const payload: SoakJobPayload = { script, ms: script === "slow" ? Math.round(config.leaseMs * 2.5) : rng.between(20, 300), ...(rng.bool(0.25) ? { partition: `p${rng.int(4)}` } : {}) }
      await guarded(`enqueue job ${n}`, async () => {
        const stored = await connection.jobStore.enqueue({
          requester: SYSTEM,
          job: { executionScope: SYSTEM_SCOPE, jobType: JOB_TYPE, jobVersion: 1, payload, runAt: new Date(), maxAttempts: 3, idempotencyKey: `soak-job-${n}`, ...(payload.partition ? { partitionKey: payload.partition } : {}) },
        })
        jobScripts.set(stored.id, script)
      })
      await sleep(rng.between(100, 700))
    }
  }
  const lifecycles: Promise<void>[] = []
  async function lifecycle(id: string, plan: { delays: number[]; duplicate: boolean[]; cancelAfter: number | null }): Promise<void> {
    for (let index = 0; index < SIGNALS_PER_WORKFLOW; index += 1) {
      if (plan.cancelAfter === index) {
        await guarded(`cancel ${id}`, async () => { if (await connection.workflowStore.cancel(id)) cancelled.add(id) })
        return
      }
      await sleep(draining ? 0 : plan.delays[index]!)
      const signal = { id: `${id}:s${index}`, instanceId: id, name: SIGNAL_NAME, payload: { index } }
      await guarded(`signal ${signal.id}`, async () => {
        const first = await connection.workflowStore.deliverSignal(signal)
        if (first.delivered) signalStats.delivered += 1; else if (first.duplicate) signalStats.duplicate += 1; else signalStats.rejected += 1
        if (plan.duplicate[index]) {
          const again = await connection.workflowStore.deliverSignal(signal)
          if (again.delivered || !again.duplicate) producerErrors.push(`duplicate delivery of ${signal.id} was not recognised: ${JSON.stringify(again)}`)
          signalStats.duplicate += 1
        }
      })
    }
  }
  async function produceWorkflows(): Promise<void> {
    let n = 0
    while (Date.now() < deadline) {
      const id = `soak-flow-${++n}`
      await guarded(`start ${id}`, async () => {
        await connection.workflowStore.start({ id, workflowType: WORKFLOW_TYPE, workflowVersion: 1, executionScope: WORKFLOW_SCOPE, initialStep: "begin", variables: { target: SIGNALS_PER_WORKFLOW } })
        workflowIds.push(id)
        lifecycles.push(lifecycle(id, {
          delays: Array.from({ length: SIGNALS_PER_WORKFLOW }, () => rng.between(0, 6_000)),
          duplicate: Array.from({ length: SIGNALS_PER_WORKFLOW }, () => rng.bool(0.2)),
          cancelAfter: rng.bool(0.08) ? rng.int(SIGNALS_PER_WORKFLOW) : null,
        }))
      })
      await sleep(rng.between(2_000, 6_000))
    }
  }
  async function chaos(): Promise<void> {
    while (Date.now() < deadline) {
      await sleep(rng.between(config.killMinMs, config.killMaxMs))
      if (Date.now() >= deadline) break
      const alive = aliveWorkers()
      const victims = alive.length > 2 && rng.bool(0.15) ? alive.slice(1) : [rng.pick(alive)]
      if (victims.length > 1) stats.simultaneous += 1
      await Promise.all(victims.map((victim) => kill(victim)))
      await sleep(rng.between(0, 1_500))
      while (aliveWorkers().length < config.workers) { spawnWorker(); stats.respawns += 1 }
    }
  }

  log(`load phase: ${config.minutes} min, ${config.workers} workers, seed ${config.seed}`)
  const loadStart = Date.now()
  await Promise.all([produceJobs(), produceWorkflows(), chaos()])
  draining = true
  await Promise.all(lifecycles)
  const loadDurationMs = Date.now() - loadStart

  // --- drain ---------------------------------------------------------------------------------------------------------
  const drainStart = Date.now()
  while (aliveWorkers().length < config.workers) spawnWorker()
  cutoff = Date.now()
  for (const worker of aliveWorkers()) worker.child.send({ cmd: "cutoff", cutoff })
  log(`drain phase: ${jobsEnqueued} jobs, ${workflowIds.length} workflows, cutoff ${new Date(cutoff).toISOString()}`)
  const notDrained: string[] = []
  const drainDeadline = Date.now() + config.drainTimeoutMs
  for (;;) {
    notDrained.length = 0
    const schedules = await readRows(connection.scheduleDriver)
    for (const id of scheduleIds) { const next = schedules.get(id)?.nextRunAt; if (next === null || next === undefined || next <= cutoff) notDrained.push(`schedule ${id} still due (next ${String(next)})`) }
    const open = await sql.all(`SELECT id, status FROM ${connection.jobsTable} WHERE status NOT IN (${JOB_TERMINAL.map(() => "?").join(",")})`, JOB_TERMINAL)
    for (const row of open.slice(0, 10)) notDrained.push(`job ${String(row.id)} is ${String(row.status)}`)
    if (open.length > 10) notDrained.push(`... ${open.length} jobs not terminal`)
    for (const id of workflowIds) {
      const instance = await connection.workflowStore.get(id)
      if (!instance || !WORKFLOW_TERMINAL.has(instance.status)) notDrained.push(`workflow ${id} is ${instance?.status ?? "missing"}`)
      if (notDrained.length > 30) break
    }
    if (notDrained.length === 0 || Date.now() > drainDeadline) break
    await sleep(1_000)
  }
  const drainDurationMs = Date.now() - drainStart

  stopping = true
  for (const worker of aliveWorkers()) worker.child.send({ cmd: "stop" })
  await Promise.race([Promise.all([...workers.values()].map((worker) => worker.exited)), sleep(20_000)])
  for (const worker of aliveWorkers()) await kill(worker)

  // --- verification --------------------------------------------------------------------------------------------------
  const violations: string[] = [...producerErrors.map((message) => `producer failure: ${message}`)]
  const invariants: SoakReport["invariants"] = {}
  const check = (name: string, checked: number, found: string[]): void => {
    invariants[name] = { checked, violations: found.length }
    for (const message of found.slice(0, 20)) violations.push(`${name}: ${message}`)
    if (found.length > 20) violations.push(`${name}: ... and ${found.length - 20} more`)
  }
  check("drained", 1, notDrained)
  const report = await verify(connection, { scheduleIds, firstRun, cutoff, jobScripts, workflowIds, cancelled, check })
  const finishedAt = Date.now()
  const failed = violations.length > 0
  return {
    schemaVersion: 1, adapter, status: failed ? "failed" : "passed", runId: config.runId, location,
    config: { minutes: config.minutes, workers: config.workers, seed: config.seed, leaseMs: config.leaseMs, skewMs: config.skewMs, killMinMs: config.killMinMs, killMaxMs: config.killMaxMs, drainTimeoutMs: config.drainTimeoutMs, schedules: config.schedules },
    startedAt: new Date(startedAt).toISOString(), finishedAt: new Date(finishedAt).toISOString(), durationMs: finishedAt - startedAt, loadDurationMs, drainDurationMs,
    kills: { total: stats.kills, simultaneous: stats.simultaneous, respawns: stats.respawns },
    jobs: { enqueued: jobsEnqueued, ...report.jobs },
    schedules: { count: scheduleIds.length, ...report.schedules },
    workflows: { started: workflowIds.length, cancelled: cancelled.size, ...report.workflows, signalsDelivered: signalStats.delivered, signalsDuplicate: signalStats.duplicate, signalsRejected: signalStats.rejected },
    workerMessages: messages, invariants, violations,
  }
}

interface VerifyInput {
  scheduleIds: string[]
  firstRun: number
  cutoff: number
  jobScripts: Map<string, JobScript>
  workflowIds: string[]
  cancelled: Set<string>
  check(name: string, checked: number, found: string[]): void
}

async function verify(connection: SoakConnection, input: VerifyInput) {
  const { sql } = connection
  const { check } = input

  // Recorded by the handlers themselves: concurrent executions, repeated attempts.
  const recorded = await sql.all(`SELECT kind, unit, detail FROM ${sql.table("soak_violations")}`)
  check("no unit of work runs twice concurrently", count((await sql.all(`SELECT COUNT(*) AS n FROM ${sql.table("soak_runs")}`))[0]!.n), recorded.filter((row) => row.kind === "concurrent-execution").map((row) => `${String(row.unit)}: ${String(row.detail)}`))
  check("no attempt starts twice", 0, recorded.filter((row) => row.kind === "attempt-ran-twice").map((row) => `${String(row.unit)}: ${String(row.detail)}`))
  const stale = await sql.all(`SELECT unit, worker FROM ${sql.table("soak_inflight")}`)
  check("nothing is left in flight after the drain", stale.length, stale.map((row) => `${String(row.unit)} still held by ${String(row.worker)}`))

  // Jobs: every one terminal, within budget, consistent with what the handlers did.
  const jobs = await sql.all(`SELECT id, status, ${connection.jobAttemptsColumn} AS attempts, max_attempts FROM ${connection.jobsTable}`)
  const byStatus: Record<string, number> = {}
  for (const job of jobs) byStatus[String(job.status)] = (byStatus[String(job.status)] ?? 0) + 1
  check("every job reaches a terminal status", jobs.length, jobs.filter((job) => !JOB_TERMINAL.includes(String(job.status))).map((job) => `job ${String(job.id)} ended ${String(job.status)}`))
  const runs = await sql.all(`SELECT unit, attempt, outcome FROM ${sql.table("soak_runs")} WHERE unit LIKE 'job:%'`)
  const runsByJob = new Map<string, { attempt: number; outcome: string | null }[]>()
  const handlerRunsByOutcome: Record<string, number> = {}
  for (const run of runs) {
    const id = String(run.unit).slice("job:".length)
    runsByJob.set(id, [...(runsByJob.get(id) ?? []), { attempt: count(run.attempt), outcome: run.outcome === null ? null : String(run.outcome) }])
    const outcome = run.outcome === null ? "killed-mid-run" : String(run.outcome)
    handlerRunsByOutcome[outcome] = (handlerRunsByOutcome[outcome] ?? 0) + 1
  }
  const consistency: string[] = []
  for (const job of jobs) {
    const id = String(job.id)
    const attempts = count(job.attempts)
    const budget = Math.min(count(job.max_attempts), 3)
    const own = runsByJob.get(id) ?? []
    if (attempts > budget) consistency.push(`job ${id}: ${attempts} attempts exceed the budget of ${budget}`)
    if (own.some((run) => run.attempt > attempts)) consistency.push(`job ${id}: a handler ran attempt ${Math.max(...own.map((run) => run.attempt))} but the job records ${attempts}`)
    if (own.length > attempts) consistency.push(`job ${id}: ${own.length} handler runs for ${attempts} attempts`)
    if (job.status === "succeeded" && !own.some((run) => run.outcome === "success")) consistency.push(`job ${id} succeeded but no handler run reported success`)
    const script = input.jobScripts.get(id)
    if (job.status === "succeeded" && (script === "permanent" || script === "always-retry")) consistency.push(`job ${id} (${script}) succeeded`)
  }
  check("job attempts, handler runs and statuses agree", jobs.length, consistency)
  const history = await sql.all(`SELECT job_id, COUNT(*) AS n FROM ${connection.jobExecutionsTable} WHERE status IN (${EXECUTION_TERMINAL.map(() => "?").join(",")}) GROUP BY job_id`, EXECUTION_TERMINAL)
  const terminalHistoryRows = history.reduce((sum, row) => sum + count(row.n), 0)
  check("a job has at most one terminal history row", history.length, history.filter((row) => count(row.n) > 1).map((row) => `job ${String(row.job_id)} has ${String(row.n)} terminal history rows`))

  // Schedules: exactly the contiguous run of minute occurrences from the first to the one before next_run_at.
  const rows = await readRows(connection.scheduleDriver)
  const perSchedule: Record<string, number> = {}
  const scheduleProblems: string[] = []
  let occurrences = 0
  for (const id of input.scheduleIds) {
    const next = rows.get(id)?.nextRunAt
    if (next === null || next === undefined) { scheduleProblems.push(`${id} has no next_run_at`); continue }
    if (next <= input.cutoff) scheduleProblems.push(`${id} next_run_at ${new Date(next).toISOString()} is not past the cutoff`)
    const expected: string[] = []
    for (let at = input.firstRun; at < next; at += MINUTE) expected.push(`schedule:${id}:${new Date(at).toISOString()}`)
    const stored = (await sql.all(`SELECT idempotency_key FROM ${connection.jobsTable} WHERE correlation_id = ?`, [scheduleCorrelationId(id)])).map((row) => String(row.idempotency_key))
    const seen = new Set(stored)
    if (seen.size !== stored.length) scheduleProblems.push(`${id}: an occurrence is stored more than once`)
    for (const key of expected) if (!seen.has(key)) scheduleProblems.push(`${id}: occurrence lost: ${key}`)
    const wanted = new Set(expected)
    for (const key of seen) if (!wanted.has(key)) scheduleProblems.push(`${id}: unexpected occurrence ${key}`)
    perSchedule[id] = expected.length
    occurrences += expected.length
  }
  check("no schedule occurrence is lost or duplicated", occurrences, scheduleProblems)

  // Workflows: terminal, signals consumed at most once and none lost.
  const instances: WorkflowInstance[] = []
  for (const id of input.workflowIds) { const instance = await connection.workflowStore.get(id); if (instance) instances.push(instance) }
  const workflowByStatus: Record<string, number> = {}
  for (const instance of instances) workflowByStatus[instance.status] = (workflowByStatus[instance.status] ?? 0) + 1
  check("every workflow reaches a terminal status", input.workflowIds.length, input.workflowIds.filter((id) => !instances.some((instance) => instance.id === id && WORKFLOW_TERMINAL.has(instance.status))).map((id) => `workflow ${id} is not terminal`))
  const receipts = input.workflowIds.length === 0 ? [] : await connection.receipts(input.workflowIds)
  const consumed = new Set(receipts.filter((receipt) => receipt.consumed).map((receipt) => receipt.id))
  const uses = await sql.all(`SELECT signal_id, COUNT(*) AS n FROM ${sql.table("soak_signal_uses")} GROUP BY signal_id`)
  const useCount = new Map(uses.map((row) => [String(row.signal_id), count(row.n)]))
  const signalProblems = signalLedgerViolations({ receipts, consumed, rows: instances })
  for (const [signalId, uses] of useCount) if (uses > 1) signalProblems.push(`receipt ${signalId} resumed ${uses} different waits`)
  for (const receipt of receipts) {
    if (!receipt.consumed && (useCount.get(receipt.id) ?? 0) > 0) signalProblems.push(`receipt ${receipt.id} resumed a wait but is not marked consumed`)
    if (receipt.consumed && receipt.consumedRevision === null) signalProblems.push(`receipt ${receipt.id} is consumed without a consuming revision`)
  }
  for (const instance of instances) {
    const own = receipts.filter((receipt) => receipt.instanceId === instance.id)
    if (instance.status === "succeeded") {
      if (Number(instance.variables.n) !== SIGNALS_PER_WORKFLOW) signalProblems.push(`${instance.id} succeeded with n=${String(instance.variables.n)}`)
      if (own.length !== SIGNALS_PER_WORKFLOW || own.some((receipt) => !receipt.consumed)) signalProblems.push(`${instance.id} succeeded with ${own.filter((receipt) => receipt.consumed).length}/${own.length} receipts consumed`)
      if (own.some((receipt) => useCount.get(receipt.id) !== 1)) signalProblems.push(`${instance.id}: a receipt was not used by exactly one wait`)
    }
  }
  check("workflow signals are consumed at most once and none is lost", receipts.length, signalProblems)

  return {
    jobs: { total: jobs.length, byStatus, byScript: tally(input.jobScripts), handlerRuns: runs.length, handlerRunsByOutcome, killedMidRun: handlerRunsByOutcome["killed-mid-run"] ?? 0, terminalHistoryRows },
    schedules: { occurrences, perSchedule },
    workflows: { byStatus: workflowByStatus, signalsConsumed: consumed.size, signalResumes: [...useCount.values()].reduce((sum, value) => sum + value, 0) },
  }
}

function tally(scripts: Map<string, JobScript>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const script of scripts.values()) out[script] = (out[script] ?? 0) + 1
  return out
}

/** Writes artifacts/framework-conformance/<run>/<phase>/<adapter>-soak.json next to the crash evidence. Local runs are git-ignored. */
export async function writeSoakEvidence(report: SoakReport): Promise<string> {
  const phase = process.env.FRAMEWORK_CONFORMANCE_PHASE ?? "soak"
  const directory = resolve(process.cwd(), "../../artifacts/framework-conformance", report.runId, phase)
  await mkdir(directory, { recursive: true })
  const path = resolve(directory, `${report.adapter}-soak.json`)
  await writeFile(path, `${JSON.stringify({ ...report, recordedAt: new Date().toISOString() }, null, 2)}\n`, "utf8")
  return path
}
