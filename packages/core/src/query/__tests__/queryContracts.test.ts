import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { describe, expect, it } from "vitest"
import { Predicate } from "../../domain/predicate.js"
import {
  assertCursorBinding,
  assertReadConsistencySupported,
  assertStableCursorSort,
  createRotatingCursorIntegrity,
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

describe("query contracts", () => {
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

describe("cursor contracts", () => {
  it("round trips an integrity-protected canonical cursor", async () => {
    const encoded = await encodeCursor(payload, integrity)
    expect(await decodeCursor(encoded, integrity)).toEqual(payload)
  })
  it("rejects tampering, malformed input, and excessive size", async () => {
    const encoded = await encodeCursor(payload, integrity)
    await expect(decodeCursor(`${encoded.slice(0, -1)}x`, integrity)).rejects.toThrow(/integrity|malformed/)
    // Flipping only the unused low bits of the last character used to yield a second valid spelling.
    const last = encoded.at(-1)!
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    const sibling = `${encoded.slice(0, -1)}${alphabet[alphabet.indexOf(last) ^ 1]}`
    await expect(decodeCursor(sibling, integrity)).rejects.toThrow()
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

describe("cursor expiry and key rotation", () => {
  const mac = (secret: number) => ({
    sign: async (payload: Uint8Array) => Uint8Array.of(payload.reduce((sum, byte) => (sum + byte * secret) % 251, secret)),
    verify: async (payload: Uint8Array, signature: Uint8Array) => signature.length === 1 && signature[0] === payload.reduce((sum, byte) => (sum + byte * secret) % 251, secret),
  })
  const payload = { format: "framework.cursor" as const, version: 1 as const, direction: "after" as const, values: ["a", 1], routeHash: "r", queryHash: "q", scopeHash: "s", sortHash: "o" }

  it("rejects an expired cursor and accepts it before expiry", async () => {
    const cursor = await encodeCursor({ ...payload, expiresAt: 1_000 }, mac(3))
    await expect(decodeCursor(cursor, mac(3), 8192, { now: 999 })).resolves.toMatchObject({ expiresAt: 1_000 })
    await expect(decodeCursor(cursor, mac(3), 8192, { now: 1_000 })).rejects.toThrow("cursor expired")
    await expect(encodeCursor({ ...payload, expiresAt: -1 }, mac(3))).rejects.toThrow("malformed")
  })

  it("verifies cursors signed by a previous key during rotation and signs with the current key", async () => {
    const old = await encodeCursor(payload, mac(3))
    const rotating = createRotatingCursorIntegrity(mac(5), [mac(3)])
    await expect(decodeCursor(old, rotating)).resolves.toMatchObject({ routeHash: "r" })
    const fresh = await encodeCursor(payload, rotating)
    await expect(decodeCursor(fresh, mac(5))).resolves.toMatchObject({ routeHash: "r" })
    await expect(decodeCursor(old, mac(5))).rejects.toThrow("integrity")
  })
})

describe("predicate value byte limits", () => {
  it("rejects oversized string literals and oversized value totals", async () => {
    const { MAX_QUERY_VALUE_BYTES } = await import("../queryBudget")
    expect(() => validateQueryPlan({ filter: Predicate.eq("name", "x".repeat(MAX_QUERY_VALUE_BYTES + 1)) })).toThrow(/UTF-8 bytes/)
    expect(() => validateQueryPlan({ filter: Predicate.in("id", Array.from({ length: 10 }, () => "y".repeat(8000))) })).toThrow(/values exceed/)
    expect(() => validateQueryPlan({ filter: Predicate.in("id", ["a", "b"]) })).not.toThrow()
  })
})
