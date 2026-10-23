// @ts-nocheck
import { describe, expect, it } from "vitest"
import { ConfigurationError, Predicate } from "@xonava/core/domain"
import { filtersToPredicate, parseSortString, predicateFromFilterCondition, predicateFromFilterGroup, searchToPredicate } from "../filterInterop"

const meta = {
  createdAt: { kind: "date" as const },
  total: { kind: "number" as const },
  active: { kind: "boolean" as const },
  title: { kind: "string" as const, columnName: "name" },
}

describe("predicateFromFilterCondition", () => {
  it("maps operators, defaulting to equality", () => {
    expect(predicateFromFilterCondition({ field: "name", value: "x" })).toEqual({ kind: "condition", field: "name", op: "eq", value: "x" })
    for (const operator of ["neq", "contains", "startsWith", "endsWith", "gt", "lt", "gte", "lte"]) {
      expect(predicateFromFilterCondition({ field: "name", operator, value: "x" })).toMatchObject({ op: operator, value: "x" })
    }
    expect(predicateFromFilterCondition({ field: "name", operator: "in", value: ["a", "b"] })).toMatchObject({ op: "in", value: ["a", "b"] })
    expect(predicateFromFilterCondition({ field: "name", operator: "between", value: [1, 5] })).toMatchObject({ op: "between", value: [1, 5] })
    expect(predicateFromFilterCondition({ field: "name", operator: "between", value: { from: 1 } })).toMatchObject({ value: { from: 1 } })
    expect(predicateFromFilterCondition({ field: "name", operator: "between", value: { to: 9 } })).toMatchObject({ value: { to: 9 } })
  })

  it("accepts valueless operators and rejects missing values", () => {
    for (const operator of ["isEmpty", "isNotEmpty", "isTrue", "isFalse", "isNull", "isNotNull"]) {
      expect(predicateFromFilterCondition({ field: "name", operator })).toEqual({ kind: "condition", field: "name", op: operator })
    }
    expect(() => predicateFromFilterCondition({ field: "name", operator: "eq" })).toThrow('Filter operator "eq" requires a value')
    expect(predicateFromFilterCondition({ field: "name", operator: "eq", value: null })).toMatchObject({ value: null })
  })

  it("rejects malformed conditions, unknown operators and disallowed fields", () => {
    for (const bad of [null, "x", [], {}, { field: "" }, { field: 5 }]) expect(() => predicateFromFilterCondition(bad)).toThrow("non-empty field")
    expect(() => predicateFromFilterCondition({ field: "name", operator: 5 })).toThrow('Invalid filter operator for field "name"')
    expect(() => predicateFromFilterCondition({ field: "name", operator: "like", value: "x" })).toThrow('Invalid filter operator "like"')
    expect(() => predicateFromFilterCondition({ field: "secret", value: "x" }, ["name"])).toThrow('Filtering by field "secret" is not allowed')
    expect(predicateFromFilterCondition({ field: "name", value: "x" }, ["name"])).toMatchObject({ field: "name" })
  })

  it("rejects values the predicate model cannot represent", () => {
    expect(() => predicateFromFilterCondition({ field: "name", value: { nested: { deep: true } } })).toThrow('Invalid filter value for field "name"')
    expect(() => predicateFromFilterCondition({ field: "name", operator: "in", value: ["a", { x: 1 }] })).toThrow("Invalid filter value")
    expect(() => predicateFromFilterCondition({ field: "name", operator: "between", value: [1, { x: 1 }] })).toThrow("Invalid filter value")
    expect(() => predicateFromFilterCondition({ field: "name", operator: "between", value: { from: { x: 1 } } })).toThrow("Invalid filter value")
    expect(predicateFromFilterCondition({ field: "name", operator: "between", value: [1, 2, 3] })).toMatchObject({ value: [1, 2, 3] })
    expect(() => predicateFromFilterCondition({ field: "name", value: () => 1 })).toThrow("Invalid filter value")
  })

  it("coerces values by field kind and remaps columns from metadata", () => {
    expect(predicateFromFilterCondition({ field: "total", operator: "gt", value: "12.5" }, undefined, meta)).toMatchObject({ value: 12.5 })
    expect(predicateFromFilterCondition({ field: "total", operator: "gt", value: "abc" }, undefined, meta)).toMatchObject({ value: "abc" })
    expect(predicateFromFilterCondition({ field: "active", value: "true" }, undefined, meta)).toMatchObject({ value: true })
    expect(predicateFromFilterCondition({ field: "active", value: "false" }, undefined, meta)).toMatchObject({ value: false })
    expect(predicateFromFilterCondition({ field: "active", value: "maybe" }, undefined, meta)).toMatchObject({ value: "maybe" })
    expect(predicateFromFilterCondition({ field: "createdAt", operator: "gt", value: "2026-01-02T03:04:05Z" }, undefined, meta)).toMatchObject({ value: "2026-01-02T03:04:05.000Z" })
    expect(predicateFromFilterCondition({ field: "createdAt", operator: "gt", value: 0 }, undefined, meta)).toMatchObject({ value: "1970-01-01T00:00:00.000Z" })
    expect(predicateFromFilterCondition({ field: "createdAt", operator: "gt", value: new Date(5) }, undefined, meta)).toMatchObject({ value: "1970-01-01T00:00:00.005Z" })
    expect(predicateFromFilterCondition({ field: "createdAt", operator: "gt", value: "not a date" }, undefined, meta)).toMatchObject({ value: "not a date" })
    expect(predicateFromFilterCondition({ field: "createdAt", operator: "gt", value: true }, undefined, meta)).toMatchObject({ value: true })
    expect(predicateFromFilterCondition({ field: "title", value: "x" }, ["name"], meta)).toMatchObject({ field: "name" })
    expect(() => predicateFromFilterCondition({ field: "title", value: "x" }, ["title"], meta)).toThrow("not allowed")
  })

  it("expands a date-only equality to the whole UTC day", () => {
    expect(predicateFromFilterCondition({ field: "createdAt", value: "2026-03-04" }, undefined, meta)).toEqual(Predicate.between("createdAt", { from: "2026-03-04T00:00:00.000Z", to: "2026-03-04T23:59:59.999Z" }))
    expect(predicateFromFilterCondition({ field: "createdAt", value: "2026-13-45" }, undefined, meta)).toMatchObject({ op: "eq" })
  })

  it("never resolves inherited property names to metadata", () => {
    expect(predicateFromFilterCondition({ field: "constructor", value: "x" }, undefined, meta)).toMatchObject({ field: "constructor" })
    expect(predicateFromFilterCondition({ field: "__proto__", value: "x" }, undefined, meta)).toMatchObject({ field: "__proto__" })
  })

  it("enforces the per-value byte limit on strings, numbers, dates, booleans and arrays", () => {
    const limits = { maxFilterValueBytes: 4 }
    expect(() => predicateFromFilterCondition({ field: "name", value: "toolong" }, undefined, undefined, limits)).toThrow("exceeds the maximum of 4 UTF-8 bytes")
    expect(predicateFromFilterCondition({ field: "name", value: "ok" }, undefined, undefined, limits)).toMatchObject({ value: "ok" })
    expect(() => predicateFromFilterCondition({ field: "name", value: 123456 }, undefined, undefined, limits)).toThrow("exceeds")
    expect(() => predicateFromFilterCondition({ field: "name", operator: "in", value: ["aaa", "bbb"] }, undefined, undefined, limits)).toThrow("exceeds")
    expect(() => predicateFromFilterCondition({ field: "name", value: new Date(0) }, undefined, undefined, limits)).toThrow("exceeds")
    expect(predicateFromFilterCondition({ field: "name", value: null }, undefined, undefined, limits)).toMatchObject({ value: null })
    expect(predicateFromFilterCondition({ field: "name", value: true }, undefined, undefined, limits)).toMatchObject({ value: true })
    expect(() => predicateFromFilterCondition({ field: "name", operator: "between", value: { from: "abcdef", to: "z" } }, undefined, undefined, limits)).toThrow("exceeds")
  })
})

