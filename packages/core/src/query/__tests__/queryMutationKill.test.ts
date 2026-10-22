// @ts-nocheck
import { describe, expect, it } from "vitest"
import { CancelledError, ConfigurationError, TimeoutError } from "../../domain/errors"
import { MAX_PREDICATE_EVALUATION_DEPTH } from "../../domain/evaluatePredicate"
import { Predicate } from "../../domain/predicate"
import { canonicalJsonString } from "../../serialization/canonicalJson"
import { assertCursorBinding, assertStableCursorSort } from "../cursor"
import { createRotatingCursorIntegrity, decodeCursor, encodeCursor } from "../cursorCodec"
import { DEFAULT_QUERY_BUDGET, MAX_QUERY_TOTAL_VALUE_BYTES, MAX_QUERY_VALUE_BYTES, assertQueryBudget, compileQueryBudget, validateQueryPlan } from "../queryBudget"
import { resolveProjection } from "../projection"
import { validateSearchRequest, validateSearchResult } from "../search"

/** Returns the error thrown synchronously by fn, so its exact message can be compared. */
function caught(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error("expected the call to throw")
}

/** Async variant of caught for the cursor codec. */
async function caughtAsync(fn) {
  try {
    await fn()
  } catch (error) {
    return error
  }
  throw new Error("expected the call to reject")
}

const budget = { ...DEFAULT_QUERY_BUDGET }
const small = { maxPredicateDepth: 2, maxPredicateNodes: 3, maxOrBranches: 2, maxInValues: 2, maxSortFields: 1, maxProjectionFields: 1, maxSearchBytes: 4 }
const payload = { format: "framework.cursor", version: 1, direction: "after", values: ["a", 1], routeHash: "r", queryHash: "q", scopeHash: "s", sortHash: "o" }

/** A deterministic, invertible integrity tag so tampering and key mismatch are observable. */
const mac = (secret) => ({
  sign: async (bytes) => Uint8Array.of(bytes.reduce((sum, byte) => (sum + byte * secret) % 251, secret)),
  verify: async (bytes, signature) => signature.length === 1 && signature[0] === bytes.reduce((sum, byte) => (sum + byte * secret) % 251, secret),
})

