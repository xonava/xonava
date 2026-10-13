/**
 * Deterministic scenarios that accompany the schedule store differential: each pins one finding of the random
 * differential (or one property that needs real elapsed time or a second store configuration) so it fails on its own
 * when the store regresses. Shared by the PostgreSQL, MySQL and D1 suites.
 */
import { expect } from "vitest"
import { materializeDueSchedules, type JobStore, type ScheduleStore } from "core/execution"
import { clearRows, insertRow, readRows, updateRow, type RefRow, type ScheduleDriver } from "./scheduleStoreDifferential.js"

const T0 = Date.UTC(2031, 0, 1)

export function scheduleRow(id: string, overrides: Partial<RefRow> = {}): RefRow {
  return {
    id, scope: "system", tenantId: null, jobType: "sched.job", jobVersion: 1, payload: "{}", cronExpression: "*/5 * * * *", timezone: "UTC",
    enabled: true, paused: false, overlapPolicy: "allow", misfirePolicy: "fire_now", nextRunAt: T0 - 60_000, lastRunAt: null, lastStatus: null,
    lastError: null, leaseOwner: null, claimToken: null, leaseAt: null, effectiveFrom: null, effectiveUntil: null, remaining: null,
    calendarKey: null, owner: null, description: null, ...overrides,
  }
}

const claimArgs = (workerId: string, limit: number, now: number, leaseDurationMs = 600_000) => ({ workerId, limit, now: new Date(now), leaseDurationMs })
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * A schedule held by a live claim is not claimable, so it must not use up a slot of another worker's claim limit:
 * with the oldest due schedule held, a worker asking for one schedule still receives the next due one.
 */
export async function assertLiveClaimsDoNotConsumeClaimLimit(driver: ScheduleDriver): Promise<void> {
  await clearRows(driver)
  await insertRow(driver, scheduleRow("held-first", { nextRunAt: T0 - 5_000 }))
  await insertRow(driver, scheduleRow("due-second", { nextRunAt: T0 - 4_000 }))
  await insertRow(driver, scheduleRow("due-third", { nextRunAt: T0 - 3_000 }))
  const first = await driver.store.claimDueSchedules(claimArgs("worker-1", 1, T0))
  expect(first.map((claim) => claim.scheduleId)).toEqual(["held-first"])
  const second = await driver.store.claimDueSchedules(claimArgs("worker-2", 1, T0))
  expect(second.map((claim) => claim.scheduleId), "worker-2 skips the schedule worker-1 holds").toEqual(["due-second"])
  const third = await driver.store.claimDueSchedules(claimArgs("worker-3", 5, T0))
  expect(third.map((claim) => claim.scheduleId)).toEqual(["due-third"])
  await clearRows(driver)
}

/** Renewal verifies the fence and moves the lease expiry forward; a smaller extension never shortens a lease. */
export async function assertRenewalNeverShortensLease(driver: ScheduleDriver): Promise<void> {
  await clearRows(driver)
  await insertRow(driver, scheduleRow("renewed"))
  const [claim] = await driver.store.claimDueSchedules(claimArgs("worker-1", 1, T0, 600_000))
  const fence = { scheduleId: "renewed", workerId: "worker-1", claimToken: claim!.claimToken }
  const leaseOf = async () => (await readRows(driver)).get("renewed")!.leaseAt!
  const claimed = await leaseOf()
  expect(claimed - Date.now()).toBeGreaterThan(590_000)
  await expect(driver.store.renewScheduleLease({ ...fence, now: new Date(), extendByMs: 1_000 })).resolves.toBe(true)
  expect(await leaseOf(), "a renewal with a smaller extension keeps the longer lease").toBeGreaterThanOrEqual(claimed)
  await expect(driver.store.renewScheduleLease({ ...fence, now: new Date(), extendByMs: 1_200_000 })).resolves.toBe(true)
  expect(await leaseOf() - Date.now(), "a larger extension moves the lease forward").toBeGreaterThan(1_190_000)
  await clearRows(driver)
}

