import { dispatchDueJobs, materializeDueSchedules } from "@xonava/core/execution"
import { dispatchWorkflows } from "@xonava/core/workflow"
import { connectSoak, type SoakDescriptor } from "./backends.js"
import { createSoakJobRegistry, createSoakWorkflowRegistry } from "./workload.js"

/**
 * One soak worker process: dispatches jobs, materializes schedules and advances workflows in a loop against the shared
 * database with a short lease and a clock that is offset from real time by SOAK_WORKER_OFFSET_MS. The orchestrator kills
 * these processes with SIGKILL at random; there is no cleanup path on purpose. A message {cutoff} stops the schedule
 * clock from moving past that instant; a message {stop} ends the loops and exits cleanly.
 */
const descriptor = JSON.parse(process.env.SOAK_DESCRIPTOR ?? "null") as SoakDescriptor | null
const workerId = process.env.SOAK_WORKER_ID
if (!descriptor || !workerId) throw new Error("soak worker requires SOAK_DESCRIPTOR and SOAK_WORKER_ID")
const leaseMs = Number(process.env.SOAK_LEASE_MS ?? "4000")
const offsetMs = Number(process.env.SOAK_WORKER_OFFSET_MS ?? "0")

const connection = connectSoak(descriptor)
const context = { sql: connection.sql, workerId }
const jobRegistry = createSoakJobRegistry(context)
const workflowRegistry = createSoakWorkflowRegistry(context)

const skewed = (): Date => new Date(Date.now() + offsetMs)
const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal?.aborted) return resolve()
  const onAbort = (): void => { clearTimeout(handle); resolve() }
  const handle = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve() }, ms)
  signal?.addEventListener("abort", onAbort, { once: true })
})
const clock = {
  now: skewed,
  sleep,
  setTimeout: (callback: () => void, ms: number): unknown => setTimeout(callback, ms),
  clearTimeout: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

let stopping = false
let cutoffMs = Number.POSITIVE_INFINITY
const report = (message: Record<string, unknown>): void => { process.send?.(message) }
process.on("message", (message: { cmd?: string; cutoff?: number }) => {
  if (message.cmd === "stop") stopping = true
  if (message.cmd === "cutoff" && typeof message.cutoff === "number") cutoffMs = message.cutoff
})

async function loop(source: string, idleMs: number, tick: () => Promise<number>): Promise<void> {
  while (!stopping) {
    let worked = 0
    try { worked = await tick() } catch (error) { report({ type: "error", source, message: String((error as Error)?.message ?? error).slice(0, 300) }) }
    if (worked === 0) await sleep(idleMs + Math.floor(Math.random() * idleMs * 0.5))
  }
}

const loops = [
  loop("jobs", 150, async () => {
    const result = await dispatchDueJobs({ store: connection.jobStore, registry: jobRegistry, workerId, leaseDurationMs: leaseMs, claimLimit: 3, requester: { scope: "system" }, clock })
    for (const error of result.errors) report({ type: "dispatch-error", source: "jobs", message: `${error.action}: ${error.error}`.slice(0, 300) })
    return result.claimed
  }),
  loop("schedules", 600, async () => {
    const now = new Date(Math.min(skewed().getTime(), cutoffMs))
    const result = await materializeDueSchedules({ scheduleStore: connection.scheduleStore, jobStore: connection.jobStore, workerId, limit: 5, now, leaseDurationMs: leaseMs, maxQueueAllOccurrences: 50, decodePayload: (input) => input as Record<string, unknown> })
    for (const error of result.errors) report({ type: "dispatch-error", source: "schedules", message: error.slice(0, 300) })
    return result.schedulesProcessed
  }),
  loop("workflows", 200, async () => {
    const result = await dispatchWorkflows({ store: connection.workflowStore, registry: workflowRegistry, workerId, claimLimit: 3, concurrency: 2, leaseDurationMs: leaseMs, clock })
    return result.claimed
  }),
]
report({ type: "ready" })
await Promise.all(loops)
await connection.close()
process.exit(0)
