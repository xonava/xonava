import { OptimisticConcurrencyError } from "core/domain"
import type { AtomicBatchPlan, EntityDescriptor, PersistenceProvider, UnversionedRepository } from "core/persistence"
import {
  runAtomicBatchContractTests,
  runJobStoreConcurrencyContractTests,
  runOutboxConcurrencyContractTests,
  runPersistenceProviderContractTests,
  runScheduleConcurrencyContractTests,
  runReleaseInvariantTests,
} from "../src/index"
import { createTenantScopedPersistenceProvider } from "core/persistence"
import type { JobStore, ScheduleStore, StoredJob } from "core/execution"
import type { FencedScheduleClaim } from "core/execution"
import type { OutboxRecord, OutboxSink } from "core/events"

const auditRecord = {
  id: "audit-contract-1",
  occurredAt: new Date("2026-01-01T00:00:00.000Z"),
  action: "create" as const,
  resourceType: "framework_contract_rows",
  resourceId: "row-1",
  actor: {
    id: "user-1",
    kind: "human" as const,
    authentication: {
      kind: "authenticated" as const,
      method: "contract-test",
      authenticatedAt: "2026-09-10T00:00:00.000Z",
    },
  },
  tenantId: "tenant-a",
  oldValue: null,
  newValue: { value: "created" },
}

interface Row {
  id: string
  name: string
  value: number
  tenantId?: string
  version?: number
}

type Command = { kind: "write"; id: string }

function createMemoryProvider(): PersistenceProvider {
  const rows = new Map<string, Row>()
  let nextId = 0

  const provider: PersistenceProvider = {
    dialect: "memory",
    capabilities: {
      interactiveTransactions: false,
      atomicBatch: true,
      returningInsert: false,
      readSessions: false,
      jsonQueries: false,
      exactDecimal: false,
      persistentConnection: false,
    },
    repository<T, TId = string>(entity: EntityDescriptor<T>): UnversionedRepository<T, TId> {
      const primaryKey = String(entity.primaryKey ?? "id") as keyof T
      const versionField = entity.versionField as keyof T | undefined
      const matches = (row: T, filter: unknown): boolean => {
        if (!filter || typeof filter !== "object") return true
        const node = filter as { kind?: string; field?: string; op?: string; value?: unknown; filters?: unknown[]; filter?: unknown }
        if (node.kind === "condition") return node.op === "eq" && row[node.field as keyof T] === node.value
        if (node.kind === "and") return (node.filters ?? []).every((child) => matches(row, child))
        if (node.kind === "or") return (node.filters ?? []).some((child) => matches(row, child))
        if (node.kind === "not") return !matches(row, node.filter)
        if (node.kind === "literal") return node.value === true
        return true
      }
      const repo: UnversionedRepository<T, string> = {
        findById: async (id) => rows.get(id) as T | undefined ?? null,
        findOneWhere: async (filter) => Array.from(rows.values()).find((row) => matches(row as T, filter)) as T | undefined ?? null,
        findMany: async (options) => {
          const filtered = Array.from(rows.values()).filter((row) => matches(row as T, options?.filter))
          const offset = options?.pagination?.kind === "offset" ? options.pagination : undefined
          const page = offset?.page ?? 1
          const pageSize = offset?.pageSize ?? filtered.length
          const start = (page - 1) * pageSize
          return { rows: filtered.slice(start, start + pageSize) as T[], rowCount: filtered.length, page, pageSize }
        },
        insert: async (data) => {
          const id = String(data[primaryKey] ?? `row-${++nextId}`)
          const row = { ...data, [primaryKey]: id } as T
          if (versionField && row[versionField] === undefined) row[versionField] = 1 as T[keyof T]
          rows.set(id, row as unknown as Row)
          return row
        },
        update: async (id, data, updateOptions) => {
          const current = rows.get(id) as T | undefined
          if (!current) throw new Error("not found")
          if (Object.prototype.hasOwnProperty.call(data, "version")) throw new Error("version is framework-owned")
          if (versionField && updateOptions?.optimisticConcurrency && current[versionField] !== updateOptions.optimisticConcurrency.expectedVersion) {
            throw new OptimisticConcurrencyError("stale version")
          }
          const row = { ...current, ...data }
          if (versionField && updateOptions?.optimisticConcurrency) row[versionField] = Number(current[versionField]) + 1 as T[keyof T]
          rows.set(id, row as unknown as Row)
          return row
        },
        updateOneWhere: async (filter, data, updateOptions) => {
          if (Object.prototype.hasOwnProperty.call(data, "version")) throw new Error("version is framework-owned")
          const row = Array.from(rows.values()).find((candidate) => matches(candidate as unknown as T, filter))
          if (!row) return { updatedCount: 0 }
          await repo.update(row.id, data, updateOptions)
          return { updatedCount: 1 }
        },
        updateOneWhereReturning: async (filter, data, updateOptions) => {
          if (Object.prototype.hasOwnProperty.call(data, "version")) throw new Error("version is framework-owned")
          const row = Array.from(rows.values()).find((candidate) => matches(candidate as unknown as T, filter))
          if (!row) return null
          return repo.update(row.id, data, updateOptions)
        },
        deleteWhere: async (filter, deleteOptions) => {
          if (filter.kind === "and" && filter.filters.length === 0) throw new Error("all-row predicate rejected")
          const ids = Array.from(rows.values()).filter((row) => matches(row as unknown as T, filter)).map((row) => row.id)
          const expectedVersion = deleteOptions?.optimisticConcurrency?.expectedVersion
          if (expectedVersion !== undefined && ids.some((id) => rows.get(id)?.version !== expectedVersion)) {
            throw new OptimisticConcurrencyError("stale version")
          }
          ids.forEach((id) => rows.delete(id))
          return { deletedCount: ids.length }
        },
        delete: async (id, deleteOptions) => {
          const row = rows.get(id)
          if (deleteOptions?.optimisticConcurrency && row?.version !== deleteOptions.optimisticConcurrency.expectedVersion) throw new OptimisticConcurrencyError("stale version")
          rows.delete(id)
        },
      }
      return repo as UnversionedRepository<T, TId>
    },
  }
  return provider
}

