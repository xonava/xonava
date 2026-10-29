import { describe, expect, it } from "vitest"
import { drizzle } from "drizzle-orm/d1"
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { ConfigurationError, ConflictError } from "@xonava/core/domain"
import type { AuditRecord } from "@xonava/core/events"
import {
  createDrizzleAuditSinkFactory, createDrizzleOutboxSinkFactory, createDrizzlePersistenceProvider, DrizzleAuditSink, DrizzleEntityRegistry, DrizzleOutboxSink,
} from "@xonava/adapters/drizzle-d1"
import { createFakeD1 } from "../../__tests__/support/fakeD1"
import { createScriptedDb } from "../../__tests__/support/scriptedDb"
import { auditRecord, outbox, outboxRecord, setup } from "./sqliteFixture"

const norm = (sql: string | undefined) => (sql ?? "").replace(/\s+/g, " ")

describe("D1 audit sink", () => {
  const auditFull = sqliteTable("audit_full", {
    id: text("id").primaryKey(), createdAt: integer("created_at", { mode: "timestamp_ms" }), tenantId: text("tenant_id"), action: text("action"), resourceType: text("resource_type"),
    resourceId: text("resource_id"), actorId: text("actor_id"), actorType: text("actor_type"), impersonatedByAdminId: text("impersonated_by_admin_id"), oldValue: text("old_value"),
    newValue: text("new_value"), metadata: text("metadata"),
  })
  const SCHEMA = ["CREATE TABLE audit_full (id TEXT PRIMARY KEY, created_at INTEGER, tenant_id TEXT, action TEXT, resource_type TEXT, resource_id TEXT, actor_id TEXT, actor_type TEXT, impersonated_by_admin_id TEXT, old_value TEXT, new_value TEXT, metadata TEXT)"]

  it("writes the mapped record under the record id, overriding any mapped id", async () => {
    const { provider, row } = await setup()
    const mapper = (record: AuditRecord) => ({ id: "mapped-id", action: record.action, tenantId: record.tenantId })
    const sink = createDrizzleAuditSinkFactory(sqliteTable("dx_audit", { id: text("id").primaryKey(), action: text("action"), tenantId: text("tenant_id") }), mapper).create(provider)
    expect(sink).toBeInstanceOf(DrizzleAuditSink)
    await sink.write(auditRecord("aud-1"))
    expect(row("SELECT id, action, tenant_id FROM dx_audit")).toEqual({ id: "aud-1", action: "update", tenant_id: "t1" })
  })

  it("uses the default record mapper when none is supplied", async () => {
    const scripted = createScriptedDb("sqlite", () => [])
    await new DrizzleAuditSink(scripted.db as never, auditFull).write({ ...auditRecord("aud-2"), oldValue: { a: 1 }, newValue: null, metadata: { m: 1 } } as AuditRecord)
    expect(scripted.ops[0]!.values).toMatchObject({
      id: "aud-2", tenantId: "t1", action: "update", resourceType: "DxItem", resourceId: "a", actorId: "actor", actorType: "human", impersonatedByAdminId: null,
      oldValue: '{"a":1}', newValue: null, metadata: '{"m":1}',
    })
  })

  it("the factory without a mapper binds the sink to the provider session and writes with the default mapper", async () => {
    const d1 = createFakeD1(SCHEMA)
    const provider = createDrizzlePersistenceProvider({ db: drizzle(d1 as never), registry: new DrizzleEntityRegistry() })
    await createDrizzleAuditSinkFactory(auditFull).create(provider).write({ ...auditRecord("aud-3"), newValue: { v: 1 } } as AuditRecord)
    expect(d1.sqlite.prepare("SELECT id, tenant_id, action, actor_id, new_value FROM audit_full").get()).toEqual({ id: "aud-3", tenant_id: "t1", action: "update", actor_id: "actor", new_value: '{"v":1}' })
  })
})

