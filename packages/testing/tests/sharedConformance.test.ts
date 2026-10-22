import { describe, expect, it } from "vitest"
import type { AtomicBatchPlan, AtomicBatchProvider, AtomicBatchItemResult } from "@xonava/core/persistence"
import type {
  AuditRecord,
  AuditSink,
  IdempotencyAcquireResult,
  IdempotencyCompletion,
  IdempotencyLease,
  IdempotencyPort,
  IdempotencyRequest,
  OutboxRecord,
  OutboxSink,
} from "@xonava/core/events"
import {
  runAtomicRollbackContractTests,
  runAuditGuaranteeContractTests,
  runCacheGenerationItemContractTests,
  runIdempotencyTransitionContractTests,
  runOutboxReplayContractTests,
} from "../src/index"

const DEFAULT_LEASE_MS = 60_000

interface StoredReservation {
  fingerprint: string
  token: string
  expiresAt: number
  done: boolean
  result?: unknown
}

/** In-memory idempotency port with lease expiry and token fencing. */
function createIdempotencyStore<TResult>(): IdempotencyPort<TResult> {
  const reservations = new Map<string, StoredReservation>()
  let nextToken = 0
  const slot = (scope: string, key: string) => `${scope}\u0000${key}`
  return {
    acquire: async (request: IdempotencyRequest): Promise<IdempotencyAcquireResult<TResult>> => {
      const existing = reservations.get(slot(request.scope, request.key))
      if (existing && existing.fingerprint !== request.fingerprint) return { outcome: "conflict" }
      if (existing?.done) return { outcome: "replay", result: existing.result as TResult }
      if (existing && existing.expiresAt > Date.now()) return { outcome: "in-progress" }
      const token = `token-${++nextToken}`
      reservations.set(slot(request.scope, request.key), {
        fingerprint: request.fingerprint,
        token,
        expiresAt: Date.now() + (request.leaseDurationMs ?? DEFAULT_LEASE_MS),
        done: false,
      })
      return { outcome: "acquired", token }
    },
    renew: async (lease: IdempotencyLease) => {
      const existing = reservations.get(slot(lease.scope, lease.key))
      if (!existing || existing.token !== lease.token) throw new Error("reservation fenced")
      existing.expiresAt = Date.now() + (lease.leaseDurationMs ?? DEFAULT_LEASE_MS)
    },
    complete: async (completion: IdempotencyCompletion<TResult>) => {
      const existing = reservations.get(slot(completion.scope, completion.key))
      if (!existing || existing.token !== completion.token) throw new Error("reservation fenced")
      existing.done = true
      existing.result = completion.result
    },
  }
}

/** In-memory outbox sink that accepts identical replays and rejects conflicting ones. */
function createOutboxSink(): OutboxSink {
  const records = new Map<string, OutboxRecord>()
  return {
    append: async (record: OutboxRecord) => {
      const existing = records.get(record.id)
      if (existing === undefined) {
        records.set(record.id, record)
        return
      }
      if (JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error(`outbox record ${record.id} conflicts with an earlier append`)
      }
    },
  }
}

type BatchCommand = { readonly op: "noop" } | { readonly op: "fail" }

/** In-memory batch provider that stages cache generations and commits them only when every item succeeds. */
function createBatchProvider(generations: Map<string, number>): AtomicBatchProvider<BatchCommand> {
  return {
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
    repository: () => {
      throw new Error("repositories are not used by these batch contracts")
    },
    executeAtomicBatch: async (plan: AtomicBatchPlan<BatchCommand>) => {
      const staged = new Map(generations)
      const results: AtomicBatchItemResult[] = []
      for (const item of plan.items) {
        if (item.kind === "cache-generation") {
          const next = (staged.get(item.tag) ?? 0) + 1
          staged.set(item.tag, next)
          results.push({ kind: "cache-generation", result: next })
        } else if (item.kind === "command" && item.command.op === "noop") {
          results.push({ kind: "command", result: null })
        } else if (item.kind === "command") {
          throw new Error("injected batch failure")
        } else {
          throw new Error(`unsupported batch item ${item.kind}`)
        }
      }
      generations.clear()
      for (const [tag, generation] of staged) generations.set(tag, generation)
      return results
    },
  }
}