describe("query budget error messages and boundaries", () => {
  it("reports exact messages for malformed budget records", () => {
    expect(caught(() => assertQueryBudget(null)).message).toBe("query budget must be a plain object")
    expect(caught(() => assertQueryBudget([])).message).toBe("query budget must be a plain object")
    expect(caught(() => assertQueryBudget({ ...budget, [Symbol("hidden")]: 1 })).message).toBe("query budget must not contain symbol keys")
    expect(caught(() => assertQueryBudget({ ...budget, extra: 1 })).message).toBe("Unknown field extra in query budget")
    const { maxSortFields: _removed, ...incomplete } = budget
    expect(caught(() => assertQueryBudget(incomplete)).message).toBe("query budget.maxSortFields is required")
    const accessor = Object.defineProperty({ ...budget }, "maxSortFields", { enumerable: true, get: () => 1 })
    expect(caught(() => assertQueryBudget(accessor)).message).toBe("query budget.maxSortFields must be a data property")
  })

  it("rejects non-positive and unsafe budget values with exact messages", () => {
    expect(caught(() => assertQueryBudget({ ...budget, maxSortFields: 0 })).message).toBe("maxSortFields must be a positive safe integer")
    expect(caught(() => assertQueryBudget({ ...budget, maxSortFields: Number.MAX_SAFE_INTEGER + 1 })).message).toBe("maxSortFields must be a positive safe integer")
    const allOnes = Object.fromEntries(Object.keys(budget).map((key) => [key, 1]))
    expect(() => assertQueryBudget(allOnes)).not.toThrow()
  })

  it("compiles budgets only from own, defined budget keys", () => {
    const inherited = Object.create({ maxSortFields: 3 })
    expect(compileQueryBudget(inherited).maxSortFields).toBe(DEFAULT_QUERY_BUDGET.maxSortFields)
    expect(compileQueryBudget({ maxSortFields: undefined }).maxSortFields).toBe(DEFAULT_QUERY_BUDGET.maxSortFields)
    expect(compileQueryBudget({ maxSortFields: 4 }).maxSortFields).toBe(4)
  })

  it("reports exact plan-level messages", () => {
    expect(caught(() => validateQueryPlan(null)).message).toBe("query plan must be a plain object")
    expect(caught(() => validateQueryPlan({ extra: true })).message).toBe("Unknown field extra in query plan")
    expect(caught(() => validateQueryPlan({ [Symbol("x")]: 1 })).message).toBe("query plan must not contain symbol keys")
    expect(caught(() => validateQueryPlan({ search: {} })).message).toBe("query search.text is required")
    expect(caught(() => validateQueryPlan({ search: { text: 1 } })).message).toBe("query search.text must be a string")
    expect(caught(() => validateQueryPlan({ search: { text: "abcde" } }, small)).message).toBe("query search exceeds maximum UTF-8 bytes")
    expect(() => validateQueryPlan({ search: { text: "abcd" } }, small)).not.toThrow()
    expect(caught(() => validateQueryPlan({ consistency: "causal" })).message).toBe("query consistency is invalid")
  })

  it("reports exact sort messages and the sort field limit", () => {
    expect(caught(() => validateQueryPlan({ sort: {} })).message).toBe("query sort must be an array")
    expect(caught(() => validateQueryPlan({ sort: [{ field: " ", direction: "asc" }] })).message).toBe("query sort field must be a non-empty string")
    expect(caught(() => validateQueryPlan({ sort: [{ field: "a", direction: "up" }] })).message).toBe("query sort direction must be asc or desc")
    expect(caught(() => validateQueryPlan({ sort: [{ field: "a", direction: "asc", nulls: "middle" }] })).message).toBe("query sort null ordering must be first or last")
    expect(caught(() => validateQueryPlan({ sort: [{ field: "a", direction: "asc" }, { field: "b", direction: "asc" }] }, small)).message).toBe("query exceeds maximum sort fields")
    expect(caught(() => validateQueryPlan({ sort: [{ field: "a", direction: "asc" }, { field: "a", direction: "desc" }] }, { ...small, maxSortFields: 2 })).message).toBe("query sort fields must be unique")
    expect(() => validateQueryPlan({ sort: [{ field: "a", direction: "asc", nulls: "first" }, { field: "b", direction: "desc", nulls: "last" }] })).not.toThrow()
  })

  it("reports exact pagination messages", () => {
    expect(caught(() => validateQueryPlan({ pagination: { kind: "weird" } })).message).toBe("query pagination has unknown kind weird")
    expect(caught(() => validateQueryPlan({ pagination: { kind: "offset", page: 0, pageSize: 10 } })).message).toBe("offset pagination.page must be a positive safe integer")
    expect(caught(() => validateQueryPlan({ pagination: { kind: "offset", page: 1, pageSize: 0 } })).message).toBe("offset pagination.pageSize must be a positive safe integer")
    expect(caught(() => validateQueryPlan({ pagination: { kind: "cursor", after: "a", limit: 0 } })).message).toBe("cursor pagination.limit must be a positive safe integer")
    expect(caught(() => validateQueryPlan({ pagination: { kind: "cursor", limit: 1 } })).message).toBe("cursor pagination must set exactly one of after or before")
    expect(caught(() => validateQueryPlan({ pagination: { kind: "cursor", after: " ", limit: 1 } })).message).toBe("cursor pagination boundary must be a non-empty string")
    expect(caught(() => validateQueryPlan({ pagination: { kind: "cursor", after: "x".repeat(16385), limit: 1 } })).message).toBe("cursor pagination boundary exceeds maximum UTF-8 bytes")
    expect(() => validateQueryPlan({ pagination: { kind: "cursor", before: "x".repeat(16384), limit: 1 } })).not.toThrow()
  })

  it("reports exact projection messages and the projection limit", () => {
    expect(caught(() => validateQueryPlan({ projection: { fields: "id" } })).message).toBe("query projection.fields must be an array")
    expect(caught(() => validateQueryPlan({ projection: { fields: ["a", "b"] } }, small)).message).toBe("query exceeds maximum projection fields")
    expect(caught(() => validateQueryPlan({ projection: { fields: ["a", "a"] } }, { ...small, maxProjectionFields: 2 })).message).toBe("query projection fields must be unique")
    expect(caught(() => validateQueryPlan({ projection: { fields: [""] } })).message).toBe("query projection field must be a non-empty string")
  })

  it("reports exact predicate structure messages", () => {
    const condition = (extra) => ({ filter: { kind: "condition", field: "a", ...extra } })
    expect(caught(() => validateQueryPlan({ filter: "x" })).message).toBe("query predicate must be an object")
    expect(caught(() => validateQueryPlan({ filter: { kind: "literal", value: "yes" } })).message).toBe("literal predicate.value must be boolean")
    expect(() => validateQueryPlan({ filter: { kind: "literal", value: false } })).not.toThrow()
    expect(caught(() => validateQueryPlan({ filter: { kind: "weird" } })).message).toBe("query predicate has unknown kind weird")
    expect(caught(() => validateQueryPlan(condition({ op: "nope", value: 1 }))).message).toBe("condition predicate has unknown operator nope")
    expect(caught(() => validateQueryPlan(condition({ op: "isNull", value: 1 }))).message).toBe("predicate operator isNull does not accept a value")
    expect(caught(() => validateQueryPlan(condition({ op: "eq" }))).message).toBe("predicate operator eq requires a value")
    expect(caught(() => validateQueryPlan({ filter: { kind: "condition", field: " ", op: "eq", value: 1 } })).message).toBe("condition predicate.field must be a non-empty string")
    expect(caught(() => validateQueryPlan(condition({ op: "between", value: 5 }))).message).toBe("between predicate.value must be an object")
    expect(caught(() => validateQueryPlan(condition({ op: "between", value: {} }))).message).toBe("between predicate requires at least one bound")
    expect(caught(() => validateQueryPlan(condition({ op: "between", value: { from: {} } }))).message).toBe("between predicate.from must be a scalar value")
    expect(caught(() => validateQueryPlan(condition({ op: "between", value: { to: {} } }))).message).toBe("between predicate.to must be a scalar value")
    expect(() => validateQueryPlan(condition({ op: "between", value: { to: 2 } }))).not.toThrow()
    expect(caught(() => validateQueryPlan(condition({ op: "in", value: {} }))).message).toBe("in predicate.value must be an array")
  })

  it("reports exact scalar value messages", () => {
    const eq = (value) => ({ filter: { kind: "condition", field: "a", op: "eq", value } })
    expect(caught(() => validateQueryPlan(eq({}))).message).toBe("eq predicate.value must be a scalar value")
    expect(caught(() => validateQueryPlan(eq(Symbol("s")))).message).toBe("eq predicate.value must be a scalar value")
    expect(caught(() => validateQueryPlan(eq(new Date(Number.NaN)))).message).toBe("eq predicate.value must be a valid Date")
    expect(caught(() => validateQueryPlan(eq(Number.NaN))).message).toBe("eq predicate.value must be a finite safe number")
    expect(caught(() => validateQueryPlan(eq(Number.POSITIVE_INFINITY))).message).toBe("eq predicate.value must be a finite safe number")
    expect(caught(() => validateQueryPlan(eq(Number.MAX_SAFE_INTEGER + 2))).message).toBe("eq predicate.value must be a finite safe number")
    expect(caught(() => validateQueryPlan(eq("x".repeat(MAX_QUERY_VALUE_BYTES + 1)))).message).toBe(`eq predicate.value exceeds ${MAX_QUERY_VALUE_BYTES} UTF-8 bytes`)
    expect(() => validateQueryPlan(eq("x".repeat(MAX_QUERY_VALUE_BYTES)))).not.toThrow()
    expect(() => validateQueryPlan(eq(Number.MAX_SAFE_INTEGER))).not.toThrow()
    expect(() => validateQueryPlan(eq(0.5))).not.toThrow()
  })

  it("enforces the total predicate value byte budget with an exact message", () => {
    const values = Array.from({ length: 9 }, () => "y".repeat(MAX_QUERY_VALUE_BYTES))
    expect(caught(() => validateQueryPlan({ filter: Predicate.in("id", values) }, { ...budget, maxInValues: 9 })).message).toBe(`query predicate values exceed ${MAX_QUERY_TOTAL_VALUE_BYTES} UTF-8 bytes`)
    const exact = Array.from({ length: 8 }, () => "y".repeat(MAX_QUERY_VALUE_BYTES))
    expect(() => validateQueryPlan({ filter: Predicate.in("id", exact) }, { ...budget, maxInValues: 8 })).not.toThrow()
  })

  it("reports exact in-list messages", () => {
    expect(caught(() => validateQueryPlan({ filter: Predicate.in("id", [1, 2, 3]) }, small)).message).toBe("query predicate exceeds maximum IN values")
  })

  it("reports exact depth, node and OR-branch messages", () => {
    expect(caught(() => validateQueryPlan({ filter: Predicate.not(Predicate.not(Predicate.eq("id", 1))) }, { ...budget, maxPredicateDepth: 2 })).message).toBe("query predicate exceeds maximum depth")
    expect(caught(() => validateQueryPlan({ filter: Predicate.and(Predicate.eq("a", 1), Predicate.eq("b", 2), Predicate.eq("c", 3)) }, { ...budget, maxPredicateNodes: 3 })).message).toBe("query predicate exceeds maximum node count")
    expect(caught(() => validateQueryPlan({ filter: Predicate.or(Predicate.eq("a", 1), Predicate.eq("a", 2)) }, { ...budget, maxOrBranches: 1 })).message).toBe("query predicate exceeds maximum OR branches")
    expect(() => validateQueryPlan({ filter: Predicate.or(Predicate.eq("a", 1), Predicate.eq("a", 2)) }, { ...budget, maxOrBranches: 2 })).not.toThrow()
    expect(() => validateQueryPlan({ filter: Predicate.not(Predicate.eq("a", 1)) }, { ...budget, maxPredicateDepth: 2 })).not.toThrow()
  })

  it("reports exact container, cycle and nesting messages", () => {
    expect(caught(() => validateQueryPlan({ filter: { kind: "and", filters: "x" } })).message).toBe("and predicate.filters must be an array")
    const withExtra = [Predicate.literal(true)]
    withExtra.extra = 1
    expect(caught(() => validateQueryPlan({ filter: { kind: "and", filters: withExtra } })).message).toBe("and predicate.filters must be a dense array without extra properties")
    const shared = { kind: "or", filters: [] }
    shared.filters.push(shared)
    expect(caught(() => validateQueryPlan({ filter: shared })).message).toBe("query plan contains a cycle")
    let node = { kind: "not", filter: { kind: "literal", value: true } }
    for (let index = 0; index < MAX_PREDICATE_EVALUATION_DEPTH + 2; index += 1) node = { kind: "not", filter: node }
    const error = caught(() => validateQueryPlan({ filter: node }, { ...budget, maxPredicateDepth: 10000, maxPredicateNodes: 10000 }))
    expect(error).toBeInstanceOf(ConfigurationError)
    expect(error.message).toBe(`Query predicate combined with trusted scopes exceeds ${MAX_PREDICATE_EVALUATION_DEPTH} levels`)
  })
})