describe("D1 outbox sink", () => {
  const sinkTable = sqliteTable("dx_outbox_sink", {
    id: text("id").primaryKey(), type: text("type"), payload: text("payload"), idempotencyScope: text("idempotency_scope"), idempotencyKey: text("idempotency_key"), eventFingerprint: text("event_fingerprint"),
  }, (t) => [uniqueIndex("dx_outbox_sink_identity").on(t.idempotencyScope, t.idempotencyKey)])
  const tenantSinkTable = sqliteTable("dx_outbox_tenant", {
    id: text("id").primaryKey(), tenantId: text("tenant_id"), type: text("type"), idempotencyScope: text("idempotency_scope"), idempotencyKey: text("idempotency_key"), eventFingerprint: text("event_fingerprint"),
  }, (t) => [uniqueIndex("dx_outbox_tenant_identity").on(t.idempotencyScope, t.idempotencyKey)])
  const map = (record: { type: string }) => ({ type: record.type })

  it("inserts with ON CONFLICT DO NOTHING keyed on the identity columns", async () => {
    const calls: { values: Record<string, unknown>; target: unknown }[] = []
    const db = {
      insert: () => ({ values: (values: Record<string, unknown>) => ({ onConflictDoNothing: async (config: { target: unknown }) => { calls.push({ values, target: config.target }); return { meta: { changes: 1 } } } }) }),
    }
    await new DrizzleOutboxSink(db as never, sinkTable, map).append(outboxRecord("o1", "k1"))
    expect(calls[0]!.target).toEqual([sinkTable.idempotencyScope, sinkTable.idempotencyKey])
    expect(calls[0]!.values).toMatchObject({ id: "o1", type: "dx.updated", idempotencyKey: "k1", eventFingerprint: expect.any(String) })
    expect(calls[0]!.values).not.toHaveProperty("tenantId")
  })

  it("stores the tenant only when the table has a tenant column", async () => {
    const scripted = createScriptedDb("sqlite", () => ({ meta: { changes: 1 } }))
    await new DrizzleOutboxSink(scripted.db as never, tenantSinkTable, map).append({ ...outboxRecord("o2", "k2"), tenantId: "t7" })
    expect(scripted.ops[0]!.values).toMatchObject({ id: "o2", tenantId: "t7" })
    const plain = createScriptedDb("sqlite", () => ({ meta: { changes: 1 } }))
    await new DrizzleOutboxSink(plain.db as never, sinkTable, map).append({ ...outboxRecord("o3", "k3"), tenantId: "t7" })
    expect(plain.ops[0]!.values).not.toHaveProperty("tenantId")
  })

  it("requires conflict-clause support from the session", async () => {
    const db = { insert: () => ({ values: () => ({}) }) }
    await expect(new DrizzleOutboxSink(db as never, sinkTable, map).append(outboxRecord("o4", "k4"))).rejects.toThrow(new ConfigurationError("D1 outbox requires Drizzle onConflictDoNothing support"))
    const notAFunction = { insert: () => ({ values: () => ({ onConflictDoNothing: "no" }) }) }
    await expect(new DrizzleOutboxSink(notAFunction as never, sinkTable, map).append(outboxRecord("o4", "k4"))).rejects.toThrow("onConflictDoNothing support")
  })

  it("looks up the conflicting identity by scope and key and verifies its fingerprint", async () => {
    const record = outboxRecord("o5", "k5")
    let stored = ""
    const first = createScriptedDb("sqlite", (op) => { if (op.kind === "insert") { stored = String((op.values as { eventFingerprint: string }).eventFingerprint); return { meta: { changes: 1 } } } return [] })
    await new DrizzleOutboxSink(first.db as never, sinkTable, map).append(record)
    const replay = createScriptedDb("sqlite", (op) => (op.kind === "insert" ? { meta: { changes: 0 } } : [{ eventFingerprint: stored }]))
    await expect(new DrizzleOutboxSink(replay.db as never, sinkTable, map).append({ ...record, id: "o5-again" })).resolves.toBeUndefined()
    expect(replay.ops[1]).toMatchObject({ kind: "select", limit: 1 })
    expect(norm(replay.ops[1]!.where!.sql)).toBe('("dx_outbox_sink"."idempotency_scope" = ? and "dx_outbox_sink"."idempotency_key" = ?)')
    expect(replay.ops[1]!.where!.params).toEqual([record.scopeId, "k5"])
    const different = createScriptedDb("sqlite", (op) => (op.kind === "insert" ? { meta: { changes: 0 } } : [{ eventFingerprint: "someone-elses" }]))
    await expect(new DrizzleOutboxSink(different.db as never, sinkTable, map).append(record)).rejects.toBeInstanceOf(ConflictError)
  })

  it("fails when the conflicting row is not an object", async () => {
    for (const rows of [[], [null], ["row"], [5]]) {
      const db = createScriptedDb("sqlite", (op) => (op.kind === "insert" ? { meta: { changes: 0 } } : rows))
      await expect(new DrizzleOutboxSink(db.db as never, sinkTable, map).append(outboxRecord("o6", "k6"))).rejects.toThrow(new Error("Outbox conflict row disappeared"))
    }
  })

  it("the factory binds the sink to the provider session", async () => {
    const { provider, row } = await setup()
    const sink = createDrizzleOutboxSinkFactory(outbox, (record) => ({ type: record.type, payload: JSON.stringify(record.payload) })).create(provider)
    expect(sink).toBeInstanceOf(DrizzleOutboxSink)
    await sink.append(outboxRecord("o7", "k7"))
    expect(row("SELECT id, type, payload FROM dx_outbox")).toEqual({ id: "o7", type: "dx.updated", payload: '{"n":1}' })
    await expect(sink.append({ ...outboxRecord("o8", "k7"), payload: { n: 2 } })).rejects.toBeInstanceOf(ConflictError)
  })
})
