import { beforeEach, describe, expect, it } from "vitest"
import { applyWorkflowStep } from "@xonava/core/workflow"
import type { JobStore, StoredJob } from "@xonava/core/execution"
import type { IdempotencyPort, OutboxSink } from "@xonava/core/events"
import type { WorkflowStore } from "@xonava/core/workflow"
import { fingerprintJobBase, idempotencyMaterial, legacyJobFingerprint, legacyOutboxFingerprint, outboxRecord } from "./fixtures.js"
import { DIRECTIONS, releaseOps, type Release } from "./releases.js"

/**
 * N-1 upgrade compatibility on a real database. The same tables are read and written by the stores of both releases
 * ("0.1.0" from the npm alias, "current" from this checkout), so every ordered pair (old writer, new reader) and
 * (new writer, old reader) shows what a rolling deploy sees. Database runners supply the stores and the raw column
 * access; the scenarios live here so D1, PostgreSQL and MySQL run the same suite.
 */

export interface ReleaseStores {
  readonly jobs: JobStore
  readonly workflows: WorkflowStore
  readonly outbox: OutboxSink
  readonly idempotency: IdempotencyPort<unknown>
  /** The durable commit path that records the business commit on a reservation (interactive transaction, or atomic batch on D1). */
  commit(item: { scope: string; key: string; fingerprint: string; token: string }): Promise<void>
}

export interface RawJobRow { readonly fingerprint: string | null; readonly scope: string; readonly tenantId: string | null; readonly scopeKey: string | null }

export interface UpgradeDriver {
  readonly label: string
  stores(release: Release): ReleaseStores
  /** Empties every table the suite writes (called before each test). */
  reset(): Promise<void>
  jobRow(jobId: string): Promise<RawJobRow>
  setJobFingerprint(jobId: string, fingerprint: string): Promise<void>
  outboxRows(scopeId: string, idempotencyKey: string): Promise<Array<{ fingerprint: string }>>
  setOutboxFingerprint(scopeId: string, idempotencyKey: string, fingerprint: string): Promise<void>
  /** The raw `resume_signal_id` column of a workflow instance. */
  resumeSignalId(instanceId: string): Promise<string | null>
  setResumeSignalId(instanceId: string, value: string | null): Promise<void>
}