/** Without `now`, claimDueSchedules uses the real clock for due-ness. */
export async function assertClaimWithoutNowUsesTheClock(driver: ScheduleDriver): Promise<void> {
  await clearRows(driver)
  const now = Date.now()
  await insertRow(driver, scheduleRow("past", { nextRunAt: now - 60_000 }))
  await insertRow(driver, scheduleRow("future", { nextRunAt: now + 3_600_000 }))
  const claims = await driver.store.claimDueSchedules({ workerId: "clock-worker", limit: 10, leaseDurationMs: 60_000 })
  expect(claims.map((claim) => claim.scheduleId)).toEqual(["past"])
  await clearRows(driver)
}

/**
 * Real elapsed-lease expiry on the database clock: a lease that runs out is reclaimable, the claim reports the lease
 * marker `running` as the pre-claim status, and the old owner's token is fenced out everywhere. Liveness is checked on
 * a ten-minute lease, so no assertion depends on a short lease still being live when a slow machine gets to it; the
 * lease is then rewritten to run out shortly and only the lapse is waited for, by polling until it is a full second
 * in the past (never a fixed sleep), so the wait cannot end early however loaded the machine is.
 */
export async function assertElapsedLeaseExpiryFencesOldOwner(driver: ScheduleDriver): Promise<void> {
  await clearRows(driver)
  await insertRow(driver, scheduleRow("short", { lastStatus: "fired" }))
  const [old] = await driver.store.claimDueSchedules(claimArgs("old-owner", 1, T0))
  expect(old!.lastStatus).toBe("fired")
  const fence = { scheduleId: "short", workerId: "old-owner", claimToken: old!.claimToken }
  await expect(driver.store.renewScheduleLease({ ...fence, now: new Date(), extendByMs: 400 })).resolves.toBe(true)
  await expect(driver.store.claimDueSchedules(claimArgs("new-owner", 1, T0)), "a live lease is not claimable").resolves.toEqual([])
  const runsOutAt = Date.now() + 200
  await updateRow(driver, "short", { leaseAt: runsOutAt })
  const deadline = Date.now() + 60_000
  while (Date.now() < runsOutAt + 1_000) {
    if (Date.now() > deadline) throw new Error("the lease did not run out within 60 s")
    await sleep(25)
  }
  const advance = { ...fence, nextRunAt: new Date(T0 + 300_000), lastRunAt: new Date(T0), lastStatus: "fired" }
  await expect(driver.store.renewScheduleLease({ ...fence, now: new Date(), extendByMs: 60_000 }), "an expired lease cannot be renewed").resolves.toBe(false)
  const [fresh] = await driver.store.claimDueSchedules(claimArgs("new-owner", 1, T0))
  expect(fresh!.scheduleId).toBe("short")
  expect(fresh!.lastStatus, "the claim reports the pre-claim status, which after a lapsed lease is the lease marker").toBe("running")
  expect(fresh!.claimToken).not.toBe(old!.claimToken)
  await expect(driver.store.advanceSchedule(advance)).resolves.toBe(false)
  await expect(driver.store.releaseSchedule(fence)).resolves.toBe(false)
  await expect(driver.store.renewScheduleLease({ ...fence, now: new Date(), extendByMs: 60_000 })).resolves.toBe(false)
  const row = (await readRows(driver)).get("short")!
  expect([row.lastStatus, row.leaseOwner, row.claimToken]).toEqual(["running", "new-owner", fresh!.claimToken])
  await expect(driver.store.advanceSchedule({ scheduleId: "short", workerId: "new-owner", claimToken: fresh!.claimToken, nextRunAt: new Date(T0 + 300_000), lastRunAt: new Date(T0), lastStatus: "fired", occurrencesFired: 1 })).resolves.toBe(true)
  await clearRows(driver)
}