function createTenantProvider(provider: PersistenceProvider, tenantId: string): PersistenceProvider {
  return createTenantScopedPersistenceProvider(provider, tenantId)
}

function createMemoryJobStore(): JobStore {
  const jobs = new Map<string, StoredJob>()
  let nextId = 0
  let nextToken = 0
  const requesterTenant = (requester: { scope: string; tenantId?: string }) => requester.scope === "tenant" ? requester.tenantId ?? null : null
  const store: JobStore = {
    enqueue: async ({ requester, job }: Parameters<JobStore["enqueue"]>[0]) => {
      const id = `job-${++nextId}`
      const stored: StoredJob = {
        id, jobType: job.jobType, jobVersion: job.jobVersion,
        tenantId: job.executionScope.kind === "tenant" ? job.executionScope.tenantId : null,
        scope: job.executionScope.kind, executionScope: job.executionScope,
        payload: JSON.stringify(job.payload), status: "pending",
        priority: job.priority ?? 0, attemptsCompleted: 0, currentAttempt: 0, maxAttempts: job.maxAttempts ?? 3, runAt: job.runAt ?? new Date(0), nextAttemptAt: null,
        partitionKey: job.partitionKey ?? null,
        leaseOwner: null, leaseExpiresAt: null, claimToken: null, idempotencyKey: job.idempotencyKey ?? null, fingerprint: "memory-contract-v1", correlationId: job.correlationId ?? null,
        lastError: null, resultPayload: null, metadata: job.metadata ?? null, createdAt: new Date(), startedAt: null, completedAt: null,
      }
      if (requesterTenant(requester) !== null && requesterTenant(requester) !== stored.tenantId) throw new Error("tenant mismatch")
      jobs.set(id, stored)
      return stored
    },
    getById: async ({ id }) => jobs.get(id) ?? null,
    getByCorrelationId: async ({ correlationId }) => [...jobs.values()].filter((job) => job.correlationId === correlationId),
    getLatestPriorScheduleExecution: async ({ scheduleId, beforeOccurrence, requester }) => {
      const correlationId = `sched:${scheduleId}`
      const requesterTenant = (r: { scope: string; tenantId?: string }) => r.scope === "tenant" ? r.tenantId ?? null : null
      const scope = requester.scope
      const tenantId = requesterTenant(requester)
      const prior = [...jobs.values()]
        .filter((job) => job.correlationId === correlationId && job.scope === scope && (tenantId === null || job.tenantId === tenantId) && job.runAt.getTime() < beforeOccurrence.getTime())
        .sort((a, b) => b.runAt.getTime() - a.runAt.getTime())[0]
      return prior ?? null
    },
    getByIdempotencyKey: async ({ key }) => [...jobs.values()].find((job) => job.idempotencyKey === key) ?? null,
    claimDue: async ({ workerId, leaseDurationMs, now = new Date() }) => {
      const job = [...jobs.values()].find((candidate) => (candidate.status === "pending" || candidate.status === "retrying" || (candidate.status === "running" && (candidate.leaseExpiresAt?.getTime() ?? 0) <= now.getTime())))
      if (!job) return []
      job.status = "running"
      job.currentAttempt += 1
      job.leaseOwner = workerId
      job.claimToken = `claim-${++nextToken}`
      job.leaseExpiresAt = new Date(now.getTime() + leaseDurationMs)
      return [{ ...job }]
    },
    renewLease: async ({ jobId, workerId, claimToken, extendByMs }) => {
      const job = jobs.get(jobId)
      if (!job || job.status !== "running" || job.leaseOwner !== workerId || job.claimToken !== claimToken) return false
      job.leaseExpiresAt = new Date(Date.now() + extendByMs)
      return true
    },
    markSucceeded: async ({ jobId, workerId, claimToken, attempt, result }) => {
      const job = jobs.get(jobId)
      if (!job || job.status !== "running" || job.leaseOwner !== workerId || job.claimToken !== claimToken || job.currentAttempt !== attempt) return { applied: false, reason: "LEASE_LOST" as const }
      job.status = "succeeded"
      job.resultPayload = result ? JSON.stringify(result) : null
      return { applied: true }
    },
    markRetrying: async () => ({ applied: false, reason: "LEASE_LOST" as const }),
    markFailed: async () => ({ applied: false, reason: "LEASE_LOST" as const }),
    cancel: async () => ({ applied: false, reason: "LEASE_LOST" as const }),
    findPending: async () => [],
  }
  return store
}

