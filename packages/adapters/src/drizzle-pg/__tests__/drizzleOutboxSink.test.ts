import { describe, expect, it, vi } from "vitest"
import { pgTable, text } from "drizzle-orm/pg-core"
import { ConfigurationError } from "@xonava/core/domain"
import { DrizzleOutboxSink, computeOutboxFingerprint } from "../drizzleOutboxSink"
import type { DrizzleSessionLike } from "../drizzleRepository"
import type { OutboxRecord } from "@xonava/core/events"
import { canonicalizeValue } from "@xonava/core/serialization"

const tenantOutboxTable = pgTable("outbox_events", {
  id: text("id"),
  tenantId: text("tenant_id"),
  eventType: text("event_type"),
  eventVersion: text("event_version"),
  aggregateType: text("aggregate_type"),
  aggregateId: text("aggregate_id"),
  payload: text("payload"),
  idempotencyKey: text("idempotency_key"),
  eventFingerprint: text("event_fingerprint"),
})

const scopedOutboxTable = pgTable("outbox_events", {
  id: text("id"),
  idempotencyScope: text("idempotency_scope"),
  idempotencyKey: text("idempotency_key"),
  eventFingerprint: text("event_fingerprint"),
})

const dualScopeOutboxTable = pgTable("outbox_events", {
  id: text("id"),
  tenantId: text("tenant_id"),
  idempotencyScope: text("idempotency_scope"),
  idempotencyKey: text("idempotency_key"),
  eventFingerprint: text("event_fingerprint"),
})

