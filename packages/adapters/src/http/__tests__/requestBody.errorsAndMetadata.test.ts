import { afterEach, describe, expect, it, vi } from "vitest"
import { ValidationError } from "@xonava/core/domain"
import {
  DEFAULT_MAX_QUERY_PARAMETER_BYTES,
  InvalidJsonError,
  RequestBodyNotAcceptedError,
  RequestBodyTooLargeError,
  UnsupportedMediaTypeError,
  parseJsonBodySafely,
  parseUniqueQueryParameters,
  resolveRequestMetadata,
} from "../requestBody"

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

const schema = { parse: (value: unknown) => value, parseAsync: async (value: unknown) => value }
const post = (body: BodyInit | null, headers: Record<string, string> = { "content-type": "application/json" }) => new Request("https://example.test/x", { method: "POST", body, headers })

describe("body errors", () => {
  it.each([
    [new InvalidJsonError(), "INVALID_JSON", "Invalid JSON body", "InvalidJsonError"],
    [new RequestBodyTooLargeError(5), "REQUEST_BODY_TOO_LARGE", "Request body is too large", "RequestBodyTooLargeError"],
    [new UnsupportedMediaTypeError(), "UNSUPPORTED_MEDIA_TYPE", "Request content type must be JSON encoded as UTF-8", "UnsupportedMediaTypeError"],
    [new RequestBodyNotAcceptedError(), "BODY_NOT_ACCEPTED", "This operation does not accept a request body", "RequestBodyNotAcceptedError"],
  ])("describes %s", (error, code, message, name) => {
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe(code)
    expect(error.message).toBe(message)
    expect(error.name).toBe(name)
  })

  it("remembers the limit that was exceeded", () => {
    expect(new RequestBodyTooLargeError(1234).maxBytes).toBe(1234)
  })
})

describe("content type", () => {
  const accepts = async (contentType: string | null) => {
    const headers: Record<string, string> = contentType === null ? {} : { "content-type": contentType }
    return parseJsonBodySafely(post('{"a":1}', headers), schema)
  }

  it.each([
    "application/json",
    "Application/JSON",
    "application/json; charset=utf-8",
    "application/json; charset=UTF-8",
    "application/json ; charset=utf-8",
    "application/vnd.api+json",
    "application/vnd.api+json; charset=utf-8",
    "application/json; boundary=x",
    "application/json; charset=",
    "application/json; foo=bar; charset=utf-8",
    "application/a+json",
  ])("accepts %s", async (contentType) => {
    expect(await accepts(contentType)).toEqual({ a: 1 })
  })

  it.each([
    "text/plain",
    "application/xml",
    "application/jsonx",
    "xapplication/json",
    "application/+json",
    "application/vnd+jsonx",
    "xapplication/vnd+json",
    "application/vnd +json",
    "application/json; charset=latin1",
    "application/json; charset=utf-16",
    "application/json; foo=bar; charset=latin1",
    "",
  ])("rejects %j", async (contentType) => {
    const headers: Record<string, string> = contentType === "" ? {} : { "content-type": contentType }
    await expect(parseJsonBodySafely(post('{"a":1}', headers), schema)).rejects.toBeInstanceOf(UnsupportedMediaTypeError)
  })

  it("does not check the content type of an empty body", async () => {
    expect(await parseJsonBodySafely(new Request("https://example.test/x"), undefined)).toBeUndefined()
  })
})