describe("predicateFromFilterGroup", () => {
  const cond = (field: string, value: string) => ({ field, operator: "eq", value })

  it("combines conditions with AND by default, OR on request and unwraps single conditions", () => {
    expect(predicateFromFilterGroup({ conditions: [cond("a", "1")] })).toEqual({ kind: "condition", field: "a", op: "eq", value: "1" })
    expect(predicateFromFilterGroup({ conditions: [cond("a", "1"), cond("b", "2")] })).toMatchObject({ kind: "and" })
    expect(predicateFromFilterGroup({ logic: "AND", conditions: [cond("a", "1"), cond("b", "2")] })).toMatchObject({ kind: "and" })
    expect(predicateFromFilterGroup({ logic: "OR", conditions: [cond("a", "1"), cond("b", "2")] })).toMatchObject({ kind: "or", filters: [{ field: "a" }, { field: "b" }] })
    expect(predicateFromFilterGroup({})).toBeUndefined()
    expect(predicateFromFilterGroup({ conditions: [] })).toBeUndefined()
  })

  it("nests groups and drops empty nested ones", () => {
    const nested = predicateFromFilterGroup({ logic: "OR", conditions: [cond("a", "1"), { logic: "AND", conditions: [cond("b", "2"), cond("c", "3")] }, { conditions: [] }] })
    expect(nested).toMatchObject({ kind: "or", filters: [{ field: "a" }, { kind: "and", filters: [{ field: "b" }, { field: "c" }] }] })
  })

  it("rejects malformed groups", () => {
    expect(() => predicateFromFilterGroup(null as never)).toThrow("Filter group must be an object")
    expect(() => predicateFromFilterGroup({ logic: "XOR" } as never)).toThrow("logic must be AND or OR")
    expect(() => predicateFromFilterGroup({ conditions: "x" } as never)).toThrow("conditions must be an array")
    expect(() => predicateFromFilterGroup({ search: 5 } as never)).toThrow("search must be a string")
    expect(() => predicateFromFilterGroup({ conditions: [5 as never] })).toThrow("non-empty field")
  })

  it("bounds nesting depth and total condition count", () => {
    let group: Record<string, unknown> = { conditions: [cond("a", "1")] }
    for (let level = 0; level < 40; level += 1) group = { conditions: [group] }
    expect(() => predicateFromFilterGroup(group as never)).toThrow("nesting depth exceeds the maximum")
    const many = { conditions: Array.from({ length: 5_000 }, (_, index) => cond("a", String(index))) }
    expect(() => predicateFromFilterGroup(many)).toThrow("condition count exceeds the maximum")
  })

  it("passes field allow-lists, metadata and limits to nested conditions", () => {
    expect(() => predicateFromFilterGroup({ conditions: [{ conditions: [cond("secret", "1")] }] }, ["a"])).toThrow("not allowed")
    expect(predicateFromFilterGroup({ conditions: [{ conditions: [{ field: "total", operator: "gt", value: "7" }] }] }, undefined, meta)).toMatchObject({ value: 7 })
    expect(() => predicateFromFilterGroup({ conditions: [cond("a", "toolong")] }, undefined, undefined, 0, { maxFilterValueBytes: 3 })).toThrow("exceeds")
  })
})

