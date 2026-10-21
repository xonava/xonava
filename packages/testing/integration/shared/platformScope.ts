import { expect } from "vitest"
import { z } from "zod"
import { CRUD } from "@xonava/adapters/http"
import { Predicate, TenantScopeViolationError, type ExecutionScope } from "@xonava/core/domain"
import { defineEntity } from "@xonava/core/entity"
import {
  createJobRegistry,
  dispatchDueJobs,
  materializeDueSchedules,
  type JobExecutionContext,
  type JobExecutionScope,
  type JobRequester,
  type JobStore,
  type ScheduleStore,
} from "@xonava/core/execution"
import { createTenantScopedPersistenceProvider, type PersistenceProvider, type VersionedEntityDescriptor } from "@xonava/core/persistence"
import { createWorkflowRegistry, defineWorkflow, dispatchWorkflows, type WorkflowStore } from "@xonava/core/workflow"
import { allowAllAbacBundle, allowAllModuleFacts, canonicalRequestNormalization, trustedSession } from "../../../adapters/src/http/__tests__/canonicalRequest.js"
import { announcements, createAnnouncementHandlers, type Announcement } from "../../tests/standaloneGuideExample.js"

/**
 * Platform scope end to end on a real database. A platform entity
 * (`entityScope: { kind: "platform", acknowledged: true }`) has no partition
 * column and is served by the unwrapped provider: the adapters never read the
 * entity scope. Isolation comes from the route's fixed scope plan and the
 * optional `scopeFilter` (docs/guides/standalone-application.md).
 *
 * Every runner owns its table names (or schema, or database), so the suite
 * cannot collide with other suites using the same server.
 */

export const ANNOUNCEMENT_COLUMNS = ["id", "title", "region", "priority", "version"] as const
export const platformAnnouncementEntity = announcements.entity as VersionedEntityDescriptor<Announcement>

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
export const announcement = (n: number, overrides: Partial<Announcement> = {}): Announcement => ({
  id: id(n), title: `announcement ${n}`, region: n % 2 === 0 ? "eu" : "us", priority: n, version: 1, ...overrides,
})

/** What a runner can see of the table without the framework. */
export interface PlatformPhysicalProbe {
  /** Column names of the announcements table. */
  columns(): Promise<string[]>
  /** Whether a row with this id physically exists. */
  exists(rowId: string): Promise<boolean>
}

export async function assertNoPartitionColumn(probe: PlatformPhysicalProbe): Promise<void> {
  expect((await probe.columns()).sort()).toEqual([...ANNOUNCEMENT_COLUMNS].sort())
}

