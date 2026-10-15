import { describe, expect, it } from "vitest"
import { ConfigurationError, ValidationError } from "@xonava/core/domain"
import { filtersToPredicate, parseSortString, predicateFromFilterCondition, searchToPredicate } from "./filterInterop"

describe("filterInterop validation", () => {
  it("rejects invalid filter JSON instead of omitting the filter", () => {
    expect(() => filtersToPredicate("{", ["name"], ["name"])).toThrow(ValidationError)
  })

  it("bounds UTF-8 search bytes and searchable-column fanout", () => {
    const filters = JSON.stringify({ search: "éé" })
    expect(() => filtersToPredicate(filters, ["name"], undefined, undefined, { maxSearchBytes: 3 })).toThrow("UTF-8 bytes")
    expect(() => filtersToPredicate(JSON.stringify({ search: "ok" }), ["name", "email"], undefined, undefined, { maxSearchableColumns: 1 }))
      .toThrow("Search fanout")
  })

  it("rejects unsupported operators and disallowed fields", () => {
    expect(() => filtersToPredicate(JSON.stringify({ conditions: [
      { field: "name", operator: "doesNotExist", value: "A" },
    ] }), ["name"], ["name"])).toThrow("Invalid filter operator")
    expect(() => filtersToPredicate(JSON.stringify({ conditions: [
      { field: "secret", operator: "eq", value: "A" },
    ] }), ["name"], ["name"])).toThrow("not allowed")
  })

  it("rejects legacy filter operator aliases", () => {
    expect(() => filtersToPredicate(JSON.stringify({ conditions: [
      { field: "name", operator: "equals", value: "A" },
    ] }), ["name"], ["name"])).toThrow("Invalid filter operator")
  })

  it("enforces condition count and nesting limits globally", () => {
    const nested: { logic: "AND"; conditions: unknown[] } = { logic: "AND", conditions: [{ field: "name", operator: "eq", value: "A" }] }
    const overLimit = Array.from({ length: 51 }, () => nested)
    expect(() => filtersToPredicate(JSON.stringify({ conditions: overLimit }), ["name"], ["name"])).toThrow("condition count")

    let tooDeep: { logic: "AND"; conditions: unknown[] } = nested
    for (let index = 0; index < 6; index++) {
      tooDeep = { logic: "AND", conditions: [tooDeep] }
    }
    expect(() => filtersToPredicate(JSON.stringify(tooDeep), ["name"], ["name"])).toThrow("nesting depth")
  })

  it("rejects malformed sort entries instead of falling back to defaults", () => {
    expect(() => parseSortString("not-json")).toThrow("Invalid sorting JSON")
    expect(() => parseSortString(JSON.stringify([{ id: "name", desc: "yes" }]))).toThrow("sort direction")
    expect(() => parseSortString(JSON.stringify([{ desc: false }]))).toThrow("sort entry")
  })

  it("coerces date values to canonical ISO strings instead of Date objects", () => {
    const meta = { createdAt: { columnName: "created_at", kind: "date" as const } }
    const predicate = predicateFromFilterCondition(
      { field: "createdAt", operator: "eq", value: "2026-01-15T10:00:00.000Z" },
      ["created_at"],
      meta,
    )
    expect(predicate).toEqual({ kind: "condition", field: "created_at", op: "eq", value: "2026-01-15T10:00:00.000Z" })
    const value = predicate && predicate.kind === "condition" ? predicate.value : undefined
    expect(value).toBe("2026-01-15T10:00:00.000Z")
    expect(value).not.toBeInstanceOf(Date)
  })

  it("coerces date day-boundary eq filters into ISO between ranges", () => {
    const meta = { createdAt: { columnName: "created_at", kind: "date" as const } }
    const predicate = predicateFromFilterCondition(
      { field: "createdAt", operator: "eq", value: "2026-01-15" },
      ["created_at"],
      meta,
    )
    expect(predicate).toMatchObject({
      kind: "condition",
      field: "created_at",
      op: "between",
      value: { from: "2026-01-15T00:00:00.000Z", to: "2026-01-15T23:59:59.999Z" },
    })
    const range = predicate && predicate.kind === "condition" && predicate.value && typeof predicate.value === "object" && !Array.isArray(predicate.value)
      ? predicate.value as { from?: unknown }
      : undefined
    expect(range?.from).toBe("2026-01-15T00:00:00.000Z")
    expect(typeof range?.from).toBe("string")
    expect(range?.from).not.toBeInstanceOf(Date)
  })

  it("maps the prefix search strategy to startsWith predicates", () => {
    const predicate = searchToPredicate("acme", ["name", "email"], { kind: "prefix" })
    expect(predicate).toEqual({
      kind: "or",
      filters: [
        { kind: "condition", field: "name", op: "startsWith", value: "acme" },
        { kind: "condition", field: "email", op: "startsWith", value: "acme" },
      ],
    })
  })

  it("keeps the contains search strategy as the default", () => {
    const predicate = searchToPredicate("acme", ["name"], { kind: "contains" })
    expect(predicate).toEqual({ kind: "condition", field: "name", op: "contains", value: "acme" })
    expect(searchToPredicate("acme", ["name"]))
      .toEqual({ kind: "condition", field: "name", op: "contains", value: "acme" })
  })

  it("rejects the fullText search strategy instead of downgrading to %term%", () => {
    expect(() => searchToPredicate("acme", ["name"], { kind: "fullText", indexName: "items_idx" }))
      .toThrow(ConfigurationError)
    expect(() => filtersToPredicate(
      JSON.stringify({ search: "acme" }),
      ["name"],
      undefined,
      undefined,
      undefined,
      { kind: "fullText" },
    )).toThrow(ConfigurationError)
  })

  it("bounds raw filters JSON bytes before parsing", () => {
    const oversized = JSON.stringify({ conditions: [{ field: "name", operator: "eq", value: "x" }] }) +
      JSON.stringify({ conditions: [{ field: "name", operator: "eq", value: "y" }] }).repeat(4096)
    expect(oversized.length).toBeGreaterThan(64 * 1024)
    expect(() => filtersToPredicate(oversized, ["name"], ["name"]))
      .toThrow("Filters JSON exceeds")
    expect(() => filtersToPredicate(oversized, ["name"], ["name"], undefined, { maxFilterJsonBytes: 1024 }))
      .toThrow("UTF-8 bytes")
  })

  it("bounds raw sorting JSON bytes before parsing", () => {
    const oversized = JSON.stringify([{ id: "name" }]).repeat(7000)
    expect(oversized.length).toBeGreaterThan(64 * 1024)
    expect(() => parseSortString(oversized)).toThrow("Sorting JSON exceeds")
    expect(() => parseSortString(oversized, { maxBytes: 1024 })).toThrow("UTF-8 bytes")
  })

  it("bounds individual filter condition values", () => {
    const filters = JSON.stringify({ conditions: [{ field: "name", operator: "eq", value: "x".repeat(5000) }] })
    expect(() => filtersToPredicate(filters, ["name"], ["name"], undefined, { maxFilterValueBytes: 100 }))
      .toThrow("Filter value for field \"name\" exceeds")
    expect(() => filtersToPredicate(filters, ["name"], ["name"], undefined, { maxFilterValueBytes: 100, maxFilterJsonBytes: 1024 * 1024 }))
      .toThrow("exceeds the maximum")
  })
})