describe("searchToPredicate", () => {
  it("builds contains or prefix predicates across columns", () => {
    expect(searchToPredicate("ab", ["name"])).toEqual(Predicate.contains("name", "ab"))
    expect(searchToPredicate("ab", ["name", "email"])).toEqual(Predicate.or(Predicate.contains("name", "ab"), Predicate.contains("email", "ab")))
    expect(searchToPredicate("ab", ["name", "email"], { kind: "prefix" } as never)).toEqual(Predicate.or(Predicate.startsWith("name", "ab"), Predicate.startsWith("email", "ab")))
    expect(searchToPredicate("ab", ["name"], { kind: "contains" } as never)).toEqual(Predicate.contains("name", "ab"))
    expect(searchToPredicate("ab", ["", ""])).toBeUndefined()
    expect(searchToPredicate("ab", [])).toBeUndefined()
  })

  it("refuses full-text strategies instead of degrading them", () => {
    expect(() => searchToPredicate("ab", ["name"], { kind: "fullText" } as never)).toThrow(ConfigurationError)
    expect(() => searchToPredicate("ab", ["name"], { kind: "fullText", indexName: "ft_idx" } as never)).toThrow('index "ft_idx"')
  })
})

describe("filtersToPredicate", () => {
  it("returns nothing for empty input and parses combined search and filter groups", () => {
    expect(filtersToPredicate("", ["name"])).toBeUndefined()
    expect(filtersToPredicate("{}", ["name"])).toBeUndefined()
    const both = filtersToPredicate(JSON.stringify({ search: "ab", conditions: [{ field: "status", operator: "eq", value: "open" }] }), ["name", "email"])
    expect(both).toMatchObject({ kind: "and", filters: [{ kind: "or" }, { field: "status" }] })
    const searchOnly = filtersToPredicate(JSON.stringify({ search: "ab" }), ["name"])
    expect(searchOnly).toEqual(Predicate.contains("name", "ab"))
    expect(filtersToPredicate(JSON.stringify({ search: "ab" }), [])).toBeUndefined()
    expect(filtersToPredicate(JSON.stringify({ search: "" }), ["name"])).toBeUndefined()
    expect(filtersToPredicate(JSON.stringify({ conditions: [{ field: "status", value: "x" }] }), [])).toMatchObject({ field: "status" })
  })

  it("applies the search strategy, allow-list and metadata", () => {
    expect(filtersToPredicate(JSON.stringify({ search: "ab" }), ["name"], undefined, undefined, {}, { kind: "prefix" } as never)).toEqual(Predicate.startsWith("name", "ab"))
    expect(() => filtersToPredicate(JSON.stringify({ conditions: [{ field: "secret", value: "x" }] }), [], ["status"])).toThrow("not allowed")
    expect(filtersToPredicate(JSON.stringify({ conditions: [{ field: "total", operator: "gt", value: "3" }] }), [], undefined, meta)).toMatchObject({ value: 3 })
  })

  it("rejects malformed JSON, non-objects and over-limit input", () => {
    expect(() => filtersToPredicate("{nope", ["name"])).toThrow("Invalid filters JSON")
    expect(() => filtersToPredicate("[1]", ["name"])).toThrow("Filters must be a JSON object")
    expect(() => filtersToPredicate("5", ["name"])).toThrow("Filters must be a JSON object")
    expect(() => filtersToPredicate(JSON.stringify({ search: "x" }), ["name"], undefined, undefined, { maxFilterJsonBytes: 5 })).toThrow("Filters JSON exceeds the maximum of 5")
    expect(() => filtersToPredicate(JSON.stringify({ search: "abcdef" }), ["name"], undefined, undefined, { maxSearchBytes: 3 })).toThrow("Search text exceeds the maximum of 3")
    expect(() => filtersToPredicate(JSON.stringify({ search: "ab" }), ["a", "b", "c"], undefined, undefined, { maxSearchableColumns: 2 })).toThrow("Search fanout exceeds the maximum of 2")
    expect(() => filtersToPredicate(JSON.stringify({ conditions: [{ field: "a", value: "toolong" }] }), [], undefined, undefined, { maxFilterValueBytes: 3 })).toThrow("exceeds the maximum of 3")
  })
})

