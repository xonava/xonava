import { describe, expect, it, vi } from "vitest"
import { PgDialect, pgTable, text } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
import { ConfigurationError } from "@xonava/core/domain"
import type { OutboxRecord } from "@xonava/core/events"
import { createDrizzleOutboxSinkFactory, DrizzleOutboxSink, computeOutboxFingerprint } from "../drizzleOutboxSink"
import { createDrizzlePersistenceProvider, DrizzleEntityRegistry } from "../drizzlePersistenceProvider"
import type { DrizzleSessionLike } from "../drizzleRepository"
import { createScriptedDb } from "../../__tests__/support/scriptedDb"

const tenantTable = pgTable("outbox_events", {
  id: text("id"),
  tenantId: text("tenant_id"),
  idempotencyKey: text("idempotency_key"),
  eventFingerprint: text("event_fingerprint"),
})
const dualTable = pgTable("outbox_events", {
  id: text("id"),
  tenantId: text("tenant_id"),
  idempotencyScope: text("idempotency_scope"),
  idempotencyKey: text("idempotency_key"),
  eventFingerprint: text("event_fingerprint"),
})
const scopeTable = pgTable("outbox_events", {
  id: text("id"),
  idempotencyScope: text("idempotency_scope"),
  idempotencyKey: text("idempotency_key"),
  eventFingerprint: text("event_fingerprint"),
})

const record: OutboxRecord = {
  id: "event-1",
  type: "appointment.created",
  version: 1,
  tenantId: "tenant-1",
  scope: { kind: "tenant", tenantId: "tenant-1" },
  scopeId: "fscope:v1:eyJraW5kIjoidGVuYW50IiwidGVuYW50SWQiOiJ0ZW5hbnQtMSJ9" as never,
  aggregateType: "appointment",
  aggregateId: "appointment-1",
  payload: { a: 1 },
  idempotencyKey: "key-1",
  occurredAt: new Date("2026-08-10T00:00:00Z"),
}

function build(insertResult: unknown, rows: unknown[] = []) {
  let inserted: Record<string, unknown> | undefined
  let whereArg: SQL | undefined
  const where = vi.fn((arg: SQL) => { whereArg = arg; return { limit: async () => rows } })
  const db = {
    insert: () => ({ values: (data: Record<string, unknown>) => { inserted = data; return { onConflictDoNothing: async () => insertResult } } }),
    select: () => ({ from: () => ({ where }) }),
  } as unknown as DrizzleSessionLike
  return { db, inserted: () => inserted, rendered: () => { const q = new PgDialect().sqlToQuery(whereArg!); return { sql: q.sql, params: q.params } }, where }
}

const mapper = () => ({})

describe("DrizzleOutboxSink inserted row", () => {
  it("writes exactly the framework-owned identity columns for a table with tenant and scope columns", async () => {
    const f = build({ rowCount: 1 })
    await new DrizzleOutboxSink(f.db, dualTable, mapper).append(record)
    expect(f.inserted()).toEqual({
      id: "event-1",
      tenantId: "tenant-1",
      idempotencyScope: record.scopeId,
      idempotencyKey: "key-1",
      eventFingerprint: await computeOutboxFingerprint(record),
    })
  })

  it("does not write tenantId or idempotencyScope when the table lacks those columns", async () => {
    const tenantOnly = build({ rowCount: 1 })
    await new DrizzleOutboxSink(tenantOnly.db, tenantTable, mapper).append(record)
    expect(Object.keys(tenantOnly.inserted()!).sort()).toEqual(["eventFingerprint", "id", "idempotencyKey", "tenantId"])
    const scopeOnly = build({ rowCount: 1 })
    await new DrizzleOutboxSink(scopeOnly.db, scopeTable, mapper).append(record)
    expect(Object.keys(scopeOnly.inserted()!).sort()).toEqual(["eventFingerprint", "id", "idempotencyKey", "idempotencyScope"])
  })

  it("rejects a Drizzle build without onConflictDoNothing", async () => {
    const db = { insert: () => ({ values: () => ({}) }) } as unknown as DrizzleSessionLike
    await expect(new DrizzleOutboxSink(db, tenantTable, mapper).append(record)).rejects.toThrow(
      new ConfigurationError("PostgreSQL outbox requires Drizzle onConflictDoNothing support"),
    )
  })
})