describe("cursor codec error messages and boundaries", () => {
  it("reports exact messages for malformed payloads and byte limits at encode time", async () => {
    expect((await caughtAsync(() => encodeCursor(null, mac(3)))).message).toBe("malformed cursor payload")
    expect((await caughtAsync(() => encodeCursor({ ...payload, expiresAt: 1.5 }, mac(3)))).message).toBe("malformed cursor payload")
    expect((await caughtAsync(() => encodeCursor({ ...payload, direction: "sideways" }, mac(3)))).message).toBe("malformed cursor payload")
    expect((await caughtAsync(() => encodeCursor({ ...payload, values: [{}] }, mac(3)))).message).toBe("malformed cursor payload")
    expect((await caughtAsync(() => encodeCursor({ ...payload, routeHash: "" }, mac(3)))).message).toBe("malformed cursor payload")
    expect((await caughtAsync(() => encodeCursor(payload, mac(3), 1))).message).toBe("cursor payload exceeds byte limit")
    expect((await caughtAsync(() => encodeCursor(payload, mac(3), 0))).message).toBe("cursor byte limit must be a positive safe integer")
    expect((await caughtAsync(() => encodeCursor(payload, mac(3), 1.5))).message).toBe("cursor byte limit must be a positive safe integer")
  })

  it("accepts expiry zero and rejects it only at its own boundary", async () => {
    const cursor = await encodeCursor({ ...payload, expiresAt: 0 }, mac(3))
    await expect(decodeCursor(cursor, mac(3), 8192, { now: -1 })).resolves.toMatchObject({ expiresAt: 0 })
    expect((await caughtAsync(() => decodeCursor(cursor, mac(3), 8192, { now: 0 }))).message).toBe("cursor expired")
  })

  it("reports exact messages for malformed decode input and size limits", async () => {
    expect((await caughtAsync(() => decodeCursor(123, mac(3)))).message).toBe("cursor must be a string")
    expect((await caughtAsync(() => decodeCursor("x".repeat(17), mac(3), 8))).message).toBe("cursor exceeds byte limit")
    expect((await caughtAsync(() => decodeCursor("x".repeat(16), mac(3), 8))).message).toBe("malformed cursor")
    expect((await caughtAsync(() => decodeCursor("v1.abc", mac(3)))).message).toBe("malformed cursor")
    expect((await caughtAsync(() => decodeCursor("v1..sig", mac(3)))).message).toBe("malformed cursor")
    expect((await caughtAsync(() => decodeCursor("v1.!!!.sig", mac(3)))).message).toBe("malformed cursor encoding")
    expect((await caughtAsync(() => decodeCursor("v1.abc.!!!", mac(3)))).message).toBe("malformed cursor encoding")
  })

  it("rejects integrity failures with the exact message, including truthy non-true verifiers", async () => {
    const cursor = await encodeCursor(payload, mac(3))
    expect((await caughtAsync(() => decodeCursor(cursor, mac(5)))).message).toBe("cursor integrity verification failed")
    const truthy = { sign: mac(3).sign, verify: async () => 1 }
    expect((await caughtAsync(() => decodeCursor(cursor, truthy))).message).toBe("cursor integrity verification failed")
    const bytes = new TextEncoder().encode(canonicalJsonString(payload))
    expect((await caughtAsync(() => decodeCursor(cursor, mac(3), bytes.byteLength - 1))).message).toBe("cursor integrity verification failed")
    await expect(decodeCursor(cursor, mac(3), bytes.byteLength)).resolves.toMatchObject({ routeHash: "r" })
  })

  it("reports exact messages for payloads that are not canonical JSON or not a valid cursor", async () => {
    const signed = async (text) => {
      const bytes = new TextEncoder().encode(text)
      const signature = await mac(3).sign(bytes)
      return `v1.${Buffer.from(bytes).toString("base64url")}.${Buffer.from(signature).toString("base64url")}`
    }
    const notJson = await signed("{not json")
    expect((await caughtAsync(() => decodeCursor(notJson, mac(3)))).message).toBe("malformed or non-canonical cursor payload")
    const wrongShape = await signed(JSON.stringify({ format: "other" }))
    expect((await caughtAsync(() => decodeCursor(wrongShape, mac(3)))).message).toBe("malformed cursor payload")
  })

  it("accepts up to eight previous keys and rejects more with an exact message", () => {
    const eight = Array.from({ length: 8 }, (_, index) => mac(index + 2))
    const nine = Array.from({ length: 9 }, (_, index) => mac(index + 2))
    expect(() => createRotatingCursorIntegrity(mac(1), eight)).not.toThrow()
    expect(caught(() => createRotatingCursorIntegrity(mac(1), nine)).message).toBe("too many previous cursor keys")
  })

  it("does not accept a signature from an unknown key", async () => {
    const rotating = createRotatingCursorIntegrity(mac(5), [mac(3)])
    expect(await rotating.verify(new Uint8Array([1, 2]), new Uint8Array([9]))).toBe(false)
  })
})