describe("parseSortString", () => {
  it("parses ascending and descending keys", () => {
    expect(parseSortString(undefined)).toBeUndefined()
    expect(parseSortString("")).toBeUndefined()
    expect(parseSortString(JSON.stringify([{ id: "name" }, { id: "total", desc: true }, { id: "x", desc: false }]))).toEqual([
      { field: "name", direction: "asc" }, { field: "total", direction: "desc" }, { field: "x", direction: "asc" },
    ])
  })

  it("rejects malformed input, disallowed fields and over-limit requests", () => {
    expect(() => parseSortString("{nope")).toThrow("Invalid sorting JSON")
    expect(() => parseSortString('{"id":"a"}')).toThrow("Sorting must be a JSON array")
    expect(() => parseSortString(JSON.stringify([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]))).toThrow("at most 3 keys")
    expect(parseSortString(JSON.stringify([{ id: "a" }, { id: "b" }]), { maxKeys: 2 })).toHaveLength(2)
    expect(() => parseSortString(JSON.stringify([{ id: "a" }, { id: "b" }]), { maxKeys: 1 })).toThrow("at most 1 keys")
    for (const entry of [5, null, {}, { id: "" }, { id: 7 }]) expect(() => parseSortString(JSON.stringify([entry]))).toThrow("Invalid sort entry at index 0")
    expect(() => parseSortString(JSON.stringify([{ id: "secret" }]), { allowedFields: ["name"] })).toThrow('Sorting by field "secret" is not allowed')
    expect(parseSortString(JSON.stringify([{ id: "name" }]), { allowedFields: ["name"] })).toEqual([{ field: "name", direction: "asc" }])
    expect(() => parseSortString(JSON.stringify([{ id: "name", desc: "yes" }]))).toThrow("Invalid sort direction at index 0")
    expect(() => parseSortString(JSON.stringify([{ id: "name" }]), { maxBytes: 5 })).toThrow("Sorting JSON exceeds the maximum of 5")
  })
})
