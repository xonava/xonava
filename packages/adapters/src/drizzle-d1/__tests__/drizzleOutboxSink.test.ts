import { describe, expect, it, vi } from "vitest"
import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { OutboxRecord } from "@xonava/core/events"
import { ConfigurationError } from "@xonava/core/domain"
import type { DrizzleSessionLike } from "../drizzleRepository"
import { DrizzleOutboxSink } from "../drizzleOutboxSink"

const outboxTable = sqliteTable("outbox_events", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  idempotencyScope: text("idempotency_scope").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  eventFingerprint: text("event_fingerprint"),
  eventType: text("event_type").notNull(),
  eventVersion: text("event_version").notNull(),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: text("aggregate_id").notNull(),
  payload: text("payload").notNull(),
}, (table) => [uniqueIndex("outbox_idempotency_unique").on(table.idempotencyScope, table.idempotencyKey)])

const record: OutboxRecord = {
  id: "event-1",
  type: "appointment.created",
  version: 1,
  tenantId: "tenant-1",
  scope: { kind: "tenant", tenantId: "tenant-1" },
  scopeId: "fscope:v1:eyJraW5kIjoidGVuYW50IiwidGVuYW50SWQiOiJ0ZW5hbnQtMSJ9" as never,
  aggregateType: "appointment",
  aggregateId: "appointment-1",
  payload: { nested: { value: "created" }, order: 1 },
  idempotencyKey: "appointment.created:appointment-1",
  occurredAt: new Date("2026-08-01T00:00:00Z"),
}

function dbWith(existing: Record<string, unknown> | undefined, insertResult: unknown = existing ? { meta: { changes: 0 } } : { meta: { changes: 1 } }) {
  const limit = vi.fn(async () => existing ? [existing] : [])
  const insertedValues: unknown[] = []
  const values = vi.fn((data: unknown) => {
    insertedValues.push(data)
    return { onConflictDoNothing }
  })
  const onConflictDoNothing = vi.fn(async () => insertResult)
  const db = {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })) })),
    insert: vi.fn(() => ({ values, onConflictDoNothing })),
  } as unknown as DrizzleSessionLike
  return { db, values, onConflictDoNothing, insertedValues }
}

