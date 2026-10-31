import { beforeEach, describe, expect, it } from "vitest"
import { ConfigurationError, ConflictError, StaleClaimError } from "@xonava/core/domain"
import type { InboxKey, InboxRecord, OutboxDeliveryKey, OutboxDeliveryRecord } from "@xonava/core/events"
import type { WorkflowFence, WorkflowInstance } from "@xonava/core/workflow"
import {
  createD1LeaseStore, createDrizzleD1InboxStore, createDrizzleD1OutboxStore, D1AtomicLeaseBackend, D1AtomicRecordBackend, DrizzleD1InboxStore,
  DrizzleD1JobProgressStore, DrizzleD1SequenceStore, DrizzleD1TemporalHistoryStore, DrizzleD1WorkflowStore, D1_LEASE_TABLES,
} from "@xonava/adapters/drizzle-d1"
import { assertLeaseBackendTime } from "../../drizzle-shared/fencedLeaseStore"
import { createFakeD1, type FakeD1 } from "../../__tests__/support/fakeD1"
import { applyFrameworkMigrations } from "./sqliteFixture"

let d1: FakeD1
beforeEach(() => {
  d1 = createFakeD1([
    "CREATE TABLE inbox_records (record_key TEXT PRIMARY KEY, record TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE outbox_records (record_key TEXT PRIMARY KEY, record TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE effects (id TEXT PRIMARY KEY)",
  ])
  applyFrameworkMigrations(d1)
})
const db = () => d1 as never
const rows = (query: string) => d1.sqlite.prepare(query).all() as Record<string, unknown>[]
const row = (query: string) => d1.sqlite.prepare(query).get() as Record<string, unknown> | undefined

const SCOPE = "fscope:v1:a" as never
const PROVENANCE = { format: "framework.authority-provenance", formatVersion: 1, correlationId: "corr-1" } as never
const inboxKey: InboxKey = { consumerKey: "c1", messageId: "m1", scopeId: SCOPE }
const inboxRecord = (key: InboxKey = inboxKey): InboxRecord => {
  const at = new Date().toISOString()
  return {
    ...key, consumerDefinitionVersion: 1, state: "pending", attempt: 0, replayGeneration: 0, claim: null,
    firstObservedAt: at, lastObservedAt: at, eventFormatVersion: 1, eventPayloadVersion: 1, originalProvenance: PROVENANCE, replay: { kind: "original-delivery" }, history: [],
  } as InboxRecord
}
const outboxKey: OutboxDeliveryKey = { messageId: "o1", scopeId: SCOPE }
const outboxRecord = (key: OutboxDeliveryKey = outboxKey): OutboxDeliveryRecord => ({
  envelope: { messageId: key.messageId, eventType: "order.placed", payloadVersion: 1, payload: { n: 1 } } as never,
  scopeId: key.scopeId, idempotencyKey: `k-${key.messageId}`, state: "pending", attempt: 0, claim: null,
} as OutboxDeliveryRecord)

const inboxBackend = (overrides: { table?: string; maxRetries?: number } = {}) =>
  new D1AtomicRecordBackend<InboxKey, InboxRecord>({ database: db(), table: overrides.table ?? "inbox_records", encodeKey: (key) => `${key.scopeId}:${key.consumerKey}:${key.messageId}`, ...(overrides.maxRetries === undefined ? {} : { maxRetries: overrides.maxRetries }) })
const outboxBackend = () =>
  new D1AtomicRecordBackend<OutboxDeliveryKey, OutboxDeliveryRecord>({ database: db(), table: "outbox_records", encodeKey: (key) => `${key.scopeId}:${key.messageId}` })