/** Tenant timezone resolution: tenant claims take the resolver's zone, others keep the stored zone (stores with a resolver option). */
export async function assertTenantTimezoneResolution(driver: ScheduleDriver, resolving: ScheduleStore): Promise<void> {
  await clearRows(driver)
  await insertRow(driver, scheduleRow("tenant-resolved", { scope: "tenant", tenantId: "tenant-1", timezone: "UTC", nextRunAt: T0 - 5_000 }))
  await insertRow(driver, scheduleRow("tenant-unknown", { scope: "tenant", tenantId: "tenant-unknown", timezone: "Asia/Tokyo", nextRunAt: T0 - 4_000 }))
  await insertRow(driver, scheduleRow("platform-row", { scope: "platform", timezone: "Europe/Paris", nextRunAt: T0 - 3_000 }))
  const claims = await resolving.claimDueSchedules(claimArgs("tz-worker", 10, T0))
  expect(Object.fromEntries(claims.map((claim) => [claim.scheduleId, claim.timezone]))).toEqual({ "tenant-resolved": "America/Chicago", "tenant-unknown": "Asia/Tokyo", "platform-row": "Europe/Paris" })
  await clearRows(driver)
}

/** Advancing with a null nextRunAt (a cron with no future occurrence) must settle the claim and retire the schedule. */
export async function assertNullNextRunAtRetiresSchedule(driver: ScheduleDriver): Promise<void> {
  await clearRows(driver)
  await insertRow(driver, scheduleRow("finished"))
  const [claim] = await driver.store.claimDueSchedules(claimArgs("worker-1", 1, T0))
  await expect(driver.store.advanceSchedule({ scheduleId: "finished", workerId: "worker-1", claimToken: claim!.claimToken, nextRunAt: null, lastRunAt: new Date(T0), lastStatus: "skipped" })).resolves.toBe(true)
  expect((await readRows(driver)).get("finished")).toMatchObject({ nextRunAt: null, lastStatus: "skipped", leaseOwner: null, claimToken: null })
  await expect(driver.store.claimDueSchedules(claimArgs("worker-2", 10, T0 + 10 * 365 * 86_400_000))).resolves.toEqual([])
  await clearRows(driver)
}

// ---------------------------------------------------------------------------------------------------------------------
// Real core dispatcher over the real schedule store and the real job store

export interface DispatcherHarness {
  driver: ScheduleDriver
  jobStore: JobStore
  /** Idempotency keys of every stored job, one entry per stored row. */
  jobKeys(): Promise<string[]>
  clearJobs(): Promise<void>
}

const decodePayload = (input: unknown): Record<string, unknown> => input as Record<string, unknown>
const NOW = T0 + 32 * 60_000
const ALIGNED = T0

/**
 * materializeDueSchedules against the real stores: concurrent workers enqueue every occurrence exactly once, a re-run
 * enqueues nothing more, and a crashed claim (partial enqueue, no advance) is completed by the next worker without
 * duplicates or double-counted occurrences.
 */