/** CRUD, list, query and OCC for a platform entity through an unwrapped provider. */
export async function assertPlatformEntityPersistence(provider: PersistenceProvider, probe: PlatformPhysicalProbe): Promise<void> {
  // A tenant-scoped provider refuses an entity that has no tenant field.
  expect(() => createTenantScopedPersistenceProvider(provider, "tenant-a").repository(platformAnnouncementEntity)).toThrow(TenantScopeViolationError)

  const repository = provider.repository<Announcement>(platformAnnouncementEntity)
  const seeded = [1, 2, 3, 4, 5].map((n) => announcement(n))
  for (const row of seeded) expect(await repository.insert(row)).toMatchObject(row)
  await assertNoPartitionColumn(probe)

  // Read.
  expect(await repository.findById(id(3))).toEqual(announcement(3))
  expect(await repository.findById(id(99))).toBeNull()
  const all = await repository.findMany({ sort: [{ field: "priority", direction: "asc" }], pagination: { kind: "offset", page: 1, pageSize: 100 } })
  expect(all.rows.map((row) => row.priority)).toEqual([1, 2, 3, 4, 5])
  expect(all.rowCount).toBe(5)

  // Query: filter, sort, offset pagination.
  const eu = await repository.findMany({ filter: Predicate.eq("region", "eu"), sort: [{ field: "priority", direction: "desc" }], pagination: { kind: "offset", page: 1, pageSize: 100 } })
  expect(eu.rows.map((row) => row.priority)).toEqual([4, 2])
  const combined = await repository.findMany({ filter: Predicate.and(Predicate.gte("priority", 2), Predicate.neq("region", "eu")), sort: [{ field: "priority", direction: "asc" }], pagination: { kind: "offset", page: 1, pageSize: 100 } })
  expect(combined.rows.map((row) => row.priority)).toEqual([3, 5])
  const secondPage = await repository.findMany({ sort: [{ field: "priority", direction: "desc" }], pagination: { kind: "offset", page: 2, pageSize: 2 } })
  expect(secondPage.rows.map((row) => row.priority)).toEqual([3, 2])
  expect((await repository.findOneWhere!(Predicate.eq("priority", 4)))?.id).toBe(id(4))
  expect(await repository.findOneWhere!(Predicate.eq("priority", 40))).toBeNull()

  // OCC: update.
  const updated = await repository.update(id(1), { title: "renamed" }, { optimisticConcurrency: { expectedVersion: 1 } })
  expect(updated).toMatchObject({ id: id(1), title: "renamed", version: 2 })
  await expect(repository.update(id(1), { title: "stale" }, { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toMatchObject({ code: "OPTIMISTIC_CONCURRENCY_FAILED" })
  expect((await repository.findById(id(1)))?.title).toBe("renamed")

  // OCC: two writers with the same expected version, exactly one wins.
  const race = await Promise.allSettled([
    repository.update(id(2), { title: "writer-a" }, { optimisticConcurrency: { expectedVersion: 1 } }),
    repository.update(id(2), { title: "writer-b" }, { optimisticConcurrency: { expectedVersion: 1 } }),
  ])
  expect(race.filter((entry) => entry.status === "fulfilled")).toHaveLength(1)
  const loser = race.find((entry) => entry.status === "rejected") as PromiseRejectedResult
  expect(loser.reason).toMatchObject({ code: "OPTIMISTIC_CONCURRENCY_FAILED" })
  expect((await repository.findById(id(2)))?.version).toBe(2)

  // OCC: delete.
  // A stale delete is refused and leaves the row; dialects report it as a conflict or as not found.
  await expect(repository.delete(id(1), { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toMatchObject({ code: expect.stringMatching(/^(OPTIMISTIC_CONCURRENCY_FAILED|NOT_FOUND)$/) })
  expect(await probe.exists(id(1))).toBe(true)
  await repository.delete(id(1), { optimisticConcurrency: { expectedVersion: 2 } })
  expect(await probe.exists(id(1))).toBe(false)
  expect(await repository.findById(id(1))).toBeNull()
  expect((await repository.findMany({ pagination: { kind: "offset", page: 1, pageSize: 100 } })).rowCount).toBe(4)
}

// ---------------------------------------------------------------------------
// HTTP: a fixed platform scope plan through createCrudHandlers.
// ---------------------------------------------------------------------------

const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => new Request(`https://app.test${path}`, {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers: { "content-type": "application/json", ...headers },
})
const params = (rowId: string) => ({ params: Promise.resolve({ id: rowId }) })
const listIds = async (response: Response) => {
  const payload = await response.json() as { data?: Array<{ id: string }>; rows?: Array<{ id: string }> }
  return (payload.data ?? payload.rows ?? []).map((row) => row.id).sort()
}

/** The same entity restricted by a `scopeFilter`: only region "eu" is reachable through it. */
const euBody = z.object({ title: z.string().min(1), region: z.string().min(1), priority: z.number().int() }).strict()
const euPatch = euBody.partial()
export const euAnnouncements = defineEntity<Announcement, z.infer<typeof euBody>, z.infer<typeof euPatch>, Announcement, Announcement>({
  moduleKey: announcements.moduleKey,
  entity: announcements.entity,
  entityScope: { kind: "platform", acknowledged: true, scopeFilter: Predicate.eq("region", "eu") },
  policy: { skipCapabilityCheck: true },
  cache: false,
  audit: false,
  validation: { idParams: z.object({ id: z.string().uuid() }).strict(), createBody: euBody, updateBody: euPatch },
})

/** The guide's entity without its capability key, for the canonical allow-all test bundle. */
const unfilteredAnnouncements = defineEntity<Announcement, z.infer<typeof euBody>, z.infer<typeof euPatch>, Announcement, Announcement>({
  moduleKey: announcements.moduleKey,
  entity: announcements.entity,
  entityScope: { kind: "platform", acknowledged: true },
  policy: { skipCapabilityCheck: true },
  cache: false,
  audit: false,
  validation: { idParams: z.object({ id: z.string().uuid() }).strict(), createBody: euBody, updateBody: euPatch },
})

/**
 * Drives the guide's handlers (a fixed platform scope plan) against a real
 * repository. Starts from an empty table.
 */
export async function assertPlatformHttp(provider: PersistenceProvider, probe: PlatformPhysicalProbe): Promise<void> {
  const runtime = { createPersistence: () => provider, getCacheAdapter: async () => ({}) as never }
  const staff = createAnnouncementHandlers(runtime, async () => ({ userId: "staff-1", sessionId: "s1" }))

  // Create, read, list.
  const created = await staff.create(json("POST", "/announcements", { title: "maintenance", region: "eu", priority: 7 }))
  expect(created.status, await created.clone().text()).toBe(201)
  // On interactive-transaction databases the create response is an acknowledgement without the row (the
  // post-write read runs outside the transaction), so the row is located through the repository.
  const createdBody = await created.json() as { data?: Announcement } & Partial<Announcement>
  const returned = (createdBody.data ?? createdBody) as Partial<Announcement>
  const stored = (await provider.repository<Announcement>(platformAnnouncementEntity).findMany({ filter: Predicate.eq("title", "maintenance"), pagination: { kind: "offset", page: 1, pageSize: 10 } })).rows
  expect(stored).toHaveLength(1)
  const row = stored[0]!
  expect(row).toMatchObject({ title: "maintenance", region: "eu", priority: 7, version: 1 })
  if (returned.id !== undefined) expect(returned.id).toBe(row.id)
  expect(await probe.exists(row.id)).toBe(true)
  const detail = await staff.detail(json("GET", `/announcements/${row.id}`), { id: row.id })
  expect(detail.status, await detail.clone().text()).toBe(200)
  expect(await listIds(await staff.list(json("GET", "/announcements")))).toEqual([row.id])

  // The fixed scope plan ignores caller-supplied scope hints.
  const hinted = await staff.list(json("GET", "/announcements?platformKey=other&scope=tenant", undefined, { "x-platform-key": "other", "x-tenant-id": "tenant-a" }))
  expect(hinted.status).toBe(200)
  expect(await listIds(hinted)).toEqual([row.id])

  // OCC over HTTP.
  const patched = await staff.update(json("PATCH", `/announcements/${row.id}`, { title: "maintenance window" }, { "if-match": "1" }), params(row.id))
  expect(patched.status, await patched.clone().text()).toBe(200)
  const stale = await staff.update(json("PATCH", `/announcements/${row.id}`, { title: "stale" }, { "if-match": "1" }), params(row.id))
  expect(stale.status).toBe(409)
  const unconditional = await staff.update(json("PATCH", `/announcements/${row.id}`, { title: "no precondition" }), params(row.id))
  expect(unconditional.status).toBeGreaterThanOrEqual(400)
  expect((await provider.repository<Announcement>(platformAnnouncementEntity).findById(row.id))?.title).toBe("maintenance window")
  const protectedWrite = await staff.update(json("PATCH", `/announcements/${row.id}`, { version: 40 }, { "if-match": "2" }), params(row.id))
  expect(protectedWrite.status).toBeGreaterThanOrEqual(400)

  // Delete.
  expect((await staff.delete(json("DELETE", `/announcements/${row.id}`, undefined, { "if-match": "1" }), params(row.id))).status).toBe(409)
  expect(await probe.exists(row.id)).toBe(true)
  expect((await staff.delete(json("DELETE", `/announcements/${row.id}`, undefined, { "if-match": "2" }), params(row.id))).status).toBeLessThan(300)
  expect(await probe.exists(row.id)).toBe(false)
  expect((await staff.detail(json("GET", `/announcements/${row.id}`), { id: row.id })).status).toBe(404)

  // No login: nothing is served or written.
  const anonymous = createAnnouncementHandlers(runtime, async () => undefined)
  expect((await anonymous.list(json("GET", "/announcements"))).status).toBe(401)
  expect((await anonymous.create(json("POST", "/announcements", { title: "x", region: "eu", priority: 1 }))).status).toBe(401)

  // scopeFilter: only region "eu" is reachable; the other rows are untouched.
  const repository = provider.repository<Announcement>(platformAnnouncementEntity)
  const euRow = announcement(10, { region: "eu" })
  const usRow = announcement(11, { region: "us" })
  await repository.insert(euRow)
  await repository.insert(usRow)
  const filtered = CRUD(euAnnouncements, {
    adapterDeps: { assertValidCsrf: () => undefined, resolveModuleAuthorizationFacts: allowAllModuleFacts, resolveAbacBundle: async ({ moduleKey }) => allowAllAbacBundle(moduleKey) },
    requestNormalization: canonicalRequestNormalization(trustedSession({ kind: "platform", platformKey: "default" }), "app.announcements"),
    scope: { scope: "platform", idempotency: { required: false } },
    createPersistence: runtime.createPersistence,
    getCacheAdapter: runtime.getCacheAdapter,
  })
  expect(await listIds(await filtered.list(json("GET", "/announcements")))).toEqual([euRow.id])
  expect((await filtered.detail(json("GET", `/announcements/${euRow.id}`), { id: euRow.id })).status).toBe(200)
  expect((await filtered.detail(json("GET", `/announcements/${usRow.id}`), { id: usRow.id })).status).toBe(404)
  expect((await filtered.update(json("PATCH", `/announcements/${usRow.id}`, { title: "hijack" }, { "if-match": "1" }), params(usRow.id))).status).toBe(404)
  expect((await filtered.delete(json("DELETE", `/announcements/${usRow.id}`, undefined, { "if-match": "1" }), params(usRow.id))).status).toBe(404)
  expect(await repository.findById(usRow.id)).toEqual(usRow)
  await repository.delete(euRow.id, { optimisticConcurrency: { expectedVersion: 1 } })
  await repository.delete(usRow.id, { optimisticConcurrency: { expectedVersion: 1 } })

  // Current rule (assertEntityScopeContext): a platform entity is reachable from a platform or system route.
  const fromSystem = CRUD(unfilteredAnnouncements, {
    adapterDeps: { assertValidCsrf: () => undefined, resolveModuleAuthorizationFacts: allowAllModuleFacts, resolveAbacBundle: async ({ moduleKey }) => allowAllAbacBundle(moduleKey) },
    requestNormalization: canonicalRequestNormalization(trustedSession({ kind: "system", systemKey: "framework" }), "app.announcements"),
    scope: { scope: "system", idempotency: { required: false } },
    createPersistence: runtime.createPersistence,
    getCacheAdapter: runtime.getCacheAdapter,
  })
  expect((await fromSystem.list(json("GET", "/announcements"))).status).toBe(200)
}

// ---------------------------------------------------------------------------
// Jobs, schedules and workflows under platform and system scope.
// ---------------------------------------------------------------------------

/** Job and schedule stores persist the scope kind only; they read back with these keys. */
export const PLATFORM_JOB_SCOPE: JobExecutionScope = { kind: "platform", platformKey: "default" }
export const SYSTEM_JOB_SCOPE: JobExecutionScope = { kind: "system", systemKey: "framework" }
const PLATFORM_REQUESTER: JobRequester = { scope: "platform", actorId: "ops-1", capabilities: ["enqueue:platform"] }
const SYSTEM_REQUESTER: JobRequester = { scope: "system" }
const SCOPES = [
  { name: "platform", scope: PLATFORM_JOB_SCOPE, requester: PLATFORM_REQUESTER, other: SYSTEM_REQUESTER },
  { name: "system", scope: SYSTEM_JOB_SCOPE, requester: SYSTEM_REQUESTER, other: PLATFORM_REQUESTER },
] as const

export interface ScheduleRowFixture {
  id: string
  scope: "platform" | "system"
  nextRunAt: Date
}

/** A platform or system job is enqueued, claimed and run under its own scope and is invisible to the other requester. */
export async function assertJobsUnderScope(jobStore: JobStore, prefix: string): Promise<void> {
  for (const { name, scope, requester, other } of SCOPES) {
    const type = `${prefix}.${name}.job`
    const seen: JobExecutionContext[] = []
    const registry = createJobRegistry()
    registry.register({
      type, version: 1, scope: name, maxAttempts: 1, retryDelayMs: 0, retryBackoffMultiplier: 1,
      decodePayload: (input) => input as Record<string, unknown>,
      execute: async (execution) => { seen.push(execution); return { success: true } },
    })
    const runAt = new Date(Date.now() - 1_000)
    const enqueued = await jobStore.enqueue({ requester, job: { executionScope: scope, jobType: type, jobVersion: 1, payload: { n: 1 }, runAt, idempotencyKey: `${prefix}-${name}-1` } })
    expect(enqueued).toMatchObject({ scope: name, tenantId: null, executionScope: scope, status: "pending" })
    expect(await jobStore.getById({ id: enqueued.id, requester })).toMatchObject({ id: enqueued.id, executionScope: scope })

    // Same idempotency key in the same scope returns the same job.
    const again = await jobStore.enqueue({ requester, job: { executionScope: scope, jobType: type, jobVersion: 1, payload: { n: 1 }, runAt, idempotencyKey: `${prefix}-${name}-1` } })
    expect(again.id).toBe(enqueued.id)

    // The other scope's dispatcher does not claim it.
    expect(await jobStore.findPending({ requester: other, jobType: type })).toEqual([])
    expect((await jobStore.findPending({ requester, jobType: type })).map((job) => job.id)).toEqual([enqueued.id])

    const result = await dispatchDueJobs({ store: jobStore, registry, workerId: `${prefix}-${name}-worker`, leaseDurationMs: 30_000, claimLimit: 10, requester })
    expect(result).toMatchObject({ claimed: 1 })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ jobId: enqueued.id, tenantId: null, executionScope: scope, payload: { n: 1 } })
    expect((await jobStore.getById({ id: enqueued.id, requester }))?.status).toBe("succeeded")
  }

  // A definition for the other scope never runs the job.
  const mismatchType = `${prefix}.mismatch.job`
  const mismatchRegistry = createJobRegistry()
  mismatchRegistry.register({ type: mismatchType, version: 1, scope: "system", maxAttempts: 1, retryDelayMs: 0, retryBackoffMultiplier: 1, decodePayload: (input) => input as Record<string, unknown>, execute: async () => ({ success: true }) })
  const mismatched = await jobStore.enqueue({ requester: PLATFORM_REQUESTER, job: { executionScope: PLATFORM_JOB_SCOPE, jobType: mismatchType, jobVersion: 1, payload: {}, runAt: new Date(Date.now() - 1_000) } })
  await dispatchDueJobs({ store: jobStore, registry: mismatchRegistry, workerId: `${prefix}-mismatch-worker`, leaseDurationMs: 30_000, claimLimit: 10, requester: PLATFORM_REQUESTER })
  expect(["dead_letter", "failed"]).toContain((await jobStore.getById({ id: mismatched.id, requester: PLATFORM_REQUESTER }))?.status)
}

/** A schedule row of each scope materializes jobs of that scope, which then run. */
export async function assertSchedulesUnderScope(args: {
  scheduleStore: ScheduleStore
  jobStore: JobStore
  insertSchedule(row: ScheduleRowFixture & { jobType: string }): Promise<void>
  readSchedule(scheduleId: string): Promise<{ lastStatus: string | null; nextRunAt: Date }>
  prefix: string
}): Promise<void> {
  const { scheduleStore, jobStore, prefix } = args
  for (const { name, scope, requester } of SCOPES) {
    const scheduleId = `${prefix}-${name}-schedule`
    const jobType = `${prefix}.${name}.scheduled`
    const due = new Date(Date.now() - 60_000)
    await args.insertSchedule({ id: scheduleId, scope: name, nextRunAt: due, jobType })
    const result = await materializeDueSchedules({ scheduleStore, jobStore, workerId: `${prefix}-${name}-materializer`, limit: 100, now: new Date() })
    expect(result).toMatchObject({ errors: [] })
    expect(result.jobsEnqueued).toBeGreaterThanOrEqual(1)
    expect(await args.readSchedule(scheduleId)).toMatchObject({ lastStatus: "fired" })

    const pending = await jobStore.findPending({ requester, jobType })
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ scope: name, tenantId: null, executionScope: scope, correlationId: `sched:${scheduleId}` })

    const seen: JobExecutionContext[] = []
    const registry = createJobRegistry()
    registry.register({ type: jobType, version: 1, scope: name, maxAttempts: 1, retryDelayMs: 0, retryBackoffMultiplier: 1, decodePayload: (input) => input as Record<string, unknown>, execute: async (execution) => { seen.push(execution); return { success: true } } })
    await dispatchDueJobs({ store: jobStore, registry, workerId: `${prefix}-${name}-runner`, leaseDurationMs: 30_000, claimLimit: 10, requester })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ executionScope: scope, tenantId: null })
  }
}