describe("DrizzleOutboxSink preconditions", () => {
  it("checks the scope identity before mapping the record or touching the database", async () => {
    const mapRecord = vi.fn(() => ({}))
    const f = build({ rowCount: 1 })
    const forged = { ...record, scopeId: "fscope:v1:forged" as never }
    await expect(new DrizzleOutboxSink(f.db, tenantTable, mapRecord).append(forged)).rejects.toThrow("outbox scope identity mismatch")
    expect(mapRecord).not.toHaveBeenCalled()
    expect(f.inserted()).toBeUndefined()
  })

  it("requires a scope column and an idempotency key column", async () => {
    const noKey = pgTable("outbox_events", { id: text("id"), tenantId: text("tenant_id") })
    const noScope = pgTable("outbox_events", { id: text("id"), idempotencyKey: text("idempotency_key") })
    for (const bad of [noKey, noScope]) {
      await expect(new DrizzleOutboxSink(build({ rowCount: 1 }).db, bad, mapper).append(record)).rejects.toThrow(
        new ConfigurationError("PostgreSQL outbox requires tenantId or idempotencyScope and idempotencyKey columns"),
      )
    }
  })
})

describe("DrizzleOutboxSink conflict handling", () => {
  it("returns without re-reading when rows were inserted (nonzero rowCount)", async () => {
    const f = build({ rowCount: 1 })
    await new DrizzleOutboxSink(f.db, tenantTable, mapper).append(record)
    expect(f.where).not.toHaveBeenCalled()
  })

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 1],
    ["an object without rowCount", {}],
  ])("re-reads the stored row when the insert result is %s", async (_label, insertResult) => {
    const f = build(insertResult, [{ eventFingerprint: "someone-else" }])
    await expect(new DrizzleOutboxSink(f.db, tenantTable, mapper).append(record)).rejects.toMatchObject({ code: "CONFLICT" })
    expect(f.where).toHaveBeenCalledTimes(1)
  })

  it("looks the existing event up by scope and idempotency key with null-safe equality", async () => {
    const f = build({ rowCount: 0 }, [{ eventFingerprint: await computeOutboxFingerprint(record) }])
    await new DrizzleOutboxSink(f.db, tenantTable, mapper).append(record)
    expect(f.rendered()).toEqual({
      sql: '"outbox_events"."tenant_id" IS NOT DISTINCT FROM $1 AND "outbox_events"."idempotency_key" = $2',
      params: ["tenant-1", "key-1"],
    })
    const scoped = build({ rowCount: 0 }, [{ eventFingerprint: await computeOutboxFingerprint(record) }])
    await new DrizzleOutboxSink(scoped.db, dualTable, mapper).append(record)
    expect(scoped.rendered()).toEqual({
      sql: '"outbox_events"."idempotency_scope" IS NOT DISTINCT FROM $1 AND "outbox_events"."idempotency_key" = $2',
      params: [record.scopeId, "key-1"],
    })
  })

  it("reads the stored fingerprint from either the camelCase or the snake_case key", async () => {
    const fingerprint = await computeOutboxFingerprint(record)
    const snake = build({ rowCount: 0 }, [{ event_fingerprint: fingerprint }])
    await expect(new DrizzleOutboxSink(snake.db, tenantTable, mapper).append(record)).resolves.toBeUndefined()
    const wrongSnake = build({ rowCount: 0 }, [{ event_fingerprint: "different" }])
    await expect(new DrizzleOutboxSink(wrongSnake.db, tenantTable, mapper).append(record)).rejects.toMatchObject({ code: "CONFLICT" })
    const camel = build({ rowCount: 0 }, [{ eventFingerprint: fingerprint, event_fingerprint: "different" }])
    await expect(new DrizzleOutboxSink(camel.db, tenantTable, mapper).append(record)).resolves.toBeUndefined()
  })

  it("reports a missing stored fingerprint when no row can be re-read", async () => {
    const f = build({ rowCount: 0 }, [])
    await expect(new DrizzleOutboxSink(f.db, tenantTable, mapper).append(record)).rejects.toThrow("migrate fingerprints")
  })
})

describe("createDrizzleOutboxSinkFactory", () => {
  it("creates a sink bound to the provider's session and the mapper", async () => {
    const scripted = createScriptedDb("pg", () => ({ rowCount: 1 }))
    const provider = createDrizzlePersistenceProvider({ db: scripted.db as never, registry: new DrizzleEntityRegistry() })
    const sink = createDrizzleOutboxSinkFactory(tenantTable, (value) => ({ tenantId: value.tenantId })).create(provider)
    await sink.append(record)
    expect(scripted.ops).toHaveLength(1)
    expect(scripted.ops[0]!.kind).toBe("insert")
    expect(scripted.ops[0]!.values).toMatchObject({ id: "event-1", tenantId: "tenant-1", idempotencyKey: "key-1" })
    expect(() => createDrizzleOutboxSinkFactory(tenantTable, mapper).create({} as never)).toThrow("No Drizzle session found")
  })
})