export async function assertDispatcherEnqueuesEachOccurrenceOnce(h: DispatcherHarness): Promise<void> {
  const { driver, jobStore } = h
  const materialize = (workerId: string, now: Date, store: JobStore = jobStore) => materializeDueSchedules({ scheduleStore: driver.store, jobStore: store, workerId, limit: 20, now, decodePayload, leaseDurationMs: 60_000, maxQueueAllOccurrences: 50 })

  // 1. Concurrent workers over several backlogged queue_all schedules.
  await clearRows(driver); await h.clearJobs()
  for (const [index, id] of ["q-a", "q-b", "q-c"].entries()) await insertRow(driver, scheduleRow(id, { misfirePolicy: "queue_all", nextRunAt: ALIGNED + index * 1_000 - 0, remaining: index === 2 ? 4 : null, payload: `{"n":${index}}` }))
  const results = await Promise.all(["w1", "w2", "w3", "w4"].map((worker) => materialize(worker, new Date(NOW + 60_000))))
  expect(results.flatMap((result) => result.errors)).toEqual([])
  const keys = await h.jobKeys()
  expect(new Set(keys).size, "every occurrence is enqueued once").toBe(keys.length)
  expect(results.reduce((sum, result) => sum + result.jobsEnqueued, 0)).toBe(keys.length)
  const perSchedule = (id: string) => keys.filter((key) => key.startsWith(`schedule:${id}:`)).length
  expect(perSchedule("q-a")).toBeGreaterThanOrEqual(6)
  expect(perSchedule("q-b")).toBeGreaterThanOrEqual(6)
  expect(perSchedule("q-c"), "remainingOccurrences caps the backlog").toBe(4)
  const after = await readRows(driver)
  expect(after.get("q-c")).toMatchObject({ remaining: 0, lastStatus: "fired" })
  expect(after.get("q-a")!.nextRunAt!).toBeGreaterThan(NOW)
  expect(after.get("q-a")).toMatchObject({ lastStatus: "fired", leaseOwner: null, claimToken: null })
  const again = await Promise.all(["w1", "w2"].map((worker) => materialize(worker, new Date(NOW + 60_000))))
  expect(again.map((result) => result.jobsEnqueued)).toEqual([0, 0])
  expect((await h.jobKeys()).length).toBe(keys.length)

  // 2. A worker that enqueued part of a backlog and then lost the store is completed by the next one: no duplicates, remaining consumed once.
  await clearRows(driver); await h.clearJobs()
  await insertRow(driver, scheduleRow("crash", { misfirePolicy: "queue_all", nextRunAt: ALIGNED, remaining: 20 }))
  let enqueued = 0
  const flaky = new Proxy(jobStore, {
    get(target, property) {
      if (property === "enqueue") return async (enqueueArgs: Parameters<JobStore["enqueue"]>[0]) => { if (enqueued >= 3) throw new Error("job store went away"); enqueued += 1; return target.enqueue(enqueueArgs) }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
  const crashed = await materialize("crashing", new Date(NOW), flaky)
  expect(crashed.errors).toEqual(["job store went away"])
  expect((await readRows(driver)).get("crash")).toMatchObject({ lastStatus: "failed", remaining: 20, leaseOwner: null })
  expect(await h.jobKeys()).toHaveLength(3)
  expect(await materialize("early", new Date(NOW + 1_000)), "the failure backoff holds the schedule back").toMatchObject({ schedulesProcessed: 0 })
  const resumed = await materialize("resuming", new Date(NOW + 60_000))
  expect(resumed.errors).toEqual([])
  const crashKeys = await h.jobKeys()
  expect(new Set(crashKeys).size).toBe(crashKeys.length)
  expect(crashKeys.length).toBeGreaterThanOrEqual(7)
  expect((await readRows(driver)).get("crash"), "every occurrence consumes one remaining occurrence, including the three enqueued before the crash").toMatchObject({ lastStatus: "fired", remaining: 20 - crashKeys.length })

  // 3. A worker that dies holding a claim: nobody else runs the schedule until the lease lapses, then the claim reports `running` as its pre-claim status and an overlap=skip schedule still fires.
  await clearRows(driver); await h.clearJobs()
  await insertRow(driver, scheduleRow("dies", { overlapPolicy: "skip", nextRunAt: ALIGNED }))
  const [held] = await driver.store.claimDueSchedules(claimArgs("dead-worker", 1, NOW))
  expect(held!.lastStatus).toBeNull()
  expect(await materialize("blocked", new Date(NOW))).toMatchObject({ schedulesProcessed: 0, jobsEnqueued: 0 })
  await updateRow(driver, "dies", { leaseAt: Date.now() - 3_600_000 })
  const taken = await materialize("rescuer", new Date(NOW))
  expect(taken).toMatchObject({ schedulesProcessed: 1, jobsEnqueued: 1, errors: [] })
  expect(await h.jobKeys()).toHaveLength(1)
  await expect(driver.store.advanceSchedule({ scheduleId: "dies", workerId: "dead-worker", claimToken: held!.claimToken, nextRunAt: new Date(NOW), lastRunAt: new Date(NOW), lastStatus: "fired" })).resolves.toBe(false)
  await clearRows(driver); await h.clearJobs()
}
