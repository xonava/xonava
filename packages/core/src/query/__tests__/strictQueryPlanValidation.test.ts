import { describe, expect, it } from "vitest"
import { ValidationError } from "../../domain/errors.js"
import { Predicate } from "../../domain/predicate.js"
import {
  DEFAULT_QUERY_BUDGET,
  validateQueryPlan,
} from "../queryBudget.js"
import type { QueryPlan } from "../queryPlan.js"

const malformed = (value: unknown): QueryPlan => value as QueryPlan

describe("strict query plan runtime validation", () => {
  it.each([
    [{ filter: { kind: "unknown" } }, /unknown kind/],
    [{ filter: { kind: "attacker", payload: "x" } }, /unknown/i],
    [{ filter: { kind: "condition", field: "id", op: "unknown", value: 1 } }, /unknown operator/],
    [{ filter: { kind: "condition", field: "id", op: "attacker", value: 1 } }, /unknown operator/],
    [{ sort: [{ field: "id", direction: "sideways" }] }, /direction/],
    [{ sort: [{ field: "id", direction: "DROP" }] }, /direction/],
    [{ sort: [{ field: "id", direction: "asc", nulls: "middle" }] }, /null ordering/],
  ] as const)("rejects unknown discriminants in %#", (plan, message) => {
    expect(() => validateQueryPlan(malformed(plan))).toThrow(message)
  })

  it("rejects non-plain records, inherited fields, accessors, and symbols without invoking getters", () => {
    const inheritedPlan = Object.create({ filter: Predicate.literal(true) }) as QueryPlan
    const inheritedNode = Object.create({ kind: "literal", value: true }) as unknown
    const customPrototype = Object.assign(Object.create({ marker: true }), { search: { text: "ok" } }) as QueryPlan
    let getterCalls = 0
    const accessorPlan = Object.defineProperty({}, "filter", {
      enumerable: true,
      get() { getterCalls += 1; return Predicate.literal(true) },
    }) as QueryPlan
    const symbolPlan = { [Symbol("hidden")]: true } as QueryPlan

    for (const plan of [inheritedPlan, malformed({ filter: inheritedNode }), customPrototype, accessorPlan, symbolPlan]) {
      expect(() => validateQueryPlan(plan)).toThrow(ValidationError)
    }
    expect(getterCalls).toBe(0)
  })

  it("rejects cycles and malformed predicate arrays", () => {
    const recursive: { kind: "not"; filter?: unknown } = { kind: "not" }
    recursive.filter = recursive
    const sparse = new Array(2) as unknown[]
    sparse[0] = Predicate.literal(true)
    const accessor = [Predicate.literal(true)]
    Object.defineProperty(accessor, "0", { get: () => Predicate.literal(true) })

    expect(() => validateQueryPlan(malformed({ filter: recursive }))).toThrow(/cycle/)
    expect(() => validateQueryPlan(malformed({ filter: { kind: "and", filters: sparse } }))).toThrow(/dense array/)
    expect(() => validateQueryPlan(malformed({ filter: { kind: "and", filters: accessor } }))).toThrow(/data properties/)
    expect(() => validateQueryPlan(malformed({ filter: { kind: "and", filters: {} } }))).toThrow(/array/)
  })

  it("enforces predicate value cardinality and scalar shapes", () => {
    const rejected: unknown[] = [
      { filter: { kind: "condition", field: "id", op: "eq" } },
      { filter: { kind: "condition", field: "id", op: "isNull", value: null } },
      { filter: { kind: "condition", field: "id", op: "in", value: 1 } },
      { filter: { kind: "condition", field: "id", op: "includesAny", value: [1, {}] } },
      { filter: { kind: "condition", field: "id", op: "between", value: {} } },
      { filter: { kind: "condition", field: "id", op: "between", value: { from: 1, extra: 2 } } },
      { filter: { kind: "condition", field: "id", op: "eq", value: Number.NaN } },
      { filter: { kind: "condition", field: "id", op: "eq", value: Number.POSITIVE_INFINITY } },
      { filter: { kind: "condition", field: "id", op: "eq", value: Number.MAX_SAFE_INTEGER + 1 } },
      { filter: { kind: "condition", field: "createdAt", op: "eq", value: new Date(Number.NaN) } },
    ]
    for (const plan of rejected) expect(() => validateQueryPlan(malformed(plan))).toThrow(ValidationError)

    expect(() => validateQueryPlan({ filter: Predicate.between("score", { from: 0.5, to: 2 }) })).not.toThrow()
    expect(() => validateQueryPlan({ filter: Predicate.eq("createdAt", new Date(0)) })).not.toThrow()
    expect(() => validateQueryPlan({ filter: Predicate.isNull("deletedAt") })).not.toThrow()
  })

  it.each([
    [{ extra: true }],
    [{ filter: { kind: "literal", value: true, extra: true } }],
    [{ filter: { kind: "condition", field: "id", op: "eq", value: 1, extra: true } }],
    [{ filter: { kind: "and", filters: [], extra: true } }],
    [{ filter: { kind: "not", filter: { kind: "literal", value: true }, extra: true } }],
    [{ sort: [{ field: "id", direction: "asc", extra: true }] }],
    [{ pagination: { kind: "offset", page: 1, pageSize: 10, extra: true } }],
    [{ projection: { fields: ["id"], extra: true } }],
    [{ search: { text: "term", extra: true } }],
  ])("rejects unknown keys at every schema level in %#", plan => {
    expect(() => validateQueryPlan(malformed(plan))).toThrow(/unknown field/i)
  })

  it("strictly validates offset and cursor pagination", () => {
    const rejected: unknown[] = [
      { pagination: { kind: "offset", page: 0, pageSize: 10 } },
      { pagination: { kind: "offset", page: 1, pageSize: 1.5 } },
      { pagination: { kind: "cursor", limit: 10 } },
      { pagination: { kind: "cursor", after: "a", before: "b", limit: 10 } },
      { pagination: { kind: "cursor", after: "", limit: 10 } },
      { pagination: { kind: "cursor", after: "a", limit: 0 } },
      { pagination: { kind: "other", page: 1, pageSize: 10 } },
    ]
    for (const plan of rejected) expect(() => validateQueryPlan(malformed(plan))).toThrow(ValidationError)
    expect(() => validateQueryPlan({ pagination: { kind: "offset", page: 1, pageSize: 10 } })).not.toThrow()
    expect(() => validateQueryPlan({ pagination: { kind: "cursor", after: "token", limit: 10 } })).not.toThrow()
  })

  it("accepts the opt-in total on offset pagination only, as a boolean", () => {
    expect(() => validateQueryPlan({ pagination: { kind: "offset", page: 1, pageSize: 10, includeTotal: true } })).not.toThrow()
    expect(() => validateQueryPlan({ pagination: { kind: "offset", page: 1, pageSize: 10, includeTotal: false } })).not.toThrow()
    for (const includeTotal of ["yes", 1, null]) {
      expect(() => validateQueryPlan(malformed({ pagination: { kind: "offset", page: 1, pageSize: 10, includeTotal } }))).toThrow(/includeTotal must be a boolean/)
    }
    // A cursor page never carries a total, so the option is not part of cursor pagination.
    expect(() => validateQueryPlan(malformed({ pagination: { kind: "cursor", after: "token", limit: 10, includeTotal: true } }))).toThrow(/unknown field/i)
  })

  it("rejects duplicate and malformed sort and projection fields", () => {
    const rejected: unknown[] = [
      { sort: [{ field: "id", direction: "asc" }, { field: "id", direction: "desc" }] },
      { sort: [{ field: " ", direction: "asc" }] },
      { projection: { fields: ["id", "id"] } },
      { projection: { fields: [""] } },
      { consistency: "causal" },
      { search: { text: 1 } },
    ]
    for (const plan of rejected) expect(() => validateQueryPlan(malformed(plan))).toThrow(ValidationError)
  })

  it("accepts valid boundary-size plans and rejects values one byte beyond them", () => {
    const MAX_QUERY_FIELD_BYTES = 1024
    const MAX_QUERY_CURSOR_BYTES = 16_384
    const field = "x".repeat(MAX_QUERY_FIELD_BYTES)
    const cursor = "c".repeat(MAX_QUERY_CURSOR_BYTES)
    const text = "s".repeat(DEFAULT_QUERY_BUDGET.maxSearchBytes)
    expect(() => validateQueryPlan({
      filter: Predicate.eq(field, true),
      sort: [{ field, direction: "desc", nulls: "last" }],
      pagination: { kind: "cursor", before: cursor, limit: 1 },
      projection: { fields: [field] },
      consistency: "session",
      search: { text },
    })).not.toThrow()
    expect(() => validateQueryPlan({ sort: [{ field: `${field}x`, direction: "asc" }] })).toThrow(/UTF-8 bytes/)
    expect(() => validateQueryPlan({ pagination: { kind: "cursor", after: `${cursor}x`, limit: 1 } })).toThrow(/UTF-8 bytes/)
  })
})