function createMemoryScheduleStore(): ScheduleStore {
  const now = new Date("2026-08-10T12:00:00.000Z")
  let claimToken = ""
  let leaseExpiresAt = 0
  let owner = ""
  let nextToken = 0
  const claim = (token: string): FencedScheduleClaim => ({
    scheduleId: "schedule-1", scope: "platform", executionScope: { kind: "platform", platformKey: "default" }, jobType: "contract.job", jobVersion: 1, tenantId: null, payload: "{}", cronExpression: "* * * * *", timezone: "UTC",
    overlapPolicy: { type: "allow" }, misfirePolicy: { type: "fire_now" }, nextRunAt: now, lastRunAt: null, lastStatus: "running", claimToken: token,
  })
  return {
    claimDueSchedules: async ({ workerId, leaseDurationMs, now: requestedNow = now }) => {
      if (leaseExpiresAt > requestedNow.getTime()) return []
      owner = workerId
      claimToken = `schedule-claim-${++nextToken}`
      leaseExpiresAt = requestedNow.getTime() + leaseDurationMs
      return [claim(claimToken)]
    },
    renewScheduleLease: async ({ workerId, claimToken: token, now: requestedNow, extendByMs }) => {
      if (owner !== workerId || claimToken !== token || leaseExpiresAt <= requestedNow.getTime()) return false
      leaseExpiresAt = requestedNow.getTime() + extendByMs
      return true
    },
    advanceSchedule: async ({ workerId, claimToken: token }) => owner === workerId && claimToken === token,
    releaseSchedule: async ({ workerId, claimToken: token }) => {
      const applied = owner === workerId && claimToken === token
      if (applied) leaseExpiresAt = 0
      return applied
    },
  }
}

function createMemoryOutboxSink(): OutboxSink {
  const records = new Map<string, string>()
  return {
    append: async (record) => {
      const fingerprint = JSON.stringify({ type: record.type, version: record.version, tenantId: record.tenantId ?? null, aggregateType: record.aggregateType, aggregateId: record.aggregateId, payload: record.payload })
      const existing = records.get(`${record.tenantId ?? "platform"}:${record.idempotencyKey}`)
      if (existing && existing !== fingerprint) throw new Error("fingerprint conflict")
      records.set(`${record.tenantId ?? "platform"}:${record.idempotencyKey}`, fingerprint)
    },
  }
}

runPersistenceProviderContractTests("local memory provider", {
  createProvider: createMemoryProvider,
  createTenantProvider,
})

runAtomicBatchContractTests("local memory provider", {
  createProvider: createMemoryProvider,
  createAtomicProvider: (provider) => ({
    ...provider,
    capabilities: { ...provider.capabilities, atomicBatch: true, atomicBatchScope: "unscoped" as const },
     executeAtomicBatch: async (plan) => plan.items.map((item) => ({
       kind: item.kind,
       result: item.kind === "command" ? item.command : item.kind === "idempotency" ? item.commit : item.kind === "cache-generation" ? item.tag : item.record,
     })),
  }),
  createAtomicPlan: (): AtomicBatchPlan<Command> => ({ items: [
    { kind: "command", command: { kind: "write", id: "row-1" } },
    { kind: "audit", record: auditRecord },
    { kind: "outbox", record: { id: "outbox-1", type: "row.created", version: 1, scope: { kind: "platform", platformKey: "test" }, scopeId: "fscope:v1:eyJraW5kIjoicGxhdGZvcm0iLCJwbGF0Zm9ybUtleSI6InRlc3QifQ" as never, aggregateType: "row", aggregateId: "row-1", payload: {}, idempotencyKey: "row-1", occurredAt: new Date("2026-01-01T00:00:00.000Z") } },
  ] }),
})

const concurrencyRecord: OutboxRecord = {
  id: "outbox-contract-1", type: "row.created", version: 1, tenantId: "tenant-a", scope: { kind: "tenant", tenantId: "tenant-a" }, scopeId: "fscope:v1:eyJraW5kIjoidGVuYW50IiwidGVuYW50SWQiOiJ0ZW5hbnQtYSJ9" as never, aggregateType: "row", aggregateId: "row-1", payload: { value: "created" }, idempotencyKey: "row-1-created", occurredAt: new Date("2026-01-01T00:00:00.000Z"),
}

runJobStoreConcurrencyContractTests("local memory job store", { createStore: createMemoryJobStore })
runScheduleConcurrencyContractTests("local memory schedule store", { createStore: createMemoryScheduleStore })
runOutboxConcurrencyContractTests("local memory outbox", { createSink: createMemoryOutboxSink, record: concurrencyRecord, conflictingRecord: { ...concurrencyRecord, aggregateId: "row-2" } })
runReleaseInvariantTests("local deterministic harness")
