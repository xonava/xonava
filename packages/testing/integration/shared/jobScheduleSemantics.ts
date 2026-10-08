import { expect } from "vitest"
import { createJobRegistry, dispatchDueJobs, JOB_MAX_ATTEMPTS_FROM_DEFINITION, materializeDueSchedules, type JobRequester, type JobStore, type ScheduleStore } from "core/execution"

const system = { kind: "system", systemKey: "framework" } as const
const requester: JobRequester = { scope: "system" }

/**
 * A job enqueued without maxAttempts uses its definition's budget: the store
 * persists the definition sentinel (no schema change) and the dispatcher
 * applies JobDefinition.maxAttempts.
 */
export async function assertDefinitionMaxAttempts(store: JobStore, readStoredMaxAttempts: (jobId: string) => Promise<number>): Promise<void> {
  const runAt = new Date(Date.now() - 1_000)
  const implicit = await store.enqueue({ requester, job: { executionScope: system, jobType: "budget.job", jobVersion: 1, payload: {}, runAt } })
  expect(implicit.maxAttempts).toBeUndefined()
  expect(await readStoredMaxAttempts(implicit.id)).toBe(JOB_MAX_ATTEMPTS_FROM_DEFINITION)
  const explicit = await store.enqueue({ requester, job: { executionScope: system, jobType: "budget.explicit", jobVersion: 1, payload: {}, runAt, maxAttempts: 4 } })
  expect(explicit.maxAttempts).toBe(4)
  expect((await store.getById({ id: explicit.id, requester }))?.maxAttempts).toBe(4)
  expect(await store.cancel({ jobId: explicit.id, requester })).toMatchObject({ applied: true })

  const registry = createJobRegistry()
  registry.register({ type: "budget.job", version: 1, scope: "system", maxAttempts: 1, retryDelayMs: 0, retryBackoffMultiplier: 1, decodePayload: (input) => input as Record<string, unknown>, execute: async () => ({ success: false }) })
  const result = await dispatchDueJobs({ store, registry, workerId: "budget-worker", leaseDurationMs: 30_000, claimLimit: 10, requester })
  expect(result).toMatchObject({ claimed: 1, deadLettered: 1, retried: 0 })
  expect((await store.getById({ id: implicit.id, requester }))?.status).toBe("dead_letter")
}

export interface ScheduleRowInput {
  id: string
  payload: Record<string, unknown>
  cronExpression: string
  misfirePolicy: "skip" | "fire_now" | "queue_all"
  nextRunAt: Date
  remainingOccurrences: number | null
}

export interface ScheduleRowState { nextRunAt: Date; lastStatus: string | null; lastError: string | null; remainingOccurrences: number | null }

/**
 * remainingOccurrences caps catch-up and is decremented by the occurrences
 * actually fired; a failing schedule backs off (keeping its occurrence) so it
 * cannot starve healthy schedules that sort after it.
 */
export async function assertScheduleOccurrencesAndBackoff(args: {
  scheduleStore: ScheduleStore
  jobStore: JobStore
  insertSchedule(row: ScheduleRowInput): Promise<void>
  readSchedule(id: string): Promise<ScheduleRowState>
  prefix: string
}): Promise<void> {
  const { scheduleStore, jobStore, prefix } = args
  const now = new Date()
  const boundary = new Date(Math.floor(now.getTime() / 300_000) * 300_000 - 30 * 60_000)
  const decodePayload = (input: unknown): Record<string, unknown> => {
    if ((input as { poison?: unknown }).poison === true) throw new Error("poison payload")
    return input as Record<string, unknown>
  }
  const materialize = (limit: number) => materializeDueSchedules({ scheduleStore, jobStore, workerId: `${prefix}-materializer`, limit, now: new Date(), decodePayload })

  // Catch-up never exceeds remainingOccurrences, and the store subtracts every fired occurrence.
  const capped = `${prefix}-capped`
  await args.insertSchedule({ id: capped, payload: {}, cronExpression: "*/5 * * * *", misfirePolicy: "queue_all", nextRunAt: boundary, remainingOccurrences: 2 })
  await expect(materialize(10)).resolves.toMatchObject({ jobsEnqueued: 2, errors: [] })
  expect(await args.readSchedule(capped)).toMatchObject({ lastStatus: "fired", remainingOccurrences: 0 })
  const many = `${prefix}-many`
  await args.insertSchedule({ id: many, payload: {}, cronExpression: "*/5 * * * *", misfirePolicy: "queue_all", nextRunAt: boundary, remainingOccurrences: 100 })
  const fired = await materialize(10)
  expect(fired.jobsEnqueued).toBeGreaterThanOrEqual(6)
  expect((await args.readSchedule(many)).remainingOccurrences).toBe(100 - fired.jobsEnqueued)

  // A poison schedule (due first) backs off; the next tick reaches the healthy one.
  const poison = `${prefix}-poison`
  const healthy = `${prefix}-healthy`
  const poisonDue = new Date(boundary.getTime() - 3_600_000)
  await args.insertSchedule({ id: poison, payload: { poison: true }, cronExpression: "0 * * * *", misfirePolicy: "fire_now", nextRunAt: poisonDue, remainingOccurrences: null })
  await args.insertSchedule({ id: healthy, payload: {}, cronExpression: "0 * * * *", misfirePolicy: "fire_now", nextRunAt: new Date(now.getTime() - 60_000), remainingOccurrences: null })
  await expect(materialize(1)).resolves.toMatchObject({ errors: ["poison payload"] })
  expect(await args.readSchedule(poison)).toMatchObject({ lastStatus: "failed", lastError: "poison payload", nextRunAt: poisonDue })
  await expect(materialize(1)).resolves.toMatchObject({ schedulesProcessed: 1, jobsEnqueued: 1, errors: [] })
  expect((await args.readSchedule(healthy)).lastStatus).toBe("fired")
  expect((await args.readSchedule(poison)).lastStatus).toBe("failed")
}
