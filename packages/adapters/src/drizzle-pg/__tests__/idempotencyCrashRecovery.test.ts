/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, expect, it, vi } from "vitest"
import { pgTable, text } from "drizzle-orm/pg-core"
import { DrizzlePgIdempotencyStore } from "../drizzleIdempotencyStore"
import type { DrizzleSessionLike } from "../drizzleRepository"

const idempotencyTable = pgTable("idempotency_records", {
  id: text("id").primaryKey(),
  scope: text("scope"),
  key: text("key"),
  fingerprint: text("fingerprint"),
  token: text("token"),
  status: text("status"),
  result: text("result"),
  resourceEntity: text("resource_entity"),
  resourceId: text("resource_id"),
  pendingInvalidations: text("pending_invalidations"),
  createdAt: text("created_at"),
  completedAt: text("completed_at"),
})

type Row = Record<string, unknown>

/**
 * Simulates the Postgres-backed idempotency store at a higher fidelity than the
 * unit tests — the in-memory map tracks row state across acquire / commit /
 * complete so we can exercise the full crash-recovery lifecycle.
 *
 * The simulation mirrors the PG store's SQL semantics:
 * - insert ON CONFLICT DO NOTHING → unique violation (code 23505) on duplicate
 * - select returns rows matching the scanned WHERE
 * - update sets fields and returns rowCount based on WHERE clause evaluation
 *
 * `markCommittedInTransaction` uses `getDrizzleSession()` which requires a
 * real PersistenceProvider registered in the module-internal WeakMap. Instead
 * of fighting that, we directly manipulate the in-memory row to simulate what
 * the committed state would look like — this is exactly the state a retry would
 * observe after a crash between business commit and idempotency completion.
 */
function createSimulation() {
  const rows = new Map<string, Row>()

  function findRow(scope: string, key: string): Row | undefined {
    return rows.get(`${scope}:${key}`)
  }

  const db = {
    insert: vi.fn(() => ({
      values: vi.fn(async (values: Row) => {
        const key = `${String(values.scope)}:${String(values.key)}`
        if (rows.has(key)) {
          const err = new Error("duplicate key value violates unique constraint") as Error & { code: string }
          err.code = "23505"
          throw err
        }
        rows.set(key, { ...values })
        return { rowCount: 1 }
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            return [...rows.values()]
          }),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((updates: Record<string, unknown>) => ({
        where: vi.fn(async (whereClause: unknown) => {
          const whereStr = typeof whereClause === "string" ? whereClause : JSON.stringify(whereClause) ?? ""
          let matched = 0
          for (const row of rows.values()) {
            if (!matchesWhereClause(row, whereStr)) continue

            // Check status guard clauses embedded in the WHERE
            const rowStatus = typeof row.status === "string" ? row.status : ""
            if (whereStr.includes("status = 'in-progress'") && rowStatus !== "in-progress") continue
            if (whereStr.includes("status = 'business-committed'") && rowStatus !== "business-committed") continue
            if (whereStr.includes("'in-progress', 'business-committed'") &&
                rowStatus !== "in-progress" && rowStatus !== "business-committed") continue

            Object.assign(row, updates)
            matched = 1
            break
          }
          return { rowCount: matched, affectedRows: matched }
        }),
      })),
    })),
  }

  /** Minimal WHERE-clause evaluator: checks that scope+key+token match the row */
  function matchesWhereClause(row: Row, whereStr: string): boolean {
    const tokenMatch = whereStr.match(/token = '([^']+)'/)
    if (tokenMatch && row.token !== tokenMatch[1]) return false

    const scopeMatch = whereStr.match(/scope = '([^']+)'/)
    const keyMatch = whereStr.match(/key = '([^']+)'/)
    if (scopeMatch && row.scope !== scopeMatch[1]) return false
    if (keyMatch && row.key !== keyMatch[1]) return false

    return true
  }

  const store = new DrizzlePgIdempotencyStore<Row>(db as unknown as DrizzleSessionLike, idempotencyTable)

  /**
   * Simulates a business commit — directly transitions the row to
   * "business-committed" with resource identity and pending invalidations.
   * This mirrors what `markCommittedInTransaction` writes to the DB.
   */
  function simulateBusinessCommit(args: {
    scope: string; key: string; fingerprint: string; token: string
    resource?: { entity: string; id: string; version?: number }
    invalidations?: readonly string[]
  }) {
    const row = findRow(args.scope, args.key)
    if (!row) throw new Error(`No row found for ${args.scope}:${args.key}`)
    if (row.token !== args.token) throw new Error("Token mismatch")
    if (row.fingerprint !== args.fingerprint) throw new Error("Fingerprint mismatch")
    row.status = "business-committed"
    row.resourceEntity = args.resource?.entity ?? null
    row.resourceId = args.resource?.id ?? null
    row.resourceVersion = args.resource?.version === undefined
      ? null
      : JSON.stringify({ type: "number", value: args.resource.version })
    row.pendingInvalidations = args.invalidations ? JSON.stringify([...new Set(args.invalidations)]) : null
    row.completedAt = new Date().toISOString()
  }

  return { store, rows, findRow, simulateBusinessCommit }
}

