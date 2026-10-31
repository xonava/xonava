import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { RequestContext } from "@xonava/core/domain"
import { canonicalJsonString } from "@xonava/core/serialization"
import {
  IdempotencyPayloadTooLargeError,
  MAX_IDEMPOTENCY_CANONICAL_BYTES,
  MAX_SERIALIZED_RESPONSE_BODY_BYTES,
  boundRateLimitKeyMaterial,
  buildIdempotencyScopeIdentity,
  buildIdempotencySecurityContext,
  deserializeResponse,
  fingerprintJson,
  serializeResponse,
  type SerializedResponse,
} from "../idempotency"

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

const context = (over: Record<string, unknown> = {}): RequestContext => ({
  scope: { kind: "platform", platformKey: "p" },
  scopeId: "scope-1",
  identity: { actor: { id: "a1", kind: "human" }, subject: { id: "a1", kind: "human" } },
  ...over,
}) as never

describe("idempotency principal identity", () => {
  it("names the scope, actor kind and id, and subject kind and id", () => {
    expect(buildIdempotencyScopeIdentity(context())).toBe("scope-1:human:a1:human:a1")
    const impersonating = context({ identity: { actor: { id: "a1", kind: "human" }, subject: { id: "s2", kind: "service" } } })
    expect(buildIdempotencyScopeIdentity(impersonating)).toBe("scope-1:human:a1:service:s2")
  })

  it("describes a platform request without a tenant", () => {
    expect(buildIdempotencySecurityContext(context())).toEqual({
      scope: "scope-1",
      actorId: "a1",
      actorType: "human",
      tenantId: null,
      roleId: null,
      roleSlug: null,
      branchId: null,
      departmentId: null,
      impersonatedById: null,
    })
  })

  it("carries the tenant of a tenant request", () => {
    expect(buildIdempotencySecurityContext(context({ scope: { kind: "tenant", tenantId: "t-1" } })).tenantId).toBe("t-1")
    expect(buildIdempotencySecurityContext(context({ scope: { kind: "application", applicationKey: "app" } })).tenantId).toBeNull()
  })

  it("names the actor as impersonator when the subject differs by id or by kind", () => {
    const byId = context({ identity: { actor: { id: "a1", kind: "human" }, subject: { id: "s2", kind: "human" } } })
    expect(buildIdempotencySecurityContext(byId).impersonatedById).toBe("a1")
    const byKind = context({ identity: { actor: { id: "a1", kind: "human" }, subject: { id: "a1", kind: "service" } } })
    expect(buildIdempotencySecurityContext(byKind).impersonatedById).toBe("a1")
    const both = context({ identity: { actor: { id: "a1", kind: "human" }, subject: { id: "s2", kind: "service" } } })
    expect(buildIdempotencySecurityContext(both).impersonatedById).toBe("a1")
    expect(buildIdempotencySecurityContext(context()).impersonatedById).toBeNull()
  })
})

describe("fingerprints", () => {
  it("hashes the versioned canonical form", async () => {
    const value = { b: 2, a: [1, { z: true }] }
    expect(await fingerprintJson(value)).toBe(sha256(`v3\0${canonicalJsonString(value)}`))
  })

  it("accepts a payload of exactly the canonical size limit and refuses one byte more", async () => {
    const prefixAndQuotes = "v3\0".length + 2
    const atLimit = "a".repeat(MAX_IDEMPOTENCY_CANONICAL_BYTES - prefixAndQuotes)
    await expect(fingerprintJson(atLimit)).resolves.toMatch(/^[0-9a-f]{64}$/)
    await expect(fingerprintJson(`${atLimit}a`)).rejects.toBeInstanceOf(IdempotencyPayloadTooLargeError)
  })

  it("describes the oversize failure", () => {
    const error = new IdempotencyPayloadTooLargeError()
    expect(error.message).toBe("Idempotency fingerprint payload is too large")
    expect(error.name).toBe("IdempotencyPayloadTooLargeError")
    expect(error).toBeInstanceOf(Error)
  })
})

describe("rate limit key material", () => {
  it("keeps material up to the bound as is and digests anything longer", async () => {
    const exact = "k".repeat(128)
    expect(await boundRateLimitKeyMaterial(exact)).toBe(exact)
    const longer = `${exact}x`
    expect(await boundRateLimitKeyMaterial(longer)).toBe(`${exact}:${await fingerprintJson({ material: longer })}`)
    const other = `${exact}y`
    expect(await boundRateLimitKeyMaterial(other)).not.toBe(await boundRateLimitKeyMaterial(longer))
    expect(await boundRateLimitKeyMaterial("")).toBe("")
  })
})

