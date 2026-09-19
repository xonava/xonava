import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { describe, expect, it } from "vitest"
import { Predicate } from "../../domain/predicate.js"
import {
  assertCursorBinding,
  assertReadConsistencySupported,
  assertStableCursorSort,
  decodeCursor,
  encodeCursor,
  resolveProjection,
  validateQueryPlan,
  type CursorIntegrityPort,
  type CursorPayloadV1,
} from "../index.js"

const integrity: CursorIntegrityPort = {
  async sign(payload) { return createHmac("sha256", "test-only-key").update(payload).digest() },
  async verify(payload, signature) {
    const expected = createHmac("sha256", "test-only-key").update(payload).digest()
    return expected.length === signature.length && timingSafeEqual(expected, signature)
  },
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const payload: CursorPayloadV1 = { format: "framework.cursor", version: 1, direction: "after", values: ["2026-01-01", "id-1"], routeHash: hash("route"), queryHash: hash("query"), scopeHash: hash("tenant-a"), sortHash: hash("createdAt:asc,id:asc") }

describe("Q1 query contracts", () => {
  it("enforces semantic budgets independent of transport", () => {
    expect(() => validateQueryPlan({ filter: Predicate.or(Predicate.eq("a", 1), Predicate.eq("a", 2)) }, { maxPredicateDepth: 2, maxPredicateNodes: 5, maxOrBranches: 1, maxInValues: 2, maxSortFields: 1, maxProjectionFields: 1, maxSearchBytes: 2 })).toThrow(/OR branches/)
    expect(() => validateQueryPlan({ filter: Predicate.in("id", [1, 2, 3]) }, { maxPredicateDepth: 2, maxPredicateNodes: 5, maxOrBranches: 2, maxInValues: 2, maxSortFields: 1, maxProjectionFields: 1, maxSearchBytes: 2 })).toThrow(/IN values/)
    expect(() => validateQueryPlan({ search: { text: "€" } }, { maxPredicateDepth: 2, maxPredicateNodes: 5, maxOrBranches: 2, maxInValues: 2, maxSortFields: 1, maxProjectionFields: 1, maxSearchBytes: 2 })).toThrow(/UTF-8 bytes/)
  })
  it("intersects route, queryable, and readable projection fields", () => {
    expect(resolveProjection({ fields: ["id"] }, ["id", "secret"], ["id", "secret"], ["id"])).toEqual({ fields: ["id"] })
    expect(() => resolveProjection({ fields: ["secret"] }, ["id", "secret"], ["id", "secret"], ["id"])).toThrow(/forbidden/)
  })
  it("rejects read-consistency downgrade", () => {
    expect(() => assertReadConsistencySupported("strong", ["eventual"])).toThrow(/not proven/)
  })
})

describe("Q2 cursor contracts", () => {
  it("round trips an integrity-protected canonical cursor", async () => {
    const encoded = await encodeCursor(payload, integrity)
    expect(await decodeCursor(encoded, integrity)).toEqual(payload)
  })
  it("rejects tampering, malformed input, and excessive size", async () => {
    const encoded = await encodeCursor(payload, integrity)
    await expect(decodeCursor(`${encoded.slice(0, -1)}x`, integrity)).rejects.toThrow(/integrity/)
    await expect(decodeCursor("not-a-cursor", integrity)).rejects.toThrow(/malformed/)
    await expect(decodeCursor(encoded.replace(/^v1\./, "v2."), integrity)).rejects.toThrow(/malformed/)
    await expect(decodeCursor("x".repeat(17_000), integrity)).rejects.toThrow(/byte limit/)
    const nonCanonical = new TextEncoder().encode(JSON.stringify(payload, null, 2))
    const signature = await integrity.sign(nonCanonical)
    await expect(decodeCursor(`v1.${Buffer.from(nonCanonical).toString("base64url")}.${Buffer.from(signature).toString("base64url")}`, integrity)).rejects.toThrow(/non-canonical/)
  })
  it.each(["routeHash", "queryHash", "scopeHash", "sortHash"] as const)("rejects a mismatched %s", key => {
    expect(() => assertCursorBinding(payload, { routeHash: payload.routeHash, queryHash: payload.queryHash, scopeHash: payload.scopeHash, sortHash: payload.sortHash, [key]: "wrong" })).toThrow(/binding mismatch/)
  })
  it("requires a unique tie breaker and explicit nullable ordering", () => {
    expect(() => assertStableCursorSort([{ field: "createdAt", direction: "asc" }], ["id"])).toThrow(/tie breaker/)
    expect(() => assertStableCursorSort([{ field: "createdAt", direction: "asc" }, { field: "id", direction: "asc" }], ["id"], ["createdAt"])).toThrow(/null ordering/)
    expect(() => assertStableCursorSort([{ field: "createdAt", direction: "asc", nulls: "last" }, { field: "id", direction: "asc" }], ["id"], ["createdAt"])).not.toThrow()
  })
})