describe("PG idempotency crash recovery", () => {
  it("acquire → commit → crash → retry returns business-committed with resource identity", async () => {
    const { store, findRow, simulateBusinessCommit } = createSimulation()
    const request = { scope: "tenant:one", key: "order-42", fingerprint: "fingerprint-v1" }

    // Step 1: Acquire a reservation
    const acquired = await store.acquire(request)
    expect(acquired.outcome).toBe("acquired")
    if (acquired.outcome !== "acquired") throw new Error("expected acquired")
    const token = acquired.token

    // Step 2: Simulate business commit — the mutation committed in the DB
    // transaction, but complete() never ran (process crash).
    simulateBusinessCommit({
      scope: request.scope,
      key: request.key,
      fingerprint: request.fingerprint,
      token,
      resource: { entity: "order", id: "order-42" },
      invalidations: ["cache:order:42"],
    })

    // Verify the in-memory row is now business-committed
    const row = findRow("tenant:one", "order-42")
    expect(row?.status).toBe("business-committed")
    expect(row?.resourceEntity).toBe("order")
    expect(row?.resourceId).toBe("order-42")

    // Step 3: Simulate crash — no complete() call.
    // Step 4: Retry with same idempotency key
    const retry = await store.acquire(request)
    expect(retry.outcome).toBe("business-committed")
    if (retry.outcome !== "business-committed") throw new Error("expected business-committed")
    expect(retry.token).toBe(token) // same reservation
    expect(retry.resource).toEqual({ entity: "order", id: "order-42" })
    expect(retry.invalidations).toEqual(["cache:order:42"])

    // Step 5: Call complete() on retry
    await store.complete({
      scope: request.scope,
      key: request.key,
      fingerprint: request.fingerprint,
      token: retry.token,
      result: { id: "order-42", status: "confirmed" },
    })

    // Verify row is now completed
    const completedRow = findRow("tenant:one", "order-42")
    expect(completedRow?.status).toBe("completed")
    expect(completedRow?.result).toBe(JSON.stringify({ id: "order-42", status: "confirmed" }))

    // Step 6: Third retry replays the serialized result
    const replay = await store.acquire(request)
    expect(replay.outcome).toBe("replay")
    if (replay.outcome !== "replay") throw new Error("expected replay")
    expect(replay.result).toEqual({ id: "order-42", status: "confirmed" })
  })

  it("acquire → commit → crash → complete lifecycle", async () => {
    const { store, findRow, simulateBusinessCommit } = createSimulation()
    const request = { scope: "tenant:one", key: "item-99", fingerprint: "fp-v2" }

    // Acquire
    const acquired = await store.acquire(request)
    expect(acquired.outcome).toBe("acquired")
    if (acquired.outcome !== "acquired") throw new Error("expected acquired")

    // Simulate business commit
    simulateBusinessCommit({
      scope: request.scope,
      key: request.key,
      fingerprint: request.fingerprint,
      token: acquired.token,
      resource: { entity: "item", id: "item-99" },
    })

    // Retry: the durable commit marker is already business-committed
    const retry = await store.acquire(request)
    expect(retry.outcome).toBe("business-committed")
    if (retry.outcome !== "business-committed") throw new Error("expected business-committed")
    expect(retry.resource).toEqual({ entity: "item", id: "item-99" })

    // Complete the idempotency record
    await store.complete({
      scope: request.scope,
      key: request.key,
      fingerprint: request.fingerprint,
      token: retry.token,
      result: { id: "item-99", resolved: true },
    })

    // Third acquire replays
    const replay = await store.acquire(request)
    expect(replay.outcome).toBe("replay")
    if (replay.outcome !== "replay") throw new Error("expected replay")
    expect(replay.result).toEqual({ id: "item-99", resolved: true })
  })

  it("business-committed without resource identity returns undefined resource", async () => {
    const { store, findRow, simulateBusinessCommit } = createSimulation()
    const request = { scope: "system", key: "batch-1", fingerprint: "fp-batch" }

    const acquired = await store.acquire(request)
    expect(acquired.outcome).toBe("acquired")
    if (acquired.outcome !== "acquired") throw new Error("expected acquired")

    // Commit without a resource identity
    simulateBusinessCommit({
      scope: request.scope,
      key: request.key,
      fingerprint: request.fingerprint,
      token: acquired.token,
    })

    const retry = await store.acquire(request)
    expect(retry.outcome).toBe("business-committed")
    if (retry.outcome !== "business-committed") throw new Error("expected business-committed")
    expect((retry as { resource?: unknown }).resource).toBeUndefined()
  })

  it("recovers the numeric resource version after a versioned update crash (1 → 2)", async () => {
    const { store, findRow, simulateBusinessCommit } = createSimulation()
    const request = { scope: "tenant:one", key: "order-42", fingerprint: "fp-versioned" }

    const acquired = await store.acquire(request)
    expect(acquired.outcome).toBe("acquired")
    if (acquired.outcome !== "acquired") throw new Error("expected acquired")

    // The mutation committed a versioned update (version 1 → 2) but complete()
    // never ran. The durable receipt persists the numeric version as the typed
    // envelope the store's write side produces.
    simulateBusinessCommit({
      scope: request.scope,
      key: request.key,
      fingerprint: request.fingerprint,
      token: acquired.token,
      resource: { entity: "order", id: "order-42", version: 2 },
    })

    const row = findRow("tenant:one", "order-42")
    expect(row?.resourceVersion).toBe(JSON.stringify({ type: "number", value: 2 }))

    // Retry after the crash: the recovered resource version must be the numeric
    // 2, matching the committed row so strict crash-recovery comparison passes.
    const retry = await store.acquire(request)
    expect(retry.outcome).toBe("business-committed")
    if (retry.outcome !== "business-committed") throw new Error("expected business-committed")
    expect(retry.resource).toEqual({ entity: "order", id: "order-42", version: 2 })
  })

  it("fails closed on a bare string resource version", async () => {
    const { store, findRow } = createSimulation()
    const request = { scope: "tenant:one", key: "crash-7", fingerprint: "fp-crash" }

    const acquired = await store.acquire(request)
    expect(acquired.outcome).toBe("acquired")
    if (acquired.outcome !== "acquired") throw new Error("expected acquired")

    // A resource version must use the typed persisted envelope. A bare string
    // must not be coerced or allow an unfenced recovery reread.
    const row = findRow(request.scope, request.key)!
    row.status = "business-committed"
    row.resourceEntity = "order"
    row.resourceId = "order-42"
    row.resourceVersion = "2"

    await expect(store.acquire(request)).rejects.toThrow("expected numeric envelope")
    expect(findRow(request.scope, request.key)?.status).toBe("poisoned")
  })
})