describe("D1 outbox idempotency", () => {
  it("requires the framework-owned id column", async () => {
    const tableWithoutId = sqliteTable("outbox_events", {
      idempotencyScope: text("idempotency_scope").notNull(),
      idempotencyKey: text("idempotency_key").notNull(),
    })
    const { db } = dbWith(undefined)

    await expect(new DrizzleOutboxSink(db, tableWithoutId, () => ({})).append(record))
      .rejects.toBeInstanceOf(ConfigurationError)
    expect(db.insert).not.toHaveBeenCalled()
  })

  it("requires the explicit idempotency columns", async () => {
    const tableWithoutScope = sqliteTable("outbox_events", { id: text("id") })
    const { db } = dbWith(undefined)

    await expect(new DrizzleOutboxSink(db, tableWithoutScope, () => ({})).append(record))
      .rejects.toThrow("requires idempotencyScope and idempotencyKey columns")
  })

  it("generates an id when the normalized record does not provide one", async () => {
    const { db, insertedValues } = dbWith(undefined)
    const generatedRecord = { ...record, id: undefined } as unknown as OutboxRecord

    await new DrizzleOutboxSink(db, outboxTable, () => ({})).append(generatedRecord)

    expect((insertedValues[0] as Record<string, unknown>).id).toEqual(expect.any(String))
  })

  it("accepts a replay with the same logical event fingerprint", async () => {
    const first = dbWith(undefined)
    const sink = new DrizzleOutboxSink(first.db, outboxTable, () => ({}))
    await sink.append(record)
    const fingerprint = (first.insertedValues[0] as Record<string, unknown>).eventFingerprint
    const replay = dbWith({ ...record, eventType: record.type, eventVersion: record.version, eventFingerprint: fingerprint })

    await new DrizzleOutboxSink(replay.db, outboxTable, () => ({})).append({ ...record, payload: { order: 1, nested: { value: "created" } } })
    expect(replay.values).toHaveBeenCalled()
  })

  it("rejects a different event using the same idempotency key", async () => {
    const existing = dbWith(undefined)
    await new DrizzleOutboxSink(existing.db, outboxTable, () => ({})).append(record)
    const fingerprint = (existing.insertedValues[0] as Record<string, unknown>).eventFingerprint
    const replay = dbWith({ ...record, eventType: record.type, eventVersion: record.version, eventFingerprint: fingerprint })

    await expect(new DrizzleOutboxSink(replay.db, outboxTable, () => ({})).append({ ...record, aggregateId: "appointment-2" })).rejects.toThrow("Outbox idempotency key was reused")
  })

  it("fails closed when Drizzle cannot perform conflict-safe insertion", async () => {
    const { db } = dbWith(undefined)
    ;(db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values: vi.fn(() => ({})) })

    await expect(new DrizzleOutboxSink(db, outboxTable, () => ({})).append(record)).rejects.toBeInstanceOf(ConfigurationError)
  })

  it.each([
    ["id", "mapper-id"],
    ["tenantId", "tenant-attacker"],
    ["idempotencyScope", "scope-attacker"],
    ["idempotencyKey", "key-attacker"],
    ["eventFingerprint", "fingerprint-attacker"],
  ])("rejects a mapper override of framework-owned %s before insertion", async (field, value) => {
    const db = dbWith(undefined).db
    const insert = db.insert as ReturnType<typeof vi.fn>

    await expect(new DrizzleOutboxSink(db, outboxTable, () => ({ [field]: value })).append(record))
      .rejects.toThrow(`framework-owned ${field}`)
    expect(insert).not.toHaveBeenCalled()
  })

  it("resolves a raced platform replay by fingerprint", async () => {
    const racedRecord = {
      ...record,
      tenantId: null,
      idempotencyKey: "platform-event-1",
    }
    const first = dbWith(undefined)
    await new DrizzleOutboxSink(first.db, outboxTable, () => ({})).append(racedRecord)
    const fingerprint = (first.insertedValues[0] as Record<string, unknown>).eventFingerprint
    const existing = {
      ...racedRecord,
      tenantId: null,
      idempotencyScope: "__platform__",
      eventType: racedRecord.type,
      eventVersion: racedRecord.version,
      eventFingerprint: fingerprint,
    }
    const selectLimit = vi.fn().mockResolvedValueOnce([existing])
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: selectLimit })) })) })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoNothing: vi.fn(async () => ({ meta: { changes: 0 } })),
        })),
      })),
    } as unknown as DrizzleSessionLike

    await expect(new DrizzleOutboxSink(db, outboxTable, () => ({})).append(racedRecord)).resolves.toBeUndefined()
  })

  it("rejects a raced platform conflict with a different fingerprint", async () => {
    const selectLimit = vi.fn().mockResolvedValueOnce([{ tenantId: null, eventFingerprint: "different" }])
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: selectLimit })) })) })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoNothing: vi.fn(async () => ({ meta: { changes: 0 } })),
        })),
      })),
    } as unknown as DrizzleSessionLike

    await expect(new DrizzleOutboxSink(db, outboxTable, () => ({})).append({
      ...record,
      tenantId: null,
      idempotencyKey: "platform-event-2",
    })).rejects.toThrow("Outbox idempotency key was reused")
  })

  it("requires migration when a raced row has no fingerprint", async () => {
    const { db } = dbWith({ tenantId: null, eventFingerprint: null })

    await expect(new DrizzleOutboxSink(db, outboxTable, () => ({})).append({
      ...record,
      tenantId: null,
      idempotencyKey: "platform-event-missing-fingerprint",
    })).rejects.toThrow("migrate fingerprints")
  })
})