const unsupportedOutboxTable = pgTable("outbox_events", {
  id: text("id"),
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
  payload: { nested: { b: 2, a: 1 } },
  idempotencyKey: "appointment-1-created",
  occurredAt: new Date("2026-08-10T00:00:00Z"),
}

function createDb(insertResult: unknown = { rowCount: 1 }, rows: unknown[] = []) {
  let inserted: unknown
  const onConflictDoNothing = vi.fn(async () => insertResult)
  const values = vi.fn((data: unknown) => {
    inserted = data
    return { onConflictDoNothing }
  })
  const insert = vi.fn(() => ({ values }))
  const where = vi.fn(() => ({ limit: async () => rows }))
  const db = {
    insert,
    select: () => ({ from: () => ({ where }) }),
  } as unknown as DrizzleSessionLike
  return { db, insert, onConflictDoNothing, where, getInserted: () => inserted }
}

function mappedRecord(outboxRecord: OutboxRecord) {
  return {
    tenantId: outboxRecord.tenantId,
    eventType: outboxRecord.type,
    eventVersion: outboxRecord.version,
    aggregateType: outboxRecord.aggregateType,
    aggregateId: outboxRecord.aggregateId,
    payload: JSON.stringify(outboxRecord.payload),
    idempotencyKey: outboxRecord.idempotencyKey,
  }
}

describe("PostgreSQL outbox idempotency", () => {
  it("uses tenant columns for tenant-scoped tables", async () => {
    const { db, onConflictDoNothing, getInserted } = createDb()

    await new DrizzleOutboxSink(db, tenantOutboxTable, mappedRecord).append(record)

    expect(onConflictDoNothing).toHaveBeenCalledWith({ target: [tenantOutboxTable.tenantId, tenantOutboxTable.idempotencyKey] })
    expect((getInserted() as Record<string, unknown>).eventFingerprint).toBe(await computeOutboxFingerprint(record))
  })

  it("uses scope columns for scope-only tables and checks the existing fingerprint", async () => {
    const fingerprint = await computeOutboxFingerprint(record)
    const { db, onConflictDoNothing, where } = createDb({ rowCount: 0 }, [{ eventFingerprint: fingerprint }])

    await expect(new DrizzleOutboxSink(db, scopedOutboxTable, (value) => ({
      idempotencyScope: value.scopeId,
      idempotencyKey: value.idempotencyKey,
    })).append(record)).resolves.toBeUndefined()
    expect(onConflictDoNothing).toHaveBeenCalledWith({ target: [scopedOutboxTable.idempotencyScope, scopedOutboxTable.idempotencyKey] })
    expect(where).toHaveBeenCalled()
  })

  it.each([
    ["id", "mapper-id"],
    ["tenantId", "tenant-attacker"],
    ["idempotencyScope", "scope-attacker"],
    ["idempotencyKey", "key-attacker"],
    ["eventFingerprint", "fingerprint-attacker"],
  ])("rejects a mapper override of framework-owned %s before insertion", async (field, value) => {
    const { db, insert } = createDb()

    await expect(new DrizzleOutboxSink(db, tenantOutboxTable, () => ({ [field]: value })).append(record))
      .rejects.toThrow(`framework-owned ${field}`)
    expect(insert).not.toHaveBeenCalled()
  })

  it("does not allow the mapper to spoof the framework-owned scope", async () => {
    const { db } = createDb()

    await expect(new DrizzleOutboxSink(db, dualScopeOutboxTable, (value) => ({
      tenantId: value.tenantId,
      idempotencyScope: "tenant-attacker",
      idempotencyKey: value.idempotencyKey,
    })).append(record)).rejects.toThrow("framework-owned")
  })

  it("prefers an explicit scope column when tenantId is also mapped", async () => {
    const { db, onConflictDoNothing, getInserted } = createDb()
    const mapped = (value: OutboxRecord) => ({
      tenantId: value.tenantId,
      idempotencyScope: value.scopeId,
      idempotencyKey: value.idempotencyKey,
    })
    await new DrizzleOutboxSink(db, dualScopeOutboxTable, mapped).append(record)
    expect(onConflictDoNothing).toHaveBeenCalledWith({ target: [dualScopeOutboxTable.idempotencyScope, dualScopeOutboxTable.idempotencyKey] })
    expect((getInserted() as Record<string, unknown>).idempotencyScope).toBe(record.scopeId)
  })

  it("rejects a reused key with a different fingerprint", async () => {
    const { db } = createDb({ rowCount: 0 }, [{ eventFingerprint: "different" }])

    await expect(new DrizzleOutboxSink(db, tenantOutboxTable, mappedRecord).append(record)).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("requires an idempotency scope capability", async () => {
    const { db } = createDb()

    await expect(new DrizzleOutboxSink(db, unsupportedOutboxTable, mappedRecord).append(record)).rejects.toBeInstanceOf(ConfigurationError)
  })

  it("fails closed for platform events without an explicit scope column", async () => {
    const { db } = createDb()

    await expect(new DrizzleOutboxSink(db, tenantOutboxTable, mappedRecord).append({ ...record, tenantId: null }))
      .rejects.toThrow("platform outbox events require an idempotencyScope column")
  })

  it("requires migration when the stored fingerprint is missing", async () => {
    const { db } = createDb({ rowCount: 0 }, [{ eventFingerprint: null }])

    await expect(new DrizzleOutboxSink(db, tenantOutboxTable, mappedRecord).append(record)).rejects.toThrow("migrate fingerprints")
  })

  it("stores a versioned v3 (RFC 8785 key order) canonical fingerprint", async () => {
    expect((await computeOutboxFingerprint(record)).startsWith("v3:")).toBe(true)
  })

  describe("idempotent append by stored fingerprint", () => {
    const numeric = { ...record, payload: { "10": "ten", "9": "nine" } } as OutboxRecord
    /** What a v2 writer stored (JavaScript property order, so "9" before "10"); kept to assert that it is no longer accepted. */
    const storedV2 = async (value: OutboxRecord): Promise<string> => {
      const text = JSON.stringify(canonicalizeValue({ type: value.type, version: value.version, scopeId: value.scopeId, aggregateType: value.aggregateType, aggregateId: value.aggregateId, payload: value.payload }))
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
      return `v2:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
    }

    it("replays an identical event whose stored fingerprint is the current version", async () => {
      const { db } = createDb({ rowCount: 0 }, [{ eventFingerprint: await computeOutboxFingerprint(numeric) }])
      await expect(new DrizzleOutboxSink(db, tenantOutboxTable, mappedRecord).append(numeric)).resolves.toBeUndefined()
    })

    it("rejects a different event under the current-version fingerprint", async () => {
      const { db } = createDb({ rowCount: 0 }, [{ eventFingerprint: await computeOutboxFingerprint({ ...numeric, payload: { "10": "other" } } as OutboxRecord) }])
      await expect(new DrizzleOutboxSink(db, tenantOutboxTable, mappedRecord).append(numeric)).rejects.toThrow(/different event/)
    })

    it("no longer recognises a v2 fingerprint of the same event", async () => {
      expect(await storedV2(numeric)).not.toBe((await computeOutboxFingerprint(numeric)).replace(/^v3:/, "v2:"))
      const { db } = createDb({ rowCount: 0 }, [{ eventFingerprint: await storedV2(numeric) }])
      await expect(new DrizzleOutboxSink(db, tenantOutboxTable, mappedRecord).append(numeric)).rejects.toThrow(/different event/)
    })
  })
})