describe("body reading", () => {
  it("returns nothing without a schema when there is no body, and refuses a body when there is no schema", async () => {
    expect(await parseJsonBodySafely(new Request("https://example.test/x", { method: "POST" }))).toBeUndefined()
    await expect(parseJsonBodySafely(post('{"a":1}'))).rejects.toBeInstanceOf(RequestBodyNotAcceptedError)
  })

  it("requires valid JSON when a schema applies", async () => {
    await expect(parseJsonBodySafely(new Request("https://example.test/x", { method: "POST" }), schema)).rejects.toBeInstanceOf(InvalidJsonError)
    await expect(parseJsonBodySafely(post("{bad"), schema)).rejects.toBeInstanceOf(InvalidJsonError)
    await expect(parseJsonBodySafely(post(new Uint8Array([0x7b, 0xff, 0x7d])), schema)).rejects.toBeInstanceOf(InvalidJsonError)
  })

  it("hands the parsed JSON to the schema and returns what it produced", async () => {
    const parseAsync = vi.fn(async (value: unknown) => ({ parsed: value }))
    expect(await parseJsonBodySafely(post('{"a":1}'), { parse: vi.fn(), parseAsync })).toEqual({ parsed: { a: 1 } })
    expect(parseAsync).toHaveBeenCalledWith({ a: 1 })
    await expect(parseJsonBodySafely(post("{}"), { parse: vi.fn(), parseAsync: async () => { throw new Error("schema") } })).rejects.toThrow("schema")
  })

  it("joins a body that arrives in several chunks", async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const part of ['{"a":', '1,"bb":', '"xyz"}']) controller.enqueue(encoder.encode(part)); controller.close() } })
    const request = new Request("https://example.test/x", { method: "POST", body: stream, headers: { "content-type": "application/json" }, duplex: "half" } as RequestInit)
    expect(await parseJsonBodySafely(request, schema)).toEqual({ a: 1, bb: "xyz" })
  })

  it("accepts a body of exactly the limit and refuses one byte more", async () => {
    const body = '{"a":"bcd"}'
    expect(await parseJsonBodySafely(post(body), schema, body.length)).toEqual({ a: "bcd" })
    await expect(parseJsonBodySafely(post(body), schema, body.length - 1)).rejects.toEqual(new RequestBodyTooLargeError(body.length - 1))
  })

  it("refuses a body whose declared length exceeds the limit before reading it", async () => {
    const clone = vi.fn(() => ({ body: null }))
    const request = { headers: new Headers({ "content-length": "11" }), clone } as unknown as Request
    await expect(parseJsonBodySafely(request, schema, 10)).rejects.toEqual(new RequestBodyTooLargeError(10))
    expect(clone).not.toHaveBeenCalled()
    const exact = { headers: new Headers({ "content-length": "10" }), clone: () => ({ body: null }) } as unknown as Request
    await expect(parseJsonBodySafely(exact, schema, 10)).rejects.toBeInstanceOf(InvalidJsonError)
    for (const declared of ["abc", "", "-"]) {
      const lenient = { headers: new Headers({ "content-length": declared }), clone: () => ({ body: null }) } as unknown as Request
      await expect(parseJsonBodySafely(lenient, schema, 10)).rejects.toBeInstanceOf(InvalidJsonError)
    }
  })

  it("releases the stream reader after reading and after a failure", async () => {
    const encoder = new TextEncoder()
    const make = (chunks: string[]) => new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close() } })
    const done = make(['{"a":1}'])
    const okRequest = { headers: new Headers({ "content-type": "application/json" }), clone: () => ({ body: done }) } as unknown as Request
    expect(await parseJsonBodySafely(okRequest, schema)).toEqual({ a: 1 })
    expect(done.locked).toBe(false)
    const big = make(["0123456789", "0123456789"])
    const bigRequest = { headers: new Headers({ "content-type": "application/json" }), clone: () => ({ body: big }) } as unknown as Request
    await expect(parseJsonBodySafely(bigRequest, schema, 15)).rejects.toBeInstanceOf(RequestBodyTooLargeError)
    expect(big.locked).toBe(false)
  })
})

