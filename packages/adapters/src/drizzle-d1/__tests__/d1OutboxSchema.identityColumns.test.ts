import { describe, expect, it } from "vitest"
import { index, integer, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core"
import { ConfigurationError } from "@xonava/core/domain"
import { validateD1AtomicOutboxColumns } from "../d1OutboxSchema"

const mk = () => ({ id: text("id").primaryKey(), idempotencyScope: text("idempotency_scope"), idempotencyKey: text("idempotency_key"), eventFingerprint: text("event_fingerprint") })
const full = sqliteTable("outbox_full", mk(), (t) => [uniqueIndex("outbox_full_identity").on(t.idempotencyScope, t.idempotencyKey)])

describe("validateD1AtomicOutboxColumns", () => {
  it("returns the table itself when the identity columns and a unique (scope, key) index exist", () => {
    expect(validateD1AtomicOutboxColumns(full)).toBe(full)
  })

  it("accepts a table-level unique constraint on (scope, key)", () => {
    const table = sqliteTable("outbox_unique", mk(), (t) => [unique("outbox_unique_identity").on(t.idempotencyScope, t.idempotencyKey)])
    expect(validateD1AtomicOutboxColumns(table)).toBe(table)
  })

  it("requires each identity column with its own message", () => {
    const { id: _id, ...noId } = mk()
    expect(() => validateD1AtomicOutboxColumns(sqliteTable("o1", { ...noId, x: integer("x") }))).toThrow(new ConfigurationError("D1 outbox requires an id column"))
    const { idempotencyScope: _s, ...noScope } = mk()
    expect(() => validateD1AtomicOutboxColumns(sqliteTable("o2", noScope))).toThrow(new ConfigurationError("D1 outbox requires idempotencyScope and idempotencyKey columns"))
    const { idempotencyKey: _k, ...noKey } = mk()
    expect(() => validateD1AtomicOutboxColumns(sqliteTable("o3", noKey))).toThrow(new ConfigurationError("D1 outbox requires idempotencyScope and idempotencyKey columns"))
    const { eventFingerprint: _f, ...noFingerprint } = mk()
    expect(() => validateD1AtomicOutboxColumns(sqliteTable("o4", noFingerprint))).toThrow(new ConfigurationError("D1 outbox requires an eventFingerprint column"))
  })

  const noUnique = new ConfigurationError("D1 outbox requires a unique (idempotencyScope,idempotencyKey) constraint")

  it("rejects a table without any unique (scope, key) constraint", () => {
    expect(() => validateD1AtomicOutboxColumns(sqliteTable("o5", mk()))).toThrow(noUnique)
    expect(() => validateD1AtomicOutboxColumns(sqliteTable("o6", mk(), (t) => [index("o6_idx").on(t.idempotencyScope, t.idempotencyKey)]))).toThrow(noUnique)
  })

  it("rejects unique indexes and constraints that do not cover exactly (scope, key) in that order", () => {
    expect(() => validateD1AtomicOutboxColumns(sqliteTable("o7", mk(), (t) => [uniqueIndex("o7_idx").on(t.idempotencyKey, t.idempotencyScope)]))).toThrow(noUnique)
    expect(() => validateD1AtomicOutboxColumns(sqliteTable("o8", mk(), (t) => [uniqueIndex("o8_idx").on(t.idempotencyScope)]))).toThrow(noUnique)
    expect(() => validateD1AtomicOutboxColumns(sqliteTable("o9", mk(), (t) => [uniqueIndex("o9_idx").on(t.idempotencyScope, t.idempotencyKey, t.eventFingerprint)]))).toThrow(noUnique)
    expect(() => validateD1AtomicOutboxColumns(sqliteTable("o10", mk(), (t) => [uniqueIndex("o10_idx").on(t.id, t.idempotencyKey)]))).toThrow(noUnique)
    expect(() => validateD1AtomicOutboxColumns(sqliteTable("o11", mk(), (t) => [uniqueIndex("o11_idx").on(t.idempotencyScope, t.id)]))).toThrow(noUnique)
    expect(() => validateD1AtomicOutboxColumns(sqliteTable("o12", mk(), (t) => [unique("o12_uq").on(t.idempotencyKey, t.idempotencyScope)]))).toThrow(noUnique)
    expect(() => validateD1AtomicOutboxColumns(sqliteTable("o13", mk(), (t) => [unique("o13_uq").on(t.idempotencyScope)]))).toThrow(noUnique)
    expect(() => validateD1AtomicOutboxColumns(sqliteTable("o14", mk(), (t) => [unique("o14_uq").on(t.idempotencyScope, t.id)]))).toThrow(noUnique)
    expect(() => validateD1AtomicOutboxColumns(sqliteTable("o15", mk(), (t) => [unique("o15_uq").on(t.id, t.idempotencyKey)]))).toThrow(noUnique)
  })

  it("matches index columns by physical name when they are a different column object", () => {
    const other = sqliteTable("other_outbox", mk())
    const table = sqliteTable("o16", mk(), () => [uniqueIndex("o16_idx").on(other.idempotencyScope, other.idempotencyKey)])
    expect(validateD1AtomicOutboxColumns(table)).toBe(table)
    const renamed = sqliteTable("o17", mk())
    const mismatched = sqliteTable("o18", { ...mk(), idempotencyKey: text("different_key") }, () => [uniqueIndex("o18_idx").on(renamed.idempotencyScope, renamed.idempotencyKey)])
    expect(() => validateD1AtomicOutboxColumns(mismatched)).toThrow(noUnique)
    const mismatchedScope = sqliteTable("o19", { ...mk(), idempotencyScope: text("different_scope") }, () => [uniqueIndex("o19_idx").on(renamed.idempotencyScope, renamed.idempotencyKey)])
    expect(() => validateD1AtomicOutboxColumns(mismatchedScope)).toThrow(noUnique)
  })
})
