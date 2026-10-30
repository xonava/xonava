import { describe, expect, it } from "vitest"
import type { AnyColumn } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ConfigurationError } from "@xonava/core/domain"
import { renderSql } from "../../__tests__/support/scriptedDb"
import { d1ColumnInputValue, d1ColumnKey, d1CurrentEpochMilliseconds, d1DriverValue, d1EpochMillisecondsAfter, getAffectedRows } from "../d1Utils"

const table = sqliteTable("t", { id: text("id"), at: integer("at", { mode: "timestamp_ms" }), plain: integer("plain"), other: text("same_name") })
const lookalike = sqliteTable("lookalike", { renamed: text("same_name"), stranger: text("stranger") })

describe("d1 epoch expressions", () => {
  it("render the SQLite clock as integer milliseconds", () => {
    const now = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)"
    expect(renderSql("sqlite", d1CurrentEpochMilliseconds())).toEqual({ sql: now, params: [] })
    expect(renderSql("sqlite", d1EpochMillisecondsAfter(250))).toEqual({ sql: "CAST((julianday('now') - 2440587.5) * 86400000 + ? AS INTEGER)", params: [250] })
  })
})

describe("getAffectedRows", () => {
  it("is zero for anything that is not an object", () => {
    for (const value of [null, undefined, 0, 5, "3", true, false]) expect(getAffectedRows(value)).toBe(0)
  })

  it("reads each known result shape, preferring them in order", () => {
    expect(getAffectedRows({ affectedRows: 4, changes: 1, rowsAffected: 2, count: 3, meta: { changes: 9 } })).toBe(4)
    expect(getAffectedRows({ changes: 1, rowsAffected: 2, count: 3, meta: { changes: 9 } })).toBe(1)
    expect(getAffectedRows({ rowsAffected: 2, count: 3, meta: { changes: 9 } })).toBe(2)
    expect(getAffectedRows({ count: 3, meta: { changes: 9 } })).toBe(3)
    expect(getAffectedRows({ meta: { changes: 9 } })).toBe(9)
    expect(getAffectedRows({ affectedRows: 0 })).toBe(0)
    expect(getAffectedRows({ changes: 0, meta: { changes: 5 } })).toBe(0)
  })

  it("ignores non-numeric fields and malformed metadata", () => {
    expect(getAffectedRows({ affectedRows: "4", changes: "1", rowsAffected: "2", count: "3" })).toBe(0)
    expect(getAffectedRows({ meta: null })).toBe(0)
    expect(getAffectedRows({ meta: "x" })).toBe(0)
    expect(getAffectedRows({ meta: { changes: "7" } })).toBe(0)
    expect(getAffectedRows({ meta: {} })).toBe(0)
    expect(getAffectedRows({})).toBe(0)
  })
})

describe("d1ColumnKey", () => {
  it("finds the property by column identity, then by physical name, then by fallback", () => {
    expect(d1ColumnKey(table, table.at)).toBe("at")
    expect(d1ColumnKey(table, lookalike.renamed)).toBe("other")
    expect(d1ColumnKey(table, lookalike.stranger, "fallback")).toBe("fallback")
    expect(d1ColumnKey(table, lookalike.stranger, "")).toBe("")
    expect(() => d1ColumnKey(table, lookalike.stranger)).toThrow(new ConfigurationError("Mapped column is not declared on its table"))
  })

  it("prefers an identical column over an earlier column that merely shares its name", () => {
    const dup = sqliteTable("dup", { first: text("dup"), second: text("dup") })
    expect(d1ColumnKey(dup, dup.second)).toBe("second")
    expect(d1ColumnKey(dup, sqliteTable("x", { c: text("dup") }).c)).toBe("first")
  })
})

describe("d1ColumnInputValue", () => {
  it("turns Dates into epoch milliseconds unless the column encodes them itself", () => {
    const date = new Date(1_234)
    expect(d1ColumnInputValue(table.id, date)).toBe(1_234)
    expect(d1ColumnInputValue(table.plain, date)).toBe(1_234)
    expect(d1ColumnInputValue(table.at, date)).toBe(date)
    const throwing = { mapToDriverValue: () => { throw new Error("cannot map") } } as unknown as AnyColumn
    expect(d1ColumnInputValue(throwing, date)).toBe(1_234)
    const dateKeeping = { mapToDriverValue: (value: unknown) => value } as unknown as AnyColumn
    expect(d1ColumnInputValue(dateKeeping, date)).toBe(1_234)
  })

  it("leaves every other value alone", () => {
    for (const value of ["text", 5, null, undefined, { a: 1 }, 1_234]) expect(d1ColumnInputValue(table.id, value)).toBe(value)
  })
})

describe("d1DriverValue", () => {
  it("is null for null and undefined, whatever the column would map them to", () => {
    const mapping = { mapToDriverValue: (value: unknown) => `mapped:${String(value)}` } as unknown as AnyColumn
    expect(d1DriverValue(mapping, null)).toBeNull()
    expect(d1DriverValue(mapping, undefined)).toBeNull()
    expect(d1DriverValue(table.id, undefined)).toBeNull()
  })

  it("applies the column's driver mapping, then flattens Dates to epoch milliseconds", () => {
    const mapping = { mapToDriverValue: (value: unknown) => `mapped:${String(value)}` } as unknown as AnyColumn
    expect(d1DriverValue(mapping, "v")).toBe("mapped:v")
    expect(d1DriverValue(mapping, 0)).toBe("mapped:0")
    expect(d1DriverValue(mapping, "")).toBe("mapped:")
    const date = new Date(7_000)
    expect(d1DriverValue(table.at, date)).toBe(7_000)
    expect(d1DriverValue(table.id, date)).toBe(7_000)
    const dateKeeping = { mapToDriverValue: (value: unknown) => value } as unknown as AnyColumn
    expect(d1DriverValue(dateKeeping, date)).toBe(7_000)
  })

  it("passes values through for a column without a driver mapping", () => {
    const bare = {} as unknown as AnyColumn
    expect(d1DriverValue(bare, "v")).toBe("v")
    expect(d1DriverValue(bare, 0)).toBe(0)
    expect(d1DriverValue(bare, new Date(9))).toBe(9)
    const notAFunction = { mapToDriverValue: "no" } as unknown as AnyColumn
    expect(d1DriverValue(notAFunction, "v")).toBe("v")
  })
})