describe("cursor sort and binding error messages", () => {
  it("reports exact messages for invalid cursor ordering", () => {
    expect(caught(() => assertStableCursorSort([], ["id"])).message).toBe("cursor ordering must not be empty")
    expect(caught(() => assertStableCursorSort([{ field: "createdAt", direction: "asc" }], ["id"])).message).toBe("cursor ordering must end with a unique deterministic tie breaker")
    expect(caught(() => assertStableCursorSort([{ field: "id", direction: "asc" }, { field: "id", direction: "desc" }], ["id"])).message).toBe("cursor ordering contains duplicate fields")
    expect(caught(() => assertStableCursorSort([{ field: " ", direction: "asc" }], [" "])).message).toBe("cursor sort field must be non-empty")
    expect(caught(() => assertStableCursorSort([{ field: "createdAt", direction: "asc" }, { field: "id", direction: "asc" }], ["id"], ["createdAt"])).message).toBe("nullable cursor sort requires explicit null ordering")
    expect(() => assertStableCursorSort([{ field: "createdAt", direction: "asc" }, { field: "id", direction: "asc" }], ["id"])).not.toThrow()
  })

  it("reports the exact binding mismatch and accepts matching bindings", () => {
    const expected = { routeHash: "r", queryHash: "q", scopeHash: "s", sortHash: "o" }
    expect(caught(() => assertCursorBinding({ ...payload }, { ...expected, routeHash: "other" })).message).toBe("cursor routeHash binding mismatch")
    expect(caught(() => assertCursorBinding({ ...payload }, { ...expected, sortHash: "other" })).message).toBe("cursor sortHash binding mismatch")
    expect(() => assertCursorBinding({ ...payload }, expected)).not.toThrow()
  })
})