const outboxRecord: OutboxRecord = {
  id: "outbox-shared-1",
  type: "row.created",
  version: 1,
  tenantId: "tenant-a",
  scope: { kind: "tenant", tenantId: "tenant-a" },
  scopeId: "fscope:v1:eyJraW5kIjoidGVuYW50IiwidGVuYW50SWQiOiJ0ZW5hbnQtYSJ9" as never,
  aggregateType: "row",
  aggregateId: "row-1",
  payload: { value: "created" },
  idempotencyKey: "row-1-created",
  occurredAt: new Date("2026-01-01T00:00:00.000Z"),
}

const auditRecord: AuditRecord = {
  id: "audit-shared-1",
  occurredAt: new Date("2026-01-01T00:00:00.000Z"),
  action: "create",
  resourceType: "framework_contract_rows",
  resourceId: "row-1",
  actor: {
    id: "user-1",
    kind: "human",
    authentication: {
      kind: "authenticated",
      method: "contract-test",
      authenticatedAt: "2026-09-10T00:00:00.000Z",
    },
  },
  tenantId: "tenant-a",
  oldValue: null,
  newValue: { value: "created" },
}

const auditStore = new Map<string, AuditRecord>()

runIdempotencyTransitionContractTests("in-memory idempotency", {
  createStore: () => createIdempotencyStore(),
})
runIdempotencyTransitionContractTests("in-memory idempotency with explicit request and lease", {
  createStore: () => createIdempotencyStore(),
  request: { scope: "custom-scope", key: "custom-key", fingerprint: "one" },
  waitForLeaseMs: 5,
})

runOutboxReplayContractTests("in-memory outbox", {
  createSink: () => createOutboxSink(),
  record: outboxRecord,
  conflictingRecord: { ...outboxRecord, payload: { value: "different" } },
})

runAuditGuaranteeContractTests("in-memory audit", {
  createSink: (): AuditSink => ({
    write: async (record: AuditRecord) => {
      auditStore.set(record.id, record)
    },
  }),
  record: auditRecord,
  readById: async (id: string) => auditStore.get(id) ?? null,
})

const generations = new Map<string, number>()
runCacheGenerationItemContractTests<BatchCommand>("in-memory batch provider", {
  createProvider: () => createBatchProvider(generations),
  createPlan: (): AtomicBatchPlan<BatchCommand> => ({ items: [{ kind: "cache-generation", tag: "generation-tag" }] }),
  readGeneration: async (tag: string) => generations.get(tag) ?? null,
})

const rollbackGenerations = new Map<string, number>()
runAtomicRollbackContractTests<BatchCommand>("in-memory batch provider", {
  createProvider: () => createBatchProvider(rollbackGenerations),
  createPlan: (): AtomicBatchPlan<BatchCommand> => ({
    items: [
      { kind: "cache-generation", tag: "rolled-back-tag" },
      { kind: "command", command: { op: "fail" } },
    ],
  }),
  assertRolledBack: () => {
    expect(rollbackGenerations.has("rolled-back-tag")).toBe(false)
  },
})

describe("in-memory shared conformance fakes", () => {
  it("rejects a conflicting outbox replay without losing the original record", async () => {
    const sink = createOutboxSink()
    await sink.append(outboxRecord)
    await expect(sink.append({ ...outboxRecord, payload: { value: "other" } })).rejects.toThrow("conflicts")
  })

  it("fences a stale reservation token after takeover", async () => {
    const store = createIdempotencyStore<string>()
    const first = await store.acquire({ scope: "s", key: "k", fingerprint: "f", leaseDurationMs: 1 })
    expect(first.outcome).toBe("acquired")
    await new Promise((resolve) => setTimeout(resolve, 15))
    const second = await store.acquire({ scope: "s", key: "k", fingerprint: "f" })
    expect(second.outcome).toBe("acquired")
    if (first.outcome !== "acquired" || second.outcome !== "acquired") throw new Error("expected reservations")
    await expect(store.complete({ scope: "s", key: "k", fingerprint: "f", token: first.token, result: "stale" })).rejects.toThrow("fenced")
  })

  it("reports in-progress for an unexpired reservation", async () => {
    const store = createIdempotencyStore<string>()
    await store.acquire({ scope: "s", key: "busy", fingerprint: "f" })
    await expect(store.acquire({ scope: "s", key: "busy", fingerprint: "f" })).resolves.toEqual({ outcome: "in-progress" })
  })

  it("rejects a batch item the fake does not support", async () => {
    const provider = createBatchProvider(new Map())
    await expect(provider.executeAtomicBatch({ items: [{ kind: "audit", record: auditRecord }] })).rejects.toThrow("unsupported batch item audit")
  })
})
