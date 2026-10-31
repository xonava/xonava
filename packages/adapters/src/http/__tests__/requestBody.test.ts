import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { createFrameworkWriteHandler } from "../createFrameworkWriteHandler"
import { canonicalRequestNormalization } from "./canonicalRequest"
import { RequestBodyNotAcceptedError, UnsupportedMediaTypeError, parseJsonBodySafely, parseUniqueQueryParameters, resolveRequestMetadata } from "../requestBody"
import type { FrameworkAdapterDeps } from "../../server"
import type { PersistenceProvider } from "@xonava/core/persistence"
import { resolveTrustedClientIp } from "../trustedClientIp"
import { createFrameworkErrorHandler } from "../handleFrameworkCoreError"

const persistence = {} as PersistenceProvider

describe("HTTP request boundary helpers", () => {
  it("rejects duplicate __proto__ query parameters", () => {
    const request = new Request("https://example.test/?__proto__=first&__proto__=second")

    expect(() => parseUniqueQueryParameters(request)).toThrow("Duplicate query parameter: __proto__")
  })

  it("accepts a bodyless request without a body contract or content type", async () => {
    const request = new Request("https://example.test", { method: "DELETE" })

    await expect(parseJsonBodySafely(request)).resolves.toBeUndefined()
  })

  it("requires a supported JSON content type for a schema-backed body", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      body: JSON.stringify({ value: "ok" }),
    })

    await expect(parseJsonBodySafely(request, z.object({ value: z.string() }))).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA_TYPE",
    })
  })

  it("rejects non-empty bodies when no body contract is declared", async () => {
    const request = new Request("https://example.test", {
      method: "DELETE",
      body: "{}",
      headers: { "content-type": "application/json" },
    })

    await expect(parseJsonBodySafely(request)).rejects.toBeInstanceOf(RequestBodyNotAcceptedError)
    await expect(parseJsonBodySafely(request)).rejects.toMatchObject({
      code: "BODY_NOT_ACCEPTED",
    })
    const error: unknown = await parseJsonBodySafely(request).catch((caught: unknown) => caught)
    const response = createFrameworkErrorHandler()(error)
    expect(response.status).toBe(415)
    expect(await response.json()).toEqual({ error: "This operation does not accept a request body", code: "BODY_NOT_ACCEPTED" })
  })

  it("rejects non-empty text bodies with no body contract as not accepted, not as unsupported media type", async () => {
    const request = new Request("https://example.test", {
      method: "DELETE",
      body: "hello",
      headers: { "content-type": "text/plain" },
    })

    await expect(parseJsonBodySafely(request)).rejects.toMatchObject({
      code: "BODY_NOT_ACCEPTED",
    })
  })

  it("returns undefined for an empty body with no body contract", async () => {
    const request = new Request("https://example.test", { method: "DELETE", headers: { "content-type": "text/plain" } })

    await expect(parseJsonBodySafely(request)).resolves.toBeUndefined()
  })

  it("keeps the unsupported media type refusal for a schema-backed text body", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      body: JSON.stringify({ value: "ok" }),
      headers: { "content-type": "text/plain" },
    })

    const error = await parseJsonBodySafely(request, z.object({ value: z.string() })).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(UnsupportedMediaTypeError)
    expect(error).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" })
  })

  it("rejects malformed UTF-8 as invalid JSON", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      body: new Uint8Array([0xc3, 0x28]),
      headers: { "content-type": "application/json" },
    })

    await expect(parseJsonBodySafely(request, z.object({ value: z.string() }))).rejects.toMatchObject({
      code: "INVALID_JSON",
    })
  })

  it("rejects JSON bodies over the configured byte limit", async () => {
    const schema = z.object({ value: z.string() })
    const request = new Request("https://example.test", {
      method: "POST",
      body: JSON.stringify({ value: "too large" }),
    })

    await expect(parseJsonBodySafely(request, schema, 4)).rejects.toMatchObject({
      code: "REQUEST_BODY_TOO_LARGE",
    })
  })

  it("enforces the byte limit without a validation schema", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      body: "12345",
    })

    await expect(parseJsonBodySafely(request, undefined, 4)).rejects.toMatchObject({
      code: "REQUEST_BODY_TOO_LARGE",
    })
  })

  it("answers a non-empty body with no body contract as not accepted before parsing it as JSON", async () => {
    const request = new Request("https://example.test", {
      method: "DELETE",
      body: "{",
      headers: { "content-type": "application/json" },
    })

    await expect(parseJsonBodySafely(request)).rejects.toMatchObject({
      code: "BODY_NOT_ACCEPTED",
    })
  })

  it("rejects malformed JSON with a supported content type as invalid JSON", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      body: '{"value":',
      headers: { "content-type": "application/json" },
    })

    await expect(parseJsonBodySafely(request, z.object({ value: z.string() }))).rejects.toMatchObject({
      code: "INVALID_JSON",
    })
  })

  it("checks the content type before parsing a malformed body against a body contract", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      body: '{"value":',
      headers: { "content-type": "text/plain" },
    })

    await expect(parseJsonBodySafely(request, z.object({ value: z.string() }))).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA_TYPE",
    })
  })

  it("treats an empty body as invalid JSON when a body contract is declared, whatever the content type", async () => {
    const schema = z.object({ value: z.string() })
    const jsonRequest = new Request("https://example.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
    })
    const textRequest = new Request("https://example.test", {
      method: "POST",
      headers: { "content-type": "text/plain" },
    })

    await expect(parseJsonBodySafely(jsonRequest, schema)).rejects.toMatchObject({ code: "INVALID_JSON" })
    await expect(parseJsonBodySafely(textRequest, schema)).rejects.toMatchObject({ code: "INVALID_JSON" })
  })

  it("rejects malformed UTF-8 as invalid JSON even when no body contract is declared", async () => {
    const request = new Request("https://example.test", {
      method: "DELETE",
      body: new Uint8Array([0xc3, 0x28]),
      headers: { "content-type": "application/json" },
    })

    await expect(parseJsonBodySafely(request)).rejects.toMatchObject({
      code: "INVALID_JSON",
    })
  })

  it("does not trust forwarded headers and bounds request metadata", () => {
    const request = new Request("https://example.test", {
      headers: {
        "x-forwarded-for": "198.51.100.20",
        "x-request-id": ` ${"r".repeat(300)} `,
        "user-agent": " browser ",
      },
    })

    const metadata = resolveRequestMetadata(request)
    expect(metadata.requestId).toEqual(expect.any(String))
    expect(metadata).toMatchObject({ correlationId: metadata.requestId, ipAddress: "unknown", userAgent: "browser" })
    expect(resolveRequestMetadata(request, () => " 203.0.113.4 ").ipAddress).toBe("203.0.113.4")
  })

  it("requires an authenticated immediate peer for forwarded identity", () => {
    const config = { trustedProxyIps: ["203.0.113.10"], trustedProxyHops: 1 }
    expect(resolveTrustedClientIp(new Request("https://example.test", {
      headers: { "x-forwarded-for": "198.51.100.20, 203.0.113.10" },
    }), config, { peerAddress: "203.0.113.10", trustedProxy: true })).toBe("198.51.100.20")
    expect(resolveTrustedClientIp(new Request("https://example.test", {
      headers: { "x-forwarded-for": "198.51.100.20, 192.0.2.1, 203.0.113.10" },
    }), config, { peerAddress: "203.0.113.10", trustedProxy: true })).toBeNull()
    expect(resolveTrustedClientIp(new Request("https://example.test", {
      headers: { "x-forwarded-for": "198.51.100.20, 192.0.2.1" },
    }), config)).toBeNull()
    expect(resolveTrustedClientIp(new Request("https://example.test", {
      headers: { "x-forwarded-for": "198.51.100.20, 203.0.113.10" },
    }), config, { trustedProxy: true })).toBeNull()
    expect(resolveTrustedClientIp(new Request("https://example.test", {
      headers: { "x-forwarded-for": "198.51.100.20, 203.0.113.10" },
    }), config, { peerAddress: "192.0.2.1", trustedProxy: true })).toBe("192.0.2.1")
  })

  it("resolves multi-hop chains only when the immediate peer matches the chain", () => {
    const config = { trustedProxyIps: ["203.0.113.10", "203.0.113.11"], trustedProxyHops: 2 }
    const request = (value: string) => new Request("https://example.test", { headers: { "x-forwarded-for": value } })

    expect(resolveTrustedClientIp(request("198.51.100.20, 203.0.113.10, 203.0.113.11"), config, { peerAddress: "203.0.113.11", trustedProxy: true })).toBe("198.51.100.20")
    expect(resolveTrustedClientIp(request("198.51.100.20, 203.0.113.10, 203.0.113.11"), config, { peerAddress: "198.51.100.10" })).toBe("198.51.100.10")
  })

  it("preserves direct-client identity without trusting forwarded headers", () => {
    const config = { trustedProxyIps: ["203.0.113.10"], trustedProxyHops: 1 }
    const request = new Request("https://example.test", { headers: { "x-forwarded-for": "198.51.100.20" } })
    expect(resolveTrustedClientIp(request, config, { peerAddress: "192.0.2.1" })).toBe("192.0.2.1")
  })

  it("maps an oversized write body to 413", async () => {
    const execute = vi.fn()
    const resolveClientIp = vi.fn(() => "198.51.100.20")
    const resolveHttpMetadata = vi.fn(() => ({ peerAddress: "203.0.113.10" }))
    const deps: FrameworkAdapterDeps = {
      resolveClientIp,
      resolveHttpMetadata,
      assertValidCsrf: vi.fn(),
      resolveAbacBundle: vi.fn(async () => null),
    }
    const handler = createFrameworkWriteHandler({
      adapterDeps: deps,
      requestNormalization: canonicalRequestNormalization(undefined, "test.module"),
      scope: { scope: "platform" },
      moduleKey: "test.module",
      action: "create",
      validation: { body: z.object({ value: z.string() }), bodyMaxBytes: 4 },
      skipCapabilityCheck: true,
      createPersistence: () => persistence,
      definition: { key: "test.module.create", execute } as never,
      resolveInput: vi.fn(async () => ({})),
    })

    const response = await handler(new Request("https://example.test", {
      method: "POST",
      body: JSON.stringify({ value: "too large" }),
    }))

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: "Request body is too large", code: "REQUEST_BODY_TOO_LARGE" })
    expect(execute).not.toHaveBeenCalled()
    expect(resolveHttpMetadata).toHaveBeenCalledWith(expect.any(Request))
    expect(resolveClientIp).toHaveBeenCalledWith(expect.any(Request), { peerAddress: "203.0.113.10" })
  })

  it("maps an oversized schema-less write body to 413", async () => {
    const execute = vi.fn()
    const deps: FrameworkAdapterDeps = {
      assertValidCsrf: vi.fn(),
      resolveAbacBundle: vi.fn(async () => null),
    }
    const handler = createFrameworkWriteHandler({
      adapterDeps: deps,
      requestNormalization: canonicalRequestNormalization(undefined, "test.module"),
      scope: { scope: "platform" },
      moduleKey: "test.module",
      action: "delete",
      validation: { bodyMaxBytes: 4 },
      skipCapabilityCheck: true,
      createPersistence: () => persistence,
      definition: { key: "test.module.create", execute } as never,
      resolveInput: vi.fn(async () => ({})),
    })

    const response = await handler(new Request("https://example.test", {
      method: "DELETE",
      body: "12345",
    }))

    expect(response.status).toBe(413)
    expect(execute).not.toHaveBeenCalled()
  })

  it("answers a DELETE with a body with BODY_NOT_ACCEPTED before the CSRF and authorization checks", async () => {
    const execute = vi.fn()
    const assertValidCsrf = vi.fn()
    const deps: FrameworkAdapterDeps = {
      assertValidCsrf,
      resolveAbacBundle: vi.fn(async () => null),
    }
    const handler = createFrameworkWriteHandler({
      adapterDeps: deps,
      requestNormalization: canonicalRequestNormalization(undefined, "test.module"),
      scope: { scope: "platform" },
      moduleKey: "test.module",
      action: "delete",
      validation: { params: z.object({ id: z.string() }) },
      skipCapabilityCheck: true,
      createPersistence: () => persistence,
      definition: { key: "test.module.delete", execute } as never,
      resolveInput: vi.fn(async () => ({})),
    })

    const response = await handler(new Request("https://example.test", {
      method: "DELETE",
      body: "{}",
      headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ id: "1" }) })

    expect(response.status).toBe(415)
    expect(await response.json()).toEqual({ error: "This operation does not accept a request body", code: "BODY_NOT_ACCEPTED" })
    expect(assertValidCsrf).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it("answers a create with a declared body contract and no body with INVALID_JSON", async () => {
    const execute = vi.fn()
    const deps: FrameworkAdapterDeps = {
      assertValidCsrf: vi.fn(),
      resolveAbacBundle: vi.fn(async () => null),
    }
    const handler = createFrameworkWriteHandler({
      adapterDeps: deps,
      requestNormalization: canonicalRequestNormalization(undefined, "test.module"),
      scope: { scope: "platform" },
      moduleKey: "test.module",
      action: "create",
      validation: { body: z.object({ value: z.string() }) },
      skipCapabilityCheck: true,
      createPersistence: () => persistence,
      definition: { key: "test.module.create", execute } as never,
      resolveInput: vi.fn(async () => ({})),
    })

    const response = await handler(new Request("https://example.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "Invalid JSON body", code: "INVALID_JSON" })
    expect(execute).not.toHaveBeenCalled()
  })
})