const T0 = Date.UTC(2030, 5, 1)
const SYSTEM = { scope: "system" } as const
const PLATFORM = { scope: "platform", actorId: "upgrade-actor" } as const
let counter = 0
const unique = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${++counter}`

const baseJob = (over: Record<string, unknown> = {}) => ({
  executionScope: { kind: "system", systemKey: "framework" }, jobType: "upgrade.job", jobVersion: 1, payload: { ...fingerprintJobBase.payload }, runAt: new Date(T0),
  correlationId: "corr-1", metadata: { source: "upgrade" }, ...over,
})

const enqueue = (stores: ReleaseStores, job: Record<string, unknown>, requester: unknown = SYSTEM): Promise<StoredJob> => stores.jobs.enqueue({ requester, job } as never)

export function defineJobUpgrade(driver: UpgradeDriver): void {
  describe(`${driver.label}: job store (fingerprints, lifecycle, scope keys)`, () => {
    beforeEach(() => driver.reset())

    describe.each(DIRECTIONS)("%s writes, %s reads", (writer, reader) => {
      const w = () => driver.stores(writer)
      const r = () => driver.stores(reader)

      it.each([{ label: "an omitted attempt budget", maxAttempts: undefined }, { label: "an explicit budget of 5", maxAttempts: 5 }, { label: "an explicit budget of 3", maxAttempts: 3 }])("replays an idempotent re-enqueue with $label", async ({ maxAttempts }) => {
        const key = unique("idem")
        const job = baseJob({ idempotencyKey: key, ...(maxAttempts === undefined ? {} : { maxAttempts }) })
        const first = await enqueue(w(), job)
        const stored = (await driver.jobRow(first.id)).fingerprint
        // The digest the writer stored is the digest both releases compute for this job (job fingerprint version 5).
        expect(stored).toBe(await releaseOps[writer].fingerprintJob(releaseOps[writer].buildJobFingerprintInput(job, job.runAt as Date)))
        expect(stored).toBe(await releaseOps[reader].fingerprintJob(releaseOps[reader].buildJobFingerprintInput(job, job.runAt as Date)))
        const replay = await enqueue(r(), job)
        expect(replay.id).toBe(first.id)
        expect(replay.maxAttempts).toBe(maxAttempts)
        expect((await r().jobs.getByIdempotencyKey({ key, requester: SYSTEM })) ?? undefined).toMatchObject({ id: first.id })
      })

      it("refuses a re-enqueue of the same key with a different payload, with the reader's own conflict error", async () => {
        const key = unique("idem")
        await enqueue(w(), baseJob({ idempotencyKey: key }))
        const failure = await enqueue(r(), baseJob({ idempotencyKey: key, payload: { different: true } })).then(() => undefined, (error: unknown) => error)
        expect(failure).toBeInstanceOf(releaseOps[reader].JobIdempotencyConflictError)
        expect(failure).toMatchObject({ code: "JOB_IDEMPOTENCY_CONFLICT" })
        // The error class belongs to the reader's release: the stack under test is isolated, not old adapters on new core.
        if (writer !== reader) expect(failure).not.toBeInstanceOf(releaseOps[writer].JobIdempotencyConflictError)
      })

      it.each([4, 3] as const)("replays a re-enqueue against a stored version-%i fingerprint (docs/KNOWN-LIMITATIONS.md, Legacy fingerprints)", async (version) => {
        for (const maxAttempts of [undefined, 3]) {
          const key = unique("legacy")
          const job = baseJob({ idempotencyKey: key, ...(maxAttempts === undefined ? {} : { maxAttempts }) })
          const first = await enqueue(w(), job)
          await driver.setJobFingerprint(first.id, await legacyJobFingerprint(releaseOps[writer], version, job))
          const replay = await enqueue(r(), job)
          expect(replay.id, `v${version} maxAttempts=${maxAttempts}`).toBe(first.id)
          // A legacy digest still identifies the job it was written for, and only that job.
          const conflict = await enqueue(r(), baseJob({ idempotencyKey: key, maxAttempts: 5 })).then(() => undefined, (error: unknown) => error)
          expect(conflict, `v${version} budget 5`).toBeInstanceOf(releaseOps[reader].JobIdempotencyConflictError)
        }
      })

      it("reads a job's row the writer wrote, claims it, and completes it for the writer to read back", async () => {
        const payload = { orderId: "o-1", lines: [{ sku: "a", qty: 2 }], note: "é" }
        const first = await enqueue(w(), baseJob({ payload, maxAttempts: 4, priority: 2, partitionKey: "orders" }))
        const seen = await r().jobs.getById({ id: first.id, requester: SYSTEM })
        expect(seen).toMatchObject({ id: first.id, jobType: "upgrade.job", jobVersion: 1, status: "pending", priority: 2, maxAttempts: 4, partitionKey: "orders", correlationId: "corr-1", metadata: { source: "upgrade" }, executionScope: { kind: "system", systemKey: "framework" } })
        expect(JSON.parse(seen!.payload)).toEqual(payload)
        const claimed = await r().jobs.claimDue({ limit: 10, workerId: `${reader}-worker`, leaseDurationMs: 3_600_000, requester: SYSTEM, now: new Date(T0 + 1) })
        expect(claimed.map((job) => job.id)).toContain(first.id)
        const mine = claimed.find((job) => job.id === first.id)!
        expect(mine).toMatchObject({ status: "running", leaseOwner: `${reader}-worker`, currentAttempt: 1 })
        expect(await r().jobs.markSucceeded({ jobId: first.id, workerId: `${reader}-worker`, claimToken: mine.claimToken!, attempt: 1, result: { done: true } })).toMatchObject({ applied: true })
        const finished = await w().jobs.getById({ id: first.id, requester: SYSTEM })
        expect(finished).toMatchObject({ status: "succeeded" })
        expect(JSON.parse(finished!.resultPayload!)).toEqual({ done: true })
      })

      it("keeps the attempt-budget sentinel of a job enqueued without maxAttempts across releases", async () => {
        const first = await enqueue(w(), baseJob())
        expect((await r().jobs.getById({ id: first.id, requester: SYSTEM }))!.maxAttempts).toBeUndefined()
        const claimed = (await r().jobs.claimDue({ limit: 10, workerId: "w", leaseDurationMs: 3_600_000, requester: SYSTEM, now: new Date(T0 + 1) })).find((job) => job.id === first.id)
        expect(claimed).toBeDefined()
        expect(claimed!.maxAttempts).toBeUndefined()
      })
    })

    it("platform and system keys: a key written by the current release is read as the default by 0.1.0, which can still claim and complete the job (.changeset/job-scope-keys.md)", async () => {
      const current = driver.stores("current")
      const old = driver.stores("0.1.0")
      for (const [executionScope, requester, defaultScope] of [
        [{ kind: "platform", platformKey: "tenantless-a" }, PLATFORM, { kind: "platform", platformKey: "default" }],
        [{ kind: "system", systemKey: "probe" }, SYSTEM, { kind: "system", systemKey: "framework" }],
      ] as const) {
        const keyed = await enqueue(current, baseJob({ executionScope }), requester)
        const key = executionScope.kind === "platform" ? executionScope.platformKey : executionScope.systemKey
        expect(await driver.jobRow(keyed.id)).toMatchObject({ scope: executionScope.kind, tenantId: null, scopeKey: key })
        expect((await current.jobs.getById({ id: keyed.id, requester }))!.executionScope).toEqual(executionScope)
        // Documented transitional effect: an old worker reads the job under the default key.
        expect((await old.jobs.getById({ id: keyed.id, requester }))!.executionScope).toEqual(defaultScope)
        const claimed = (await old.jobs.claimDue({ limit: 10, workerId: "old-worker", leaseDurationMs: 3_600_000, requester, now: new Date(T0 + 1) })).find((job) => job.id === keyed.id)
        expect(claimed, "claims, leases and fencing never read the key").toBeDefined()
        expect(await old.jobs.markSucceeded({ jobId: keyed.id, workerId: "old-worker", claimToken: claimed!.claimToken!, attempt: 1 })).toMatchObject({ applied: true })
        expect(await current.jobs.getById({ id: keyed.id, requester })).toMatchObject({ status: "succeeded", executionScope })
        expect((await driver.jobRow(keyed.id)).scopeKey).toBe(key)
      }
    })

    it("platform and system keys: rows 0.1.0 wrote carry no key and decode to the defaults on the current release", async () => {
      const current = driver.stores("current")
      const old = driver.stores("0.1.0")
      for (const [executionScope, requester] of [[{ kind: "platform", platformKey: "default" }, PLATFORM], [{ kind: "system", systemKey: "framework" }, SYSTEM]] as const) {
        const written = await enqueue(old, baseJob({ executionScope }), requester)
        expect((await driver.jobRow(written.id)).scopeKey).toBeNull()
        expect((await current.jobs.getById({ id: written.id, requester }))!.executionScope).toEqual(executionScope)
      }
      // 0.1.0 does not persist a non-default key at all: the key is lost on write, which the fix in .changeset/job-scope-keys.md addresses.
      const lost = await enqueue(old, baseJob({ executionScope: { kind: "system", systemKey: "probe" } }))
      expect((await driver.jobRow(lost.id)).scopeKey).toBeNull()
      expect((await current.jobs.getById({ id: lost.id, requester: SYSTEM }))!.executionScope).toEqual({ kind: "system", systemKey: "framework" })
    })
  })
}

const startInstance = async (store: WorkflowStore, id: string) => store.start({ id, workflowType: "upgrade", workflowVersion: 1, executionScope: { kind: "tenant", tenantId: "t1" }, initialStep: "approve", variables: { n: 1 } } as never)
async function claim(store: WorkflowStore, id: string, workerId: string) {
  const found = (await store.claimDue({ workerId, limit: 1000, leaseDurationMs: 3_600_000 })).find((entry) => entry.instance.id === id)
  expect(found, `claim ${id}`).toBeDefined()
  return { claim: found!, fence: { instanceId: id, workerId, claimToken: found!.claimToken, revision: found!.instance.revision } }
}

export function defineWorkflowUpgrade(driver: UpgradeDriver): void {
  describe(`${driver.label}: workflow store (resume_signal_id receipts)`, () => {
    beforeEach(() => driver.reset())

    describe.each(DIRECTIONS)("%s writes, %s reads", (writer, reader) => {
      const w = () => driver.stores(writer).workflows
      const r = () => driver.stores(reader).workflows

      it("hands the receipt that resumed a wait, consumed at the writer's commit, to the reader that claims and finishes the step", async () => {
        const id = unique("wf-early")
        await startInstance(w(), id)
        const first = await claim(w(), id, `${writer}-1`)
        expect(await w().deliverSignal({ id: `${id}-sig`, instanceId: id, name: "go", payload: { n: 1 } })).toEqual({ delivered: true, duplicate: false })
        expect(await w().commit(first.fence, applyWorkflowStep(first.claim.instance, { kind: "wait", signal: "go" }, new Date()))).toBe(true)
        expect(await driver.resumeSignalId(id)).toBe(`${id}-sig`)
        expect(await r().get(id)).toMatchObject({ status: "pending", waitingSignal: "go", resumeSignalId: `${id}-sig`, stepAttempt: 0 })
        expect(await r().getSignalById!(id, `${id}-sig`)).toMatchObject({ id: `${id}-sig`, instanceId: id, name: "go", payload: { n: 1 } })
        const second = await claim(r(), id, `${reader}-2`)
        expect(second.claim.instance).toMatchObject({ resumeSignalId: `${id}-sig`, stepAttempt: 1 })
        expect(await r().commit(second.fence, applyWorkflowStep(second.claim.instance, { kind: "complete" }, new Date()))).toBe(true)
        expect(await w().get(id)).toMatchObject({ status: "succeeded", resumeSignalId: null })
        // The receipt outlives the step that consumed it.
        expect(await w().getSignalById!(id, `${id}-sig`)).toMatchObject({ payload: { n: 1 } })
        expect(await driver.resumeSignalId(id)).toBeNull()
      })

      it("wakes a parked instance with exactly the receipt the other release delivered, and answers a duplicate id idempotently", async () => {
        const id = unique("wf-parked")
        await startInstance(w(), id)
        const first = await claim(w(), id, `${writer}-1`)
        expect(await w().commit(first.fence, applyWorkflowStep(first.claim.instance, { kind: "wait", signal: "go" }, new Date()))).toBe(true)
        expect(await r().get(id)).toMatchObject({ status: "waiting", waitingSignal: "go", resumeSignalId: null })
        expect(await r().deliverSignal({ id: `${id}-a`, instanceId: id, name: "go", payload: { from: reader } })).toEqual({ delivered: true, duplicate: false })
        expect(await w().deliverSignal({ id: `${id}-a`, instanceId: id, name: "go", payload: { from: writer } })).toEqual({ delivered: false, duplicate: true })
        expect(await w().get(id)).toMatchObject({ status: "pending", resumeSignalId: `${id}-a` })
        expect(await driver.resumeSignalId(id)).toBe(`${id}-a`)
        const resumed = await claim(w(), id, `${writer}-2`)
        expect(resumed.claim.instance).toMatchObject({ resumeSignalId: `${id}-a`, stepAttempt: 1 })
        expect(await w().getSignalById!(id, `${id}-a`)).toMatchObject({ payload: { from: reader } })
        expect(await w().commit(resumed.fence, applyWorkflowStep(resumed.claim.instance, { kind: "complete" }, new Date()))).toBe(true)
        expect(await r().get(id)).toMatchObject({ status: "succeeded" })
      })

      it("keeps receipts that arrived while a step ran pending, and consumes the oldest first at the next wait (across releases)", async () => {
        const id = unique("wf-fifo")
        await startInstance(w(), id)
        let current = await claim(w(), id, `${writer}-1`)
        expect(await w().deliverSignal({ id: `${id}-1`, instanceId: id, name: "go", payload: { n: 1 } })).toMatchObject({ delivered: true })
        expect(await r().deliverSignal({ id: `${id}-2`, instanceId: id, name: "go", payload: { n: 2 } })).toMatchObject({ delivered: true })
        expect(await w().commit(current.fence, applyWorkflowStep(current.claim.instance, { kind: "wait", signal: "go" }, new Date()))).toBe(true)
        expect(await r().get(id)).toMatchObject({ resumeSignalId: `${id}-1` })
        current = await claim(r(), id, `${reader}-1`)
        expect(await r().commit(current.fence, applyWorkflowStep(current.claim.instance, { kind: "wait", signal: "go" }, new Date()))).toBe(true)
        expect(await w().get(id)).toMatchObject({ resumeSignalId: `${id}-2` })
      })
    })

    it.each([["0.1.0"], ["current"]] as const)("an instance that resumed before the receipt id existed (no resume_signal_id) is claimable and finishable on %s, falling back to the latest receipt by name (docs/KNOWN-LIMITATIONS.md, Rolling deployment order)", async (release) => {
      const stores = driver.stores(release).workflows
      const other = driver.stores(release === "current" ? "0.1.0" : "current").workflows
      const id = unique("wf-premigration")
      await startInstance(stores, id)
      const first = await claim(stores, id, "w1")
      await stores.deliverSignal({ id: `${id}-old`, instanceId: id, name: "go", payload: { n: 1 } })
      expect(await stores.commit(first.fence, applyWorkflowStep(first.claim.instance, { kind: "wait", signal: "go" }, new Date()))).toBe(true)
      await driver.setResumeSignalId(id, null)
      expect((await other.get(id))!.resumeSignalId ?? null).toBeNull()
      expect((await other.get(id))!).toMatchObject({ status: "pending", waitingSignal: "go" })
      expect(await other.getSignal!(id, "go")).toMatchObject({ id: `${id}-old`, payload: { n: 1 } })
      const resumed = await claim(other, id, "w2")
      expect(resumed.claim.instance.resumeSignalId ?? null).toBeNull()
      expect(await other.commit(resumed.fence, applyWorkflowStep(resumed.claim.instance, { kind: "complete" }, new Date()))).toBe(true)
      expect(await stores.get(id)).toMatchObject({ status: "succeeded" })
    })
  })
}

export function defineOutboxUpgrade(driver: UpgradeDriver): void {
  describe(`${driver.label}: outbox sink (event fingerprints)`, () => {
    beforeEach(() => driver.reset())

    describe.each(DIRECTIONS)("%s writes, %s reads", (writer, reader) => {
      const record = (ops: typeof releaseOps[Release], key: string, over: Record<string, unknown> = {}) => outboxRecord(ops, { id: unique("evt"), idempotencyKey: key, ...over }) as never

      it("treats the same event appended by the other release as an idempotent no-op", async () => {
        const key = unique("outbox")
        const first = record(releaseOps[writer], key)
        await driver.stores(writer).outbox.append(first)
        const scopeId = (first as { scopeId: string }).scopeId
        const [row] = await driver.outboxRows(scopeId, key)
        expect(row!.fingerprint).toMatch(/^v3:[0-9a-f]{64}$/)
        expect(row!.fingerprint).toBe(await releaseOps[reader].computeOutboxFingerprint(first as never))
        await expect(driver.stores(reader).outbox.append(record(releaseOps[reader], key))).resolves.toBeUndefined()
        expect(await driver.outboxRows(scopeId, key)).toHaveLength(1)
      })

      it("refuses a different event under the same idempotency key with the reader's own ConflictError", async () => {
        const key = unique("outbox")
        const first = record(releaseOps[writer], key)
        await driver.stores(writer).outbox.append(first)
        const failure = await driver.stores(reader).outbox.append(record(releaseOps[reader], key, { payload: { different: true } })).then(() => undefined, (error: unknown) => error)
        expect(failure).toBeInstanceOf(releaseOps[reader].ConflictError)
        expect(failure).toMatchObject({ message: "Outbox idempotency key was reused for a different event" })
      })

      it("still accepts an event stored under a v2 fingerprint, written before the RFC 8785 key-order fix, and rejects a different one", async () => {
        const key = unique("outbox")
        const first = record(releaseOps[writer], key)
        await driver.stores(writer).outbox.append(first)
        const scopeId = (first as { scopeId: string }).scopeId
        await driver.setOutboxFingerprint(scopeId, key, await legacyOutboxFingerprint(releaseOps[writer], first as never))
        await expect(driver.stores(reader).outbox.append(record(releaseOps[reader], key))).resolves.toBeUndefined()
        await expect(driver.stores(reader).outbox.append(record(releaseOps[reader], key, { payload: { different: true } }))).rejects.toBeInstanceOf(releaseOps[reader].ConflictError)
      })

      it("fails closed on a stored event whose fingerprint is missing", async () => {
        const key = unique("outbox")
        const first = record(releaseOps[writer], key)
        await driver.stores(writer).outbox.append(first)
        await driver.setOutboxFingerprint((first as { scopeId: string }).scopeId, key, "")
        await expect(driver.stores(reader).outbox.append(record(releaseOps[reader], key))).rejects.toThrow("Stored outbox fingerprint is missing; migrate fingerprints before replaying events.")
      })
    })
  })
}

export function defineIdempotencyUpgrade(driver: UpgradeDriver): void {
  describe(`${driver.label}: HTTP idempotency store (request fingerprints, replayed responses)`, () => {
    beforeEach(() => driver.reset())

    describe.each(DIRECTIONS)("%s writes, %s reads", (writer, reader) => {
      const w = () => driver.stores(writer).idempotency
      const r = () => driver.stores(reader).idempotency
      const request = async (release: Release, key: string, fingerprint?: string) => ({ scope: "fscope:v1:upgrade", key, fingerprint: fingerprint ?? await releaseOps[release].fingerprintJson(idempotencyMaterial) })

      it("lets the reader complete a reservation the writer acquired, and replays the response to either release", async () => {
        const key = unique("http")
        const acquired = await w().acquire(await request(writer, key))
        expect(acquired).toMatchObject({ outcome: "acquired" })
        const token = (acquired as { token: string }).token
        await driver.stores(writer).commit({ ...(await request(writer, key)), token })
        // The same request from the other release finds the reservation in progress or committed rather than a conflict: the fingerprints agree.
        expect(await r().acquire(await request(reader, key))).toMatchObject({ outcome: expect.stringMatching(/^(in-progress|business-committed)$/) })
        const serialized = await releaseOps[writer].serializeResponse(new Response(JSON.stringify({ id: "a-1" }), { status: 201, headers: { "content-type": "application/json" } }))
        await r().complete({ ...(await request(reader, key)), token, result: serialized })
        for (const release of [writer, reader] as const) {
          const replay = await driver.stores(release).idempotency.acquire(await request(release, key))
          expect(replay, `replay on ${release}`).toMatchObject({ outcome: "replay" })
          const response = releaseOps[release].deserializeResponse((replay as unknown as { result: never }).result)
          expect(response.status).toBe(201)
          expect(await response.json()).toEqual({ id: "a-1" })
        }
      })

      it("conflicts on a different request body under the same key", async () => {
        const key = unique("http")
        const acquired = await w().acquire(await request(writer, key))
        await driver.stores(writer).commit({ ...(await request(writer, key)), token: (acquired as { token: string }).token })
        await w().complete({ ...(await request(writer, key)), token: (acquired as { token: string }).token, result: await releaseOps[writer].serializeResponse(new Response("{}", { status: 200 })) })
        const other = await releaseOps[reader].fingerprintJson({ different: true })
        expect(await r().acquire(await request(reader, key, other))).toMatchObject({ outcome: "conflict" })
      })

      it("matches a record stored under the v2 fingerprint only through the legacy retry the write handler performs", async () => {
        const key = unique("http")
        const legacy = await releaseOps[writer].legacyFingerprintJson(idempotencyMaterial)
        const acquired = await w().acquire(await request(writer, key, legacy))
        await driver.stores(writer).commit({ ...(await request(writer, key, legacy)), token: (acquired as { token: string }).token })
        await w().complete({ ...(await request(writer, key, legacy)), token: (acquired as { token: string }).token, result: await releaseOps[writer].serializeResponse(new Response("{\"ok\":true}", { status: 200 })) })
        // First try with the current (v3) fingerprint conflicts; the handler then retries with the v2 fingerprint of the same request and replays.
        expect(await r().acquire(await request(reader, key))).toMatchObject({ outcome: "conflict" })
        const retry = await r().acquire(await request(reader, key, await releaseOps[reader].legacyFingerprintJson(idempotencyMaterial)))
        expect(retry).toMatchObject({ outcome: "replay" })
      })
    })
  })
}