describe("D1 atomic record backend, inbox and outbox stores", () => {
  it("rejects unsafe table names", () => {
    expect(() => inboxBackend({ table: "inbox_records; DROP TABLE x" })).toThrow("Unsafe atomic-record table name")
  })

  it("runs the full inbox lifecycle with compare-and-swap persistence", async () => {
    const store = new DrizzleD1InboxStore(inboxBackend())
    expect(await store.get(inboxKey)).toBeNull()
    const observed = await store.observe(inboxRecord())
    expect(observed).toMatchObject({ state: "pending", attempt: 0 })
    expect(await store.observe(inboxRecord())).toMatchObject({ state: "pending" })
    const claimed = (await store.claim(inboxKey, "w1", 60_000))!
    expect(claimed).toMatchObject({ state: "claimed", attempt: 1, claim: { owner: "w1" } })
    expect(await store.claim(inboxKey, "w2", 60_000)).toBeNull()
    const renewed = await store.renew(inboxKey, claimed.claim!.token, 120_000)
    expect(renewed.claim!.token).toBe(claimed.claim!.token)
    await expect(store.renew(inboxKey, "wrong", 1_000)).rejects.toBeInstanceOf(StaleClaimError)
    const retried = await store.scheduleRetry(inboxKey, claimed.claim!.token, "TRANSIENT", 0, 3)
    expect(retried.state).toBe("retry_scheduled")
    const second = (await store.claim(inboxKey, "w1", 60_000))!
    expect(second.attempt).toBe(2)
    const dead = await store.deadLetter(inboxKey, second.claim!.token, "FATAL")
    expect(dead.state).toBe("dead_lettered")
    const operator = { format: "framework.authority-provenance", formatVersion: 1, correlationId: "operator" } as never
    const eligibility: string[] = []
    const request = { requestedBy: operator, reason: "retry after fix", authorized: true as const, validateReplayEligibility: () => { eligibility.push("checked") } }
    expect(() => store.replay(inboxKey, { ...request, authorized: false as never })).toThrow(ConfigurationError)
    expect(eligibility).toEqual([])
    const replayed = await store.replay(inboxKey, request)
    expect(replayed).toMatchObject({ state: "pending", replayGeneration: 1 })
    expect(eligibility).toEqual(["checked"])
    await expect(store.replay(inboxKey, request)).rejects.toThrow()
    await expect(store.replay({ ...inboxKey, messageId: "never" }, request)).rejects.toBeInstanceOf(ConflictError)
    expect(row("SELECT revision FROM inbox_records")!.revision).toBeGreaterThanOrEqual(5)
  })

  it("rejects transitions on records that were never observed", async () => {
    const store = new DrizzleD1InboxStore(inboxBackend())
    await expect(store.claim(inboxKey, "w1", 1_000)).rejects.toBeInstanceOf(ConflictError)
    await expect(store.renew(inboxKey, "t", 1_000)).rejects.toBeInstanceOf(ConflictError)
    await expect(store.acknowledgeBatch(inboxKey, "t", [d1.prepare("INSERT INTO effects (id) VALUES ('e')") as never], "x")).rejects.toBeInstanceOf(ConflictError)
  })

  it("acknowledges together with business statements atomically, and rolls everything back when a statement fails", async () => {
    const store = new DrizzleD1InboxStore(inboxBackend())
    await store.observe(inboxRecord())
    const claimed = (await store.claim(inboxKey, "w1", 60_000))!
    expect(() => store.acknowledgeBatch(inboxKey, claimed.claim!.token, [], "none")).toThrow("at least one business statement")
    const failing = d1.prepare("UPDATE effects SET id = id WHERE id = '__missing__'")
    await expect(store.acknowledgeBatch(inboxKey, claimed.claim!.token, [d1.prepare("INSERT INTO effects (id) VALUES ('e1')") as never, failing as never], "x")).rejects.toThrow()
    expect(rows("SELECT id FROM effects")).toEqual([])
    expect(await store.get(inboxKey)).toMatchObject({ state: "claimed" })
    const done = await store.acknowledgeBatch(inboxKey, claimed.claim!.token, [d1.prepare("INSERT INTO effects (id) VALUES ('e1')") as never], "ok")
    expect(done.result).toBe("ok")
    expect(done.record.state).toBe("processed")
    expect(rows("SELECT id FROM effects")).toEqual([{ id: "e1" }])
    await expect(store.acknowledgeBatch(inboxKey, claimed.claim!.token, [d1.prepare("INSERT INTO effects (id) VALUES ('e2')") as never], "again")).rejects.toThrow()
    expect(rows("SELECT id FROM effects")).toEqual([{ id: "e1" }])
  })

  it("retries a batch when a concurrent change only bumped the revision, and fails once the budget is exhausted", async () => {
    const store = new DrizzleD1InboxStore(inboxBackend({ maxRetries: 2 }))
    await store.observe(inboxRecord())
    const claimed = (await store.claim(inboxKey, "w1", 60_000))!
    let raced = false
    const racing = new Proxy(d1, {
      get(target, property, receiver) {
        if (property === "batch") {
          return async (statements: never[]) => {
            if (!raced) { raced = true; target.sqlite.exec("UPDATE inbox_records SET revision = revision + 1") }
            return target.batch(statements)
          }
        }
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    const racingStore = new DrizzleD1InboxStore(new D1AtomicRecordBackend<InboxKey, InboxRecord>({ database: racing as never, table: "inbox_records", encodeKey: (key) => `${key.scopeId}:${key.consumerKey}:${key.messageId}`, maxRetries: 2 }))
    const done = await racingStore.acknowledgeBatch(inboxKey, claimed.claim!.token, [d1.prepare("INSERT INTO effects (id) VALUES ('raced')") as never], "ok")
    expect(done.record.state).toBe("processed")
    expect(rows("SELECT id FROM effects")).toEqual([{ id: "raced" }])

    const alwaysLosing = new Proxy(d1, {
      get(target, property, receiver) {
        if (property === "batch") return async () => [{ meta: { changes: 0 } }]
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    const losing = new D1AtomicRecordBackend<InboxKey, InboxRecord>({ database: alwaysLosing as never, table: "inbox_records", encodeKey: (key) => `${key.scopeId}:${key.consumerKey}:${key.messageId}`, maxRetries: 2 })
    await expect(losing.transact(inboxKey, (current) => ({ record: current!, result: 1 }))).rejects.toThrow("exceeded retry budget")
  })

  it("selects the batch-capable inbox store only for D1 backends, and rejects transactional ack on the plain store", async () => {
    expect(createDrizzleD1InboxStore(inboxBackend())).toBeInstanceOf(DrizzleD1InboxStore)
    const foreign = { transactional: false, transact: async () => undefined, read: async () => null } as never
    const plain = createDrizzleD1InboxStore(foreign)
    expect(plain).not.toBeInstanceOf(DrizzleD1InboxStore)
    expect(() => plain.acknowledge(inboxKey, "t", async () => 1)).toThrow("Transactional inbox acknowledgement is unsupported")
  })

  it("runs the outbox delivery lifecycle", async () => {
    const store = createDrizzleD1OutboxStore(outboxBackend())
    expect(await store.get(outboxKey)).toBeNull()
    const appended = await store.append(outboxRecord())
    expect(appended.state).toBe("pending")
    expect(await store.append(outboxRecord())).toMatchObject({ state: "pending" })
    const claimed = (await store.claim(outboxKey, "p1", 60_000))!
    expect(claimed).toMatchObject({ state: "claimed", attempt: 1 })
    expect(await store.claim(outboxKey, "p2", 60_000)).toBeNull()
    const failed = await store.recordFailure(outboxKey, claimed.claim!.token, "BROKER_DOWN", 0, 3)
    expect(failed.state).toBe("retry_scheduled")
    const again = (await store.claim(outboxKey, "p1", 60_000))!
    const published = await store.markPublished(outboxKey, again.claim!.token)
    expect(published.state).toBe("published")
    await expect(store.markPublished(outboxKey, again.claim!.token)).rejects.toThrow()
    await expect(store.claim({ messageId: "ghost", scopeId: SCOPE }, "p1", 1_000)).rejects.toBeInstanceOf(ConflictError)
  })
})

describe("D1 fenced lease store", () => {
  const resource = { namespace: "jobs", resourceId: "r1", scopeId: SCOPE }

  it("grants one holder at a time, continues the fencing token and ends leases by expiring them", async () => {
    const store = createD1LeaseStore(db(), "framework_lease_records")
    const first = (await store.acquire(resource, "a", 60_000))!
    expect(first).toMatchObject({ owner: "a", fencingToken: 1 })
    expect(await store.acquire(resource, "b", 60_000)).toBeNull()
    await store.assertCurrent(first)
    const renewed = await store.renew(first, 120_000)
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(first.expiresAt))
    await store.release(first)
    await expect(store.assertCurrent(first)).rejects.toBeInstanceOf(StaleClaimError)
    await expect(store.release(first)).rejects.toBeInstanceOf(StaleClaimError)
    await expect(store.renew(first, 1_000)).rejects.toBeInstanceOf(StaleClaimError)
    const second = (await store.acquire(resource, "b", 60_000))!
    expect(second).toMatchObject({ owner: "b", fencingToken: 2 })
    expect(row("SELECT count(*) AS c FROM framework_lease_records")).toEqual({ c: 1 })
  })

  it("rejects invalid owners and durations before touching the database", async () => {
    const store = createD1LeaseStore(db(), "framework_lease_records")
    await expect(store.acquire(resource, "", 1_000)).rejects.toThrow("claimOwner is required")
    await expect(store.acquire(resource, "a", 0)).rejects.toThrow("lease duration")
    await expect(store.renew({ resource, owner: "a", claimToken: "t", fencingToken: 1, acquiredAt: "", expiresAt: "" }, Number.NaN)).rejects.toThrow("lease duration")
  })

  it("accepts a table name or options, and reports exhausted retries or unsafe tables", async () => {
    d1.sqlite.exec("CREATE TABLE custom_leases (resource_key TEXT PRIMARY KEY, lease TEXT NULL, revision INTEGER NOT NULL DEFAULT 0)")
    expect((await createD1LeaseStore(db(), "custom_leases").acquire(resource, "a", 1_000))?.owner).toBe("a")
    expect((await createD1LeaseStore(db(), { tables: { leases: "custom_leases" } }).acquire({ ...resource, resourceId: "r2" }, "a", 1_000))?.owner).toBe("a")
    expect(D1_LEASE_TABLES.leases).toBe("lease_records")
    expect(() => new D1AtomicLeaseBackend(db(), "bad name")).toThrow("Unsafe lease table name")
    const losing = new Proxy(d1, { get: (target, property, receiver) => property === "batch" ? async () => [{ meta: { changes: 0 } }] : Reflect.get(target, property, receiver) as unknown })
    await expect(createD1LeaseStore(losing as never, { tables: { leases: "framework_lease_records" }, maxRetries: 2 }).acquire(resource, "a", 1_000)).rejects.toThrow("exceeded retry budget")
  })

  it("accepts only real dates as authoritative backend time", () => {
    expect(() => assertLeaseBackendTime(new Date())).not.toThrow()
    expect(() => assertLeaseBackendTime(new Date(Number.NaN))).toThrow(ConfigurationError)
    expect(() => assertLeaseBackendTime("2026-01-01")).toThrow("authoritative time")
  })

  it("reads the database clock even when no lease row exists", async () => {
    const backend = new D1AtomicLeaseBackend(db(), "framework_lease_records")
    const read = await backend.read(resource)
    expect(read.lease).toBeNull()
    expect(Math.abs(read.backendNow.getTime() - Date.now())).toBeLessThan(60_000)
  })
})

describe("D1 sequence store", () => {
  const scope = "fscope:v1:seq" as never

  it("allocates gap-free values per scope, name and period", async () => {
    const store = new DrizzleD1SequenceStore(db())
    expect([await store.next(scope, "invoice", "2026"), await store.next(scope, "invoice", "2026"), await store.next(scope, "invoice", "2027"), await store.next(scope, "order", "2026")]).toEqual([1, 2, 1, 1])
  })

  it("allocates together with consumer statements in one batch, and requires batch support and a consumer", async () => {
    d1.sqlite.exec("CREATE TABLE numbered (n INTEGER)")
    const store = new DrizzleD1SequenceStore(db())
    const consumer = d1.prepare("INSERT INTO numbered SELECT value FROM framework_sequences WHERE scope_id = 'fscope:v1:seq' AND name = 'invoice' AND period = '2026'")
    expect(await store.nextWithStatements(scope, "invoice", "2026", [consumer as never])).toBe(1)
    expect(await store.nextWithStatements(scope, "invoice", "2026", [consumer as never])).toBe(2)
    expect(rows("SELECT n FROM numbered ORDER BY n")).toEqual([{ n: 1 }, { n: 2 }])
    await expect(store.nextWithStatements(scope, "invoice", "2026", [])).rejects.toThrow("requires a consumer statement")
    const noBatch = new DrizzleD1SequenceStore({ prepare: d1.prepare.bind(d1) } as never)
    await expect(noBatch.nextWithStatements(scope, "invoice", "2026", [consumer as never])).rejects.toThrow("batch allocation is unavailable")
    const failingConsumer = d1.prepare("INSERT INTO numbered SELECT 1 FROM missing_table")
    await expect(store.nextWithStatements(scope, "invoice", "2026", [failingConsumer as never])).rejects.toThrow()
    expect(await store.next(scope, "invoice", "2026")).toBe(3)
  })

  it("fails when the database returns no usable value", async () => {
    const broken = new DrizzleD1SequenceStore({ prepare: () => ({ bind: () => ({ first: async () => ({ value: 0 }) }) }) } as never)
    await expect(broken.next(scope, "n", "p")).rejects.toThrow("D1 sequence allocation failed")
  })
})

describe("D1 job progress store", () => {
  const fence = { jobId: "j1", workerId: "w1", claimToken: "tok", attempt: 1 }
  const addJob = (leaseOffsetMs = 60_000) => d1.sqlite.exec(`INSERT INTO framework_j1_jobs (id, worker_id, claim_token, attempt, lease_expires_at_ms) VALUES ('j1','w1','tok',1, CAST(unixepoch('subsec')*1000 AS INTEGER) + ${leaseOffsetMs})`)

  it("writes monotonic progress under a live fence and reads it back", async () => {
    addJob()
    const store = new DrizzleD1JobProgressStore(db())
    expect(await store.read("j1")).toBeNull()
    const first = await store.write(fence, 0, { percent: 10, checkpoint: { step: 1 } })
    expect(first).toMatchObject({ jobId: "j1", attempt: 1, sequence: 1, percent: 10, checkpoint: { step: 1 } })
    const second = await store.write(fence, 1, { percent: 50 })
    expect(second).toMatchObject({ sequence: 2, percent: 50 })
    expect(second.checkpoint).toBeUndefined()
    expect(await store.read("j1")).toMatchObject({ sequence: 2 })
  })

  it("reports a sequence conflict, lost ownership and invalid progress", async () => {
    addJob()
    const store = new DrizzleD1JobProgressStore(db())
    await store.write(fence, 0, { percent: 1 })
    await expect(store.write(fence, 0, { percent: 2 })).rejects.toBeInstanceOf(ConflictError)
    await expect(store.write(fence, 5, { percent: 2 })).rejects.toBeInstanceOf(ConflictError)
    await expect(store.write({ ...fence, claimToken: "other" }, 1, { percent: 2 })).rejects.toBeInstanceOf(StaleClaimError)
    d1.sqlite.exec("UPDATE framework_j1_jobs SET lease_expires_at_ms = 1")
    await expect(store.write(fence, 1, { percent: 2 })).rejects.toBeInstanceOf(StaleClaimError)
    await expect(store.write(fence, 1, { percent: 500 })).rejects.toThrow()
  })
})

describe("D1 temporal history store", () => {
  const resource = { scopeId: "fscope:v1:t" as never, entityType: "invoice", entityId: "i1" }
  const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms)

  it("allocates consecutive revisions and enforces the lifecycle in the database", async () => {
    const store = new DrizzleD1TemporalHistoryStore(db())
    const created = await store.append({ ...resource, occurredAt: at(0), kind: "created", state: { total: 1 }, entityVersion: 1, eventId: "e1", auditId: "a1" })
    expect(created).toMatchObject({ revision: 1, kind: "created", state: { total: 1 }, entityVersion: 1, eventId: "e1", auditId: "a1" })
    const updated = await store.append({ ...resource, occurredAt: at(10), kind: "updated", state: { total: 2 } })
    expect(updated.revision).toBe(2)
    expect(updated.entityVersion).toBeUndefined()
    const deleted = await store.append({ ...resource, occurredAt: at(20), kind: "deleted", state: null })
    expect(deleted).toMatchObject({ revision: 3, state: null })
    await expect(store.append({ ...resource, occurredAt: at(30), kind: "updated", state: { total: 3 } })).rejects.toThrow()
    const restored = await store.append({ ...resource, occurredAt: at(40), kind: "restored", state: { total: 2 } })
    expect(restored.revision).toBe(4)
    await expect(store.append({ ...resource, entityId: "fresh", occurredAt: at(0), kind: "updated", state: { total: 1 } })).rejects.toThrow()
    await expect(store.append({ ...resource, occurredAt: at(5), kind: "updated", state: { total: 9 } })).rejects.toThrow()
    expect(rows("SELECT revision FROM framework_temporal_revisions ORDER BY revision").map((r) => r.revision)).toEqual([1, 2, 3, 4])
  })

  it("pages revisions with hasMore and bounds them by the as-of time", async () => {
    const store = new DrizzleD1TemporalHistoryStore(db())
    await store.append({ ...resource, occurredAt: at(0), kind: "created", state: { n: 0 } })
    for (let n = 1; n <= 4; n += 1) await store.append({ ...resource, occurredAt: at(n * 10), kind: "updated", state: { n } })
    const page = await store.revisions(resource, { afterRevision: 0, asOf: at(1_000), limit: 2 })
    expect(page.items.map((item) => item.revision)).toEqual([1, 2])
    expect(page.hasMore).toBe(true)
    const rest = await store.revisions(resource, { afterRevision: 2, asOf: at(1_000), limit: 10 })
    expect(rest.items.map((item) => item.revision)).toEqual([3, 4, 5])
    expect(rest.hasMore).toBe(false)
    const bounded = await store.revisions(resource, { afterRevision: 0, asOf: at(20), limit: 10 })
    expect(bounded.items.map((item) => item.revision)).toEqual([1, 2, 3])
  })

  it("stores snapshots idempotently and returns the latest one at or before the as-of time", async () => {
    const store = new DrizzleD1TemporalHistoryStore(db())
    expect(await store.latestSnapshot(resource, at(100))).toBeNull()
    await store.saveSnapshot({ ...resource, revision: 2, occurredAt: at(10), state: { n: 2 } })
    await store.saveSnapshot({ ...resource, revision: 2, occurredAt: at(10), state: { n: "ignored duplicate" } })
    await store.saveSnapshot({ ...resource, revision: 4, occurredAt: at(30), state: null })
    expect(await store.latestSnapshot(resource, at(20))).toMatchObject({ revision: 2, state: { n: 2 } })
    expect(await store.latestSnapshot(resource, at(100))).toMatchObject({ revision: 4, state: null })
    expect(await store.latestSnapshot(resource, at(5))).toBeNull()
    await expect(store.saveSnapshot({ ...resource, revision: 0, occurredAt: at(0), state: { n: 1 } })).rejects.toBeInstanceOf(ConfigurationError)
  })

  it("commits participant statements and the revision together, or neither", async () => {
    d1.sqlite.exec("CREATE TABLE side (id TEXT)")
    const store = new DrizzleD1TemporalHistoryStore(db())
    const participant = d1.prepare("INSERT INTO side VALUES (?)").bind("p1")
    const revision = await store.appendWithStatements({ ...resource, occurredAt: at(0), kind: "created", state: { n: 1 } }, [participant as never])
    expect(revision.revision).toBe(1)
    expect(rows("SELECT id FROM side")).toEqual([{ id: "p1" }])
    await expect(store.appendWithStatements({ ...resource, occurredAt: at(10), kind: "created", state: { n: 1 } }, [d1.prepare("INSERT INTO side VALUES (?)").bind("p2") as never])).rejects.toThrow()
    expect(rows("SELECT id FROM side")).toEqual([{ id: "p1" }])
  })

  it("fails when the batch returns no revision row", async () => {
    const store = new DrizzleD1TemporalHistoryStore({ prepare: () => ({ bind: () => ({}) }), batch: async () => [{}, {}] } as never)
    await expect(store.append({ ...resource, occurredAt: at(0), kind: "created", state: { n: 1 } })).rejects.toThrow("returned no revision")
  })
})

describe("D1 workflow store", () => {
  const scope = { kind: "system", systemKey: "framework" } as never
  const start = (store: DrizzleD1WorkflowStore, id = "wf1") => store.start({ id, workflowType: "order", workflowVersion: 1, executionScope: scope, initialStep: "reserve", variables: { n: 1 } })
  const fenceOf = (instance: WorkflowInstance, workerId = "w1", claimToken = "tok"): WorkflowFence => ({ instanceId: instance.id, workerId, claimToken, revision: instance.revision })
  const claimed = async (store: DrizzleD1WorkflowStore, id = "wf1") => {
    await start(store, id)
    const [claim] = await store.claimDue({ workerId: "w1", limit: 1, leaseDurationMs: 60_000 })
    return claim!
  }

  it("starts, reads and rejects non-durable variables", async () => {
    const store = new DrizzleD1WorkflowStore(db())
    const instance = await start(store)
    expect(instance).toMatchObject({ id: "wf1", status: "pending", currentStep: "reserve", variables: { n: 1 }, stepAttempt: 0, revision: 0, compensationStack: [], leaseOwner: null, failure: null })
    expect(await store.get("missing")).toBeNull()
    await expect(store.start({ id: "bad", workflowType: "o", workflowVersion: 1, executionScope: scope, initialStep: "s", variables: { fn: () => 1 } as never })).rejects.toThrow()
  })

  it("claims due instances once, honouring limits, invalid arguments and lease expiry", async () => {
    const store = new DrizzleD1WorkflowStore(db())
    await start(store, "a")
    await start(store, "b")
    expect(await store.claimDue({ workerId: "w", limit: 0, leaseDurationMs: 1_000 })).toEqual([])
    expect(await store.claimDue({ workerId: "w", limit: 1.5, leaseDurationMs: 1_000 })).toEqual([])
    expect(await store.claimDue({ workerId: "w", limit: 1, leaseDurationMs: -1 })).toEqual([])
    const first = await store.claimDue({ workerId: "w1", limit: 1, leaseDurationMs: 60_000 })
    expect(first).toHaveLength(1)
    expect(first[0]!.instance).toMatchObject({ status: "pending", stepAttempt: 1, revision: 1, leaseOwner: "w1" })
    const second = await store.claimDue({ workerId: "w2", limit: 5, leaseDurationMs: 60_000 })
    expect(second).toHaveLength(1)
    expect(second[0]!.instance.id).not.toBe(first[0]!.instance.id)
    d1.sqlite.exec("UPDATE framework_workflows SET lease_expires_at_ms = 1")
    expect(await store.claimDue({ workerId: "w3", limit: 5, leaseDurationMs: 60_000 })).toHaveLength(2)
  })

  it("fences lease assertion and renewal by owner, token, revision and expiry", async () => {
    const store = new DrizzleD1WorkflowStore(db())
    const { instance, claimToken } = await claimed(store)
    const fence = fenceOf(instance, "w1", claimToken)
    expect(await store.assertLease(fence)).toBe(true)
    expect(await store.assertLease({ ...fence, workerId: "w2" })).toBe(false)
    expect(await store.assertLease({ ...fence, claimToken: "x" })).toBe(false)
    expect(await store.assertLease({ ...fence, revision: 99 })).toBe(false)
    expect(await store.renewLease(fence, 0)).toBe(false)
    expect(await store.renewLease(fence, Number.NaN)).toBe(false)
    expect(await store.renewLease({ ...fence, claimToken: "x" }, 1_000)).toBe(false)
    const before = Number(row("SELECT lease_expires_at_ms AS l FROM framework_workflows")!.l)
    expect(await store.renewLease(fence, 3_600_000)).toBe(true)
    expect(Number(row("SELECT lease_expires_at_ms AS l FROM framework_workflows")!.l)).toBeGreaterThan(before + 3_000_000)
    d1.sqlite.exec("UPDATE framework_workflows SET lease_expires_at_ms = 1")
    expect(await store.assertLease(fence)).toBe(false)
    expect(await store.renewLease(fence, 1_000)).toBe(false)
  })

  it("commits a forward transition under the fence and refuses a stale one", async () => {
    const store = new DrizzleD1WorkflowStore(db())
    const { instance, claimToken } = await claimed(store)
    const fence = fenceOf(instance, "w1", claimToken)
    const next: WorkflowInstance = { ...instance, currentStep: "charge", variables: { n: 2 }, stepAttempt: 0, compensationStack: ["release"] }
    expect(await store.commit({ ...fence, claimToken: "x" }, next)).toBe(false)
    expect(await store.commit(fence, next)).toBe(true)
    expect(await store.get(instance.id)).toMatchObject({ currentStep: "charge", variables: { n: 2 }, compensationStack: ["release"], revision: 2, leaseOwner: null, claimToken: null })
    expect(await store.commit(fence, next)).toBe(false)
  })

  it("persists failure details and terminal outcomes through commit", async () => {
    const store = new DrizzleD1WorkflowStore(db())
    const { instance, claimToken } = await claimed(store)
    const failure = { code: "STEP_FAILED", message: "boom", step: "reserve", phase: "execute" as const, attempt: 1, at: new Date("2026-01-01T00:00:00.000Z") }
    expect(await store.commit(fenceOf(instance, "w1", claimToken), { ...instance, status: "failed", outcome: "failed", failure })).toBe(true)
    const stored = (await store.get(instance.id))!
    expect(stored).toMatchObject({ status: "failed", outcome: "failed" })
    expect(stored.failure).toEqual(failure)
    d1.sqlite.exec("UPDATE framework_workflows SET failure = '{not json'")
    expect((await store.get(instance.id))!.failure).toBeNull()
  })

  it("buffers a signal delivered before the wait and resumes the wait from it at commit", async () => {
    const store = new DrizzleD1WorkflowStore(db())
    const { instance, claimToken } = await claimed(store)
    expect(await store.deliverSignal({ id: "s1", instanceId: instance.id, name: "approved", payload: { by: "x" } })).toEqual({ delivered: true, duplicate: false })
    expect(await store.deliverSignal({ id: "s1", instanceId: instance.id, name: "approved", payload: { by: "x" } })).toEqual({ delivered: false, duplicate: true })
    expect(await store.deliverSignal({ id: "s2", instanceId: "ghost", name: "approved", payload: {} })).toEqual({ delivered: false, duplicate: false })
    expect(await store.getSignal(instance.id, "approved")).toMatchObject({ id: "s1", payload: { by: "x" } })
    expect(await store.getSignalById(instance.id, "s1")).toMatchObject({ name: "approved" })
    expect(await store.getSignalById(instance.id, "nope")).toBeNull()
    expect(await store.getSignal(instance.id, "other")).toBeNull()
    const waiting: WorkflowInstance = { ...instance, status: "waiting", waitingSignal: "approved", wakeAt: null }
    expect(await store.commit(fenceOf(instance, "w1", claimToken), waiting)).toBe(true)
    expect(await store.get(instance.id)).toMatchObject({ status: "pending", resumeSignalId: "s1", stepAttempt: 0 })
  })

  it("parks on a signal wait, wakes on delivery and consumes each receipt once", async () => {
    const store = new DrizzleD1WorkflowStore(db())
    const { instance, claimToken } = await claimed(store)
    const waiting: WorkflowInstance = { ...instance, status: "waiting", waitingSignal: "approved", wakeAt: null }
    expect(await store.commit(fenceOf(instance, "w1", claimToken), waiting)).toBe(true)
    expect(await store.get(instance.id)).toMatchObject({ status: "waiting", waitingSignal: "approved" })
    expect(await store.deliverSignal({ id: "s1", instanceId: instance.id, name: "other", payload: {} })).toEqual({ delivered: true, duplicate: false })
    expect(await store.get(instance.id)).toMatchObject({ status: "waiting" })
    expect(await store.deliverSignal({ id: "s2", instanceId: instance.id, name: "approved", payload: { ok: true } })).toEqual({ delivered: true, duplicate: false })
    expect(await store.get(instance.id)).toMatchObject({ status: "pending", resumeSignalId: "s2", waitingSignal: "approved" })
    expect(row("SELECT consumed_revision FROM framework_workflow_signals WHERE id = 's2'")!.consumed_revision).not.toBeNull()
  })

  it("rejects a malformed stored signal payload as absent", async () => {
    const store = new DrizzleD1WorkflowStore(db())
    const instance = await start(store)
    await store.deliverSignal({ id: "s1", instanceId: instance.id, name: "n", payload: { a: 1 } })
    d1.sqlite.exec("UPDATE framework_workflow_signals SET payload = '[1]'")
    expect(await store.getSignalById(instance.id, "s1")).toBeNull()
    d1.sqlite.exec("UPDATE framework_workflow_signals SET payload = '{broken'")
    expect(await store.getSignal(instance.id, "n")).toBeNull()
  })

  it("cancels live instances directly or via compensation and refuses terminal ones", async () => {
    const store = new DrizzleD1WorkflowStore(db())
    const plain = await start(store, "plain")
    expect(await store.cancel(plain.id)).toBe(true)
    expect(await store.get(plain.id)).toMatchObject({ status: "cancelled", outcome: "cancelled", waitingSignal: null })
    expect((await store.get(plain.id))!.failure).toMatchObject({ code: "CANCELLED", phase: "execute" })
    expect(await store.cancel(plain.id)).toBe(false)
    expect(await store.cancel("ghost")).toBe(false)
    const compensable = await start(store, "comp")
    d1.sqlite.exec("UPDATE framework_workflows SET compensation_stack = '[\"undo\"]' WHERE id = 'comp'")
    expect(await store.cancel(compensable.id)).toBe(true)
    expect(await store.get(compensable.id)).toMatchObject({ status: "compensating", outcome: null })
    expect(await store.cancel(compensable.id)).toBe(false)
    expect(await store.deliverSignal({ id: "late", instanceId: plain.id, name: "n", payload: {} })).toEqual({ delivered: false, duplicate: false })
  })

  it("claims waiting instances whose timer elapsed and compensating ones whose delay passed", async () => {
    const store = new DrizzleD1WorkflowStore(db())
    await start(store, "timer")
    d1.sqlite.exec("UPDATE framework_workflows SET status = 'waiting', wake_at_ms = 1 WHERE id = 'timer'")
    const [timer] = await store.claimDue({ workerId: "w", limit: 5, leaseDurationMs: 1_000 })
    expect(timer!.instance).toMatchObject({ id: "timer", status: "pending" })
    await start(store, "comp")
    d1.sqlite.exec("UPDATE framework_workflows SET status = 'compensating', wake_at_ms = NULL WHERE id = 'comp'")
    const [comp] = await store.claimDue({ workerId: "w", limit: 5, leaseDurationMs: 1_000 })
    expect(comp!.instance).toMatchObject({ id: "comp", status: "compensating" })
  })
})