describe("request metadata", () => {
  const request = (headers: Record<string, string> = {}) => new Request("https://example.test/x", { headers })

  it("generates a request id and defaults the rest", () => {
    const metadata = resolveRequestMetadata(request())
    expect(metadata.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(metadata).toEqual({ requestId: metadata.requestId, correlationId: metadata.requestId, ipAddress: "unknown", userAgent: null })
  })

  it("falls back to a time-based id when UUID generation is unavailable", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"))
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => { throw new Error("no uuid") })
    const { requestId } = resolveRequestMetadata(request())
    expect(requestId.startsWith(`req-${Date.now().toString(36)}-`)).toBe(true)
    expect(requestId).toMatch(/^req-[0-9a-z]+-[0-9a-z]+$/)
  })

  it("takes bounded, trimmed correlation id and user agent from the headers", () => {
    const metadata = resolveRequestMetadata(request({ "x-correlation-id": " corr-1 ", "user-agent": " agent/1 " }))
    expect(metadata.correlationId).toBe("corr-1")
    expect(metadata.userAgent).toBe("agent/1")
    const long = resolveRequestMetadata(request({ "x-correlation-id": "c".repeat(300), "user-agent": "u".repeat(600) }))
    expect(long.correlationId).toBe("c".repeat(256))
    expect(long.userAgent).toBe("u".repeat(512))
    const exact = resolveRequestMetadata(request({ "x-correlation-id": "c".repeat(256), "user-agent": "u".repeat(512) }))
    expect(exact.correlationId).toBe("c".repeat(256))
    expect(exact.userAgent).toBe("u".repeat(512))
  })

  it("falls back for blank correlation ids and user agents", () => {
    const metadata = resolveRequestMetadata(request({ "x-correlation-id": " ", "user-agent": " " }))
    expect(metadata.correlationId).toBe(metadata.requestId)
    expect(metadata.userAgent).toBeNull()
  })

  it("uses the trusted client address, trimmed and bounded, or unknown", () => {
    const seen: unknown[] = []
    const resolve = (req: Request, meta?: unknown) => { seen.push([req, meta]); return "  1.2.3.4  " }
    const req = request()
    expect(resolveRequestMetadata(req, resolve, { peerAddress: "9.9.9.9" }).ipAddress).toBe("1.2.3.4")
    expect(seen[0]).toEqual([req, { peerAddress: "9.9.9.9" }])
    expect(resolveRequestMetadata(request(), () => "i".repeat(300)).ipAddress).toBe("i".repeat(256))
    for (const answer of [null, undefined, "", "   "]) expect(resolveRequestMetadata(request(), () => answer).ipAddress).toBe("unknown")
  })
})

describe("unique query parameters", () => {
  it("returns a prototype-free record of the parameters", () => {
    const query = parseUniqueQueryParameters(new Request("https://example.test/x?a=1&b=two&c="))
    expect(query).toEqual({ a: "1", b: "two", c: "" })
    expect(Object.getPrototypeOf(query)).toBeNull()
    expect(Object.keys(parseUniqueQueryParameters(new Request("https://example.test/x")))).toEqual([])
  })

  it("treats prototype member names as ordinary parameters", () => {
    const query = parseUniqueQueryParameters(new Request("https://example.test/x?__proto__=1&constructor=2&toString=3"))
    expect(Object.keys(query).sort()).toEqual(["__proto__", "constructor", "toString"])
    expect(Object.getPrototypeOf(query)).toBeNull()
  })

  it("refuses a repeated parameter", () => {
    expect(() => parseUniqueQueryParameters(new Request("https://example.test/x?a=1&a=2"))).toThrow(new ValidationError("Duplicate query parameter: a"))
    expect(() => parseUniqueQueryParameters(new Request("https://example.test/x?a=1&b=2&b="))).toThrow(new ValidationError("Duplicate query parameter: b"))
  })

  it("bounds each value in UTF-8 bytes", () => {
    const exact = "a".repeat(DEFAULT_MAX_QUERY_PARAMETER_BYTES)
    expect(parseUniqueQueryParameters(new Request(`https://example.test/x?q=${exact}`)).q).toBe(exact)
    expect(() => parseUniqueQueryParameters(new Request(`https://example.test/x?q=${exact}a`))).toThrow(new ValidationError(`Query parameter "q" exceeds the maximum of ${DEFAULT_MAX_QUERY_PARAMETER_BYTES} UTF-8 bytes`))
    const wide = encodeURIComponent("é".repeat(DEFAULT_MAX_QUERY_PARAMETER_BYTES / 2 + 1))
    expect(() => parseUniqueQueryParameters(new Request(`https://example.test/x?w=${wide}`))).toThrow(new ValidationError(`Query parameter "w" exceeds the maximum of ${DEFAULT_MAX_QUERY_PARAMETER_BYTES} UTF-8 bytes`))
    expect(DEFAULT_MAX_QUERY_PARAMETER_BYTES).toBe(64 * 1024)
  })
})