describe("projection resolution", () => {
  it("defaults to the intersection of route, queryable and readable fields", () => {
    expect(resolveProjection(undefined, ["id", "secret", "name"], ["id", "secret"], ["id", "secret"])).toEqual({ fields: ["id", "secret"] })
    expect(resolveProjection(undefined, ["id"], ["id"], [])).toEqual({ fields: [] })
  })

  it("rejects duplicates and fields outside the allowed intersection with the exact message", () => {
    const message = "projection contains a forbidden, hidden, duplicate, or non-queryable field"
    expect(caught(() => resolveProjection({ fields: ["id", "id"] }, ["id"], ["id"], ["id"])).message).toBe(message)
    expect(caught(() => resolveProjection({ fields: ["name"] }, ["id", "name"], ["id"], ["id", "name"])).message).toBe(message)
    expect(caught(() => resolveProjection({ fields: ["name"] }, ["id", "name"], ["id", "name"], ["id"])).message).toBe(message)
  })
})

describe("search request messages and branches", () => {
  const capability = { portKey: "search", searchableFields: new Set(["name"]), filterableFields: new Set(["tenantId"]), sortableFields: new Set(["name"]), consistency: ["eventual"], maxQueryBytes: 5, maxResults: 2 }
  const request = { scope: { kind: "tenant", tenantId: "t1" }, text: "test", fields: ["name"], filter: { tenantId: "t1" }, sort: [{ field: "name", direction: "asc" }], limit: 2, consistency: "eventual" }
  const check = (value, cap = capability) => validateSearchRequest(cap, value)

  it("reports exact capability declaration messages", () => {
    expect(caught(() => validateSearchRequest(null, request)).message).toBe("Search capability portKey is required")
    expect(caught(() => check(request, { ...capability, portKey: 7 })).message).toBe("Search capability portKey is required")
    expect(caught(() => check(request, { ...capability, maxQueryBytes: 0 })).message).toBe("Search capability budgets must be positive safe integers")
    expect(caught(() => check(request, { ...capability, maxResults: 0 })).message).toBe("Search capability budgets must be positive safe integers")
    expect(caught(() => check(request, { ...capability, searchableFields: [] })).message).toBe("Search capability field and consistency declarations are invalid")
    expect(caught(() => check(request, { ...capability, consistency: "eventual" })).message).toBe("Search capability field and consistency declarations are invalid")
  })

  it("reports exact request shape messages", () => {
    expect(caught(() => check(null)).message).toBe("Search request is invalid")
    expect(caught(() => check({ ...request, text: 1 })).message).toBe("Search request is invalid")
    expect(caught(() => check({ ...request, fields: {} })).message).toBe("Search request is invalid")
    expect(caught(() => check({ ...request, deadline: Number.NaN })).message).toBe("Search request deadline is invalid")
    expect(caught(() => check({ ...request, text: "€€" })).message).toBe("Search query exceeds byte budget")
    expect(caught(() => check({ ...request, limit: 3 })).message).toBe("Search result limit exceeds capability")
    expect(caught(() => check({ ...request, limit: 0 })).message).toBe("Search result limit exceeds capability")
    expect(caught(() => check({ ...request, fields: ["name", "name"] })).message).toBe("Search fields must be unique non-empty strings")
    expect(caught(() => check({ ...request, fields: [" "] })).message).toBe("Search fields must be unique non-empty strings")
    expect(caught(() => check({ ...request, fields: ["secret"] })).message).toBe("Search field is not authorized: secret")
    expect(caught(() => check({ ...request, filter: [] })).message).toBe("Search filter must be an object")
    expect(caught(() => check({ ...request, filter: null })).message).toBe("Search filter must be an object")
    expect(caught(() => check({ ...request, filter: { secret: 1 } })).message).toBe("Search filter field is not authorized: secret")
    expect(caught(() => check({ ...request, sort: {} })).message).toBe("Search sort must be an array")
    expect(caught(() => check({ ...request, sort: [{ field: "name", direction: "asc" }, { field: "name", direction: "desc" }] })).message).toBe("Search sort fields must be unique")
    expect(caught(() => check({ ...request, sort: [{ field: "secret", direction: "asc" }] })).message).toBe("Search sort field is not authorized: secret")
    expect(caught(() => check({ ...request, sort: [{ field: "name", direction: "sideways" }] })).message).toBe("Search sort field is not authorized: name")
  })

  it("accepts boundary requests", () => {
    expect(() => check({ ...request, text: "abcde", limit: 2, deadline: undefined, filter: undefined, sort: undefined })).not.toThrow()
    expect(() => check({ ...request, limit: 1, filter: {}, sort: [] })).not.toThrow()
    expect(() => check({ ...request, deadline: Date.now() + 60000 })).not.toThrow()
  })

  it("uses the injected clock and reports exact timeout and clock messages", () => {
    const later = { now: () => new Date(3000) }
    expect(caught(() => validateSearchRequest(capability, { ...request, deadline: 2000 }, later)).message).toBe("Search request deadline expired")
    expect(caught(() => validateSearchRequest(capability, { ...request, deadline: 2000 }, Number.POSITIVE_INFINITY)).message).toBe("Search clock must return a finite time")
    expect(caught(() => validateSearchRequest(capability, { ...request, deadline: 2000 }, { now: () => new Date(Number.NaN) })).message).toBe("Search clock must return a finite time")
    expect(() => validateSearchRequest(capability, { ...request, deadline: 5000 }, 3000)).not.toThrow()
    expect(caught(() => validateSearchRequest(capability, { ...request, deadline: 2000 }, 2000))).toBeInstanceOf(TimeoutError)
  })

  it("reports cancellation as CancelledError with the exact message", () => {
    const controller = new AbortController()
    controller.abort(new Error("gone"))
    const error = caught(() => validateSearchRequest(capability, { ...request, signal: controller.signal }))
    expect(error).toBeInstanceOf(CancelledError)
    expect(error.message).toBe("Search request is cancelled")
  })

  it("reports exact provider-result messages and freezes accepted results", () => {
    const hit = { id: "1", score: 1, fields: { name: "A" } }
    const result = (value) => validateSearchResult(capability, request, value)
    expect(caught(() => result(null)).message).toBe("Search provider returned an invalid or excessive result")
    expect(caught(() => result({ hits: [hit, { ...hit, id: "2" }, { ...hit, id: "3" }], consistency: "eventual" })).message).toBe("Search provider returned an invalid or excessive result")
    expect(caught(() => result({ hits: [hit], consistency: "strong" })).message).toBe("Search provider did not satisfy requested consistency")
    expect(caught(() => result({ hits: [hit], consistency: "eventual", total: 0 })).message).toBe("Search provider returned an invalid total")
    expect(caught(() => result({ hits: [{ ...hit, id: " " }], consistency: "eventual" })).message).toBe("Search provider returned an invalid hit")
    expect(caught(() => result({ hits: [{ ...hit, score: "1" }], consistency: "eventual" })).message).toBe("Search provider returned an invalid hit")
    expect(caught(() => result({ hits: [{ ...hit, fields: { secret: 1 } }], consistency: "eventual" })).message).toBe("Search provider returned an unauthorized field: secret")
    const accepted = result({ hits: [hit], consistency: "eventual" })
    expect(accepted).toEqual({ hits: [hit], consistency: "eventual" })
    expect(Object.isFrozen(accepted)).toBe(true)
    expect(Object.isFrozen(accepted.hits)).toBe(true)
  })
})