describe("response serialization", () => {
  it("keeps the status, body and the replayable headers only", async () => {
    const response = new Response('{"ok":true}', {
      status: 201,
      headers: { "content-type": "application/json", "cache-control": "no-store", etag: '"1"', "retry-after": "5", "x-private": "no", "set-cookie": "a=b", "content-length": "11", connection: "keep-alive" },
    })
    const serialized = await serializeResponse(response)
    expect(serialized.version).toBe("v1")
    expect(serialized.status).toBe(201)
    expect(serialized.body).toBe('{"ok":true}')
    expect(Object.fromEntries(serialized.headers)).toEqual({ "content-type": "application/json", "cache-control": "no-store", etag: '"1"', "retry-after": "5" })
    expect(Object.keys(serialized).sort()).toEqual(["body", "headers", "status", "version"])
  })

  it("accepts a body of exactly the size limit and refuses one byte more", async () => {
    const exact = "a".repeat(MAX_SERIALIZED_RESPONSE_BODY_BYTES)
    expect((await serializeResponse(new Response(exact))).body.length).toBe(MAX_SERIALIZED_RESPONSE_BODY_BYTES)
    await expect(serializeResponse(new Response(`${exact}a`))).rejects.toThrow(new Error("Idempotency response body is too large"))
  })
})

describe("response deserialization", () => {
  const valid = (over: Record<string, unknown> = {}): SerializedResponse => ({ version: "v1", body: "hi", status: 200, headers: [["content-type", "text/plain"]], ...over }) as never

  it("rebuilds the response", async () => {
    const response = deserializeResponse(valid({ status: 202, headers: [["Content-Type", "text/plain"], ["etag", '"1"']] }))
    expect(response.status).toBe(202)
    expect(await response.text()).toBe("hi")
    expect(response.headers.get("content-type")).toBe("text/plain")
    expect(response.headers.get("etag")).toBe('"1"')
  })

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "text"],
    ["a number", 5],
    ["a wrong version", valid({ version: "v2" })],
    ["a missing version", valid({ version: undefined })],
    ["a non-string body", valid({ body: 5 })],
    ["a missing body", valid({ body: undefined })],
    ["non-array headers", valid({ headers: "x" })],
    ["missing headers", valid({ headers: undefined })],
  ])("refuses %s", (_label, input) => {
    expect(() => deserializeResponse(input as never)).toThrow(new Error("Invalid serialized idempotency response"))
  })

  it("accepts statuses 200 through 599 only, as integers", async () => {
    for (const status of [200, 201, 599]) expect(deserializeResponse(valid({ status })).status).toBe(status)
    for (const status of [199, 600, 0, 200.5, Number.NaN, "200", undefined, -1, 1000]) {
      expect(() => deserializeResponse(valid({ status }))).toThrow(new Error("Invalid serialized idempotency response status"))
    }
  })

  it.each([
    ["a non-array entry", ["content-type"]],
    ["an entry with one item", [["content-type"]]],
    ["an entry with three items", [["content-type", "a", "b"]]],
    ["a non-string name", [[5, "a"]]],
    ["a non-string value", [["content-type", 5]]],
  ])("refuses a header list with %s", (_label, headers) => {
    expect(() => deserializeResponse(valid({ headers }))).toThrow(new Error("Invalid serialized idempotency response headers"))
  })

  it("refuses malformed header names and values with the header-specific message", () => {
    for (const headers of [[["bad name", "x"]], [["content-type bad", "x"]], [["bad name content-type", "x"]], [["", "x"]], [["content-type", "a\nb"]], [["content-type", "a\rb"]]]) {
      expect(() => deserializeResponse(valid({ headers }))).toThrow(new Error("Invalid serialized idempotency response header"))
    }
    expect(() => deserializeResponse(valid({ headers: [["content-type", "ok"]] }))).not.toThrow()
  })

  it("refuses headers that are not replayable, duplicated or hop-by-hop", () => {
    for (const headers of [[["x-custom", "a"]], [["connection", "close"]], [["content-length", "2"]], [["set-cookie", "a=b"]], [["content-type", "a"], ["Content-Type", "b"]], [["etag", "1"], ["etag", "2"]]]) {
      expect(() => deserializeResponse(valid({ headers }))).toThrow(new Error("Invalid serialized idempotency response headers"))
    }
    expect(() => deserializeResponse(valid({ headers: [["content-type", "a"], ["cache-control", "b"], ["etag", "c"], ["retry-after", "1"]] }))).not.toThrow()
  })

  it("accepts a body of exactly the size limit and refuses one byte more", () => {
    const exact = "a".repeat(MAX_SERIALIZED_RESPONSE_BODY_BYTES)
    expect(deserializeResponse(valid({ body: exact })).status).toBe(200)
    expect(() => deserializeResponse(valid({ body: `${exact}a` }))).toThrow(new Error("Idempotency response body is too large"))
  })
})