/**
 * KNOWN BUG (separate work package): job and schedule stores persist the scope
 * kind only, so `platformKey` / `systemKey` are replaced by "default" /
 * "framework" on read (drizzle-shared/jobScope.ts). These assertions describe
 * the correct behaviour and fail today; runners wrap them in `it.fails`.
 */
export async function assertJobScopeKeysSurviveRoundTrip(jobStore: JobStore, prefix: string): Promise<void> {
  const platform: ExecutionScope = { kind: "platform", platformKey: "ops-east" }
  const stored = await jobStore.enqueue({ requester: PLATFORM_REQUESTER, job: { executionScope: platform as JobExecutionScope, jobType: `${prefix}.keys`, jobVersion: 1, payload: {}, runAt: new Date() } })
  expect((await jobStore.getById({ id: stored.id, requester: PLATFORM_REQUESTER }))?.executionScope).toEqual(platform)
}

/** Workflows persist the whole execution scope, so keys survive and steps see the scope they run under. */
export async function assertWorkflowsUnderScope(store: WorkflowStore, prefix: string): Promise<void> {
  const noRetry = { maxAttempts: 1, initialDelayMs: 10, backoffMultiplier: 2, maxDelayMs: 100, jitter: "none" } as const
  for (const scope of [{ kind: "platform", platformKey: "ops-east" }, { kind: "system", systemKey: "maintenance" }] as const) {
    const type = `${prefix}-${scope.kind}`
    const seen: ExecutionScope[] = []
    const registry = createWorkflowRegistry()
    registry.register(defineWorkflow({
      type, version: 1, initialStep: "prepare", decodeVariables: (value) => value as Record<string, unknown>,
      steps: {
        prepare: { name: "prepare", datasource: "primary", retry: noRetry, execute: async (context) => { seen.push(context.executionScope); return { kind: "next", step: "approve", variables: { prepared: true } } } },
        approve: { name: "approve", datasource: "primary", retry: noRetry, execute: async (context) => { seen.push(context.executionScope); return context.signal ? { kind: "complete", variables: { approved: true } } : { kind: "wait", signal: "approve" } } },
      },
    }))
    const instanceId = `${prefix}-${scope.kind}-1`
    const started = await store.start({ id: instanceId, workflowType: type, workflowVersion: 1, executionScope: scope, initialStep: "prepare", variables: {} })
    expect(started.executionScope).toEqual(scope)
    for (let index = 0; index < 4; index++) {
      await dispatchWorkflows({ store, registry, workerId: `${prefix}-worker`, claimLimit: 100, leaseDurationMs: 30_000 })
      if ((await store.get(instanceId))?.status === "waiting") break
    }
    expect(await store.get(instanceId)).toMatchObject({ status: "waiting", waitingSignal: "approve", executionScope: scope })
    expect(await store.deliverSignal({ id: `${prefix}-${scope.kind}-sig`, instanceId, name: "approve", payload: {} })).toMatchObject({ delivered: true })
    for (let index = 0; index < 4; index++) {
      await dispatchWorkflows({ store, registry, workerId: `${prefix}-worker`, claimLimit: 100, leaseDurationMs: 30_000 })
      if ((await store.get(instanceId))?.status === "succeeded") break
    }
    expect(await store.get(instanceId)).toMatchObject({ status: "succeeded", executionScope: scope, variables: { prepared: true, approved: true } })
    expect(seen.length).toBeGreaterThanOrEqual(3)
    for (const observed of seen) expect(observed).toEqual(scope)
  }
}
