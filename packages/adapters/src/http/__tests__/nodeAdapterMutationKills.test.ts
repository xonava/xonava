import { EventEmitter } from "node:events"
import type { IncomingMessage, ServerResponse } from "node:http"
import { describe, expect, it, vi } from "vitest"
import { ConfigurationError, ValidationError } from "@xonava/core/domain"
import { resolveAdapterHttpMetadata } from "../frameworkAdapter"
import { nodeAbortSignal, nodeRequest, readNodeBody, responseHeaders, validateNodeOptions } from "../nodeAdapter"
import { DEFAULT_MAX_JSON_BODY_BYTES, RequestBodyTooLargeError } from "../requestBody"

class FakeRequest extends EventEmitter {
  headers: Record<string, string | undefined> = {}
  rawHeaders: string[] = []
  method: string | undefined = "POST"
  readableEnded = false
  destroyed = false
  aborted = false
  resume = vi.fn()
  socket = Object.assign(new EventEmitter(), { remoteAddress: "10.1.2.3" as string | undefined })
}

class FakeResponse extends EventEmitter {
  writableFinished = false
  destroyed = false
}

const asRequest = (request: FakeRequest) => request as unknown as IncomingMessage
const asResponse = (response: FakeResponse) => response as unknown as ServerResponse
const listenerTotal = (emitter: EventEmitter) => ["data", "end", "error", "aborted", "close"].reduce((total, event) => total + emitter.listenerCount(event), 0)

describe("node adapter options", () => {
  it("normalizes a plain HTTP(S) origin and defaults the body limit", () => {
    expect(validateNodeOptions({ origin: "https://Example.com" })).toEqual({ origin: "https://example.com", maxBodyBytes: DEFAULT_MAX_JSON_BODY_BYTES })
    expect(validateNodeOptions({ origin: "http://localhost:3000/", maxBodyBytes: 10 })).toEqual({ origin: "http://localhost:3000", maxBodyBytes: 10 })
  })

  it.each([
    "ftp://example.com",
    "file:///tmp",
    "https://user@example.com",
    "https://user:pass@example.com",
    "https://:pass@example.com",
    "https://example.com/path",
    "https://example.com/?q=1",
    "https://example.com/#frag",
  ])("refuses the origin %s", (origin) => {
    expect(() => validateNodeOptions({ origin })).toThrow(new ConfigurationError("HTTP adapter origin must be an HTTP(S) origin without credentials, path, query, or fragment"))
  })

  it("accepts a zero body limit and refuses negative or non-integer ones", () => {
    expect(validateNodeOptions({ origin: "https://example.com", maxBodyBytes: 0 }).maxBodyBytes).toBe(0)
    for (const maxBodyBytes of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => validateNodeOptions({ origin: "https://example.com", maxBodyBytes })).toThrow(new ConfigurationError("maxBodyBytes must be a non-negative safe integer"))
    }
  })
})

describe("node request body", () => {
  it("returns an already read raw body, within the limit", async () => {
    const body = Buffer.from("abc")
    expect(await readNodeBody(asRequest(new FakeRequest()), body, 3)).toBe(body)
    await expect(readNodeBody(asRequest(new FakeRequest()), body, 2)).rejects.toEqual(new RequestBodyTooLargeError(2))
    await expect(readNodeBody(asRequest(new FakeRequest()), new Uint8Array(0), 0)).resolves.toBeInstanceOf(Uint8Array)
  })

  it("refuses a body that a parser already turned into something else", async () => {
    for (const parsed of ["text", { a: 1 }, 5, null, [1, 2]]) {
      await expect(readNodeBody(asRequest(new FakeRequest()), parsed, 10)).rejects.toEqual(new ConfigurationError("HTTP adapters require an unparsed body or a raw Buffer; mount before JSON/text body parsers"))
    }
  })

  describe("when the stream already ended", () => {
    const ended = (headers: Record<string, string | undefined>) => Object.assign(new FakeRequest(), { readableEnded: true, headers })
    it("treats a request that never had a body as empty", async () => {
      expect(await readNodeBody(asRequest(ended({})), undefined, 10)).toBeUndefined()
      expect(await readNodeBody(asRequest(ended({ "content-length": "0" })), undefined, 10)).toBeUndefined()
    })
    it("refuses a request whose body was consumed", async () => {
      const message = "HTTP request body was consumed before the adapter"
      await expect(readNodeBody(asRequest(ended({ "content-length": "5" })), undefined, 10)).rejects.toEqual(new ConfigurationError(message))
      await expect(readNodeBody(asRequest(ended({ "content-length": "1" })), undefined, 10)).rejects.toEqual(new ConfigurationError(message))
      await expect(readNodeBody(asRequest(ended({ "transfer-encoding": "chunked" })), undefined, 10)).rejects.toEqual(new ConfigurationError(message))
    })
  })

  it("refuses a destroyed request", async () => {
    await expect(readNodeBody(asRequest(Object.assign(new FakeRequest(), { destroyed: true })), undefined, 10)).rejects.toEqual(new Error("HTTP request aborted"))
  })

  it("collects the chunks until the end and removes its listeners", async () => {
    const request = new FakeRequest()
    const pending = readNodeBody(asRequest(request), undefined, 10)
    expect([request.listenerCount("data"), request.listenerCount("end"), request.listenerCount("error"), request.listenerCount("aborted")]).toEqual([1, 1, 1, 1])
    request.emit("data", Buffer.from("ab"))
    request.emit("data", Buffer.from("cde"))
    request.emit("end")
    const body = await pending
    expect(Buffer.from(body ?? new Uint8Array()).toString()).toBe("abcde")
    expect(listenerTotal(request)).toBe(0)
  })

  it("returns nothing for an empty stream", async () => {
    const request = new FakeRequest()
    const pending = readNodeBody(asRequest(request), undefined, 10)
    request.emit("end")
    expect(await pending).toBeUndefined()
    expect(listenerTotal(request)).toBe(0)
  })

  it("accepts a body of exactly the limit and refuses one byte more, draining the rest", async () => {
    const exact = new FakeRequest()
    const accepted = readNodeBody(asRequest(exact), undefined, 5)
    exact.emit("data", Buffer.from("abcde"))
    exact.emit("end")
    expect(Buffer.from((await accepted) ?? new Uint8Array()).toString()).toBe("abcde")

    const over = new FakeRequest()
    const rejected = readNodeBody(asRequest(over), undefined, 5)
    over.emit("data", Buffer.from("abc"))
    over.emit("data", Buffer.from("def"))
    await expect(rejected).rejects.toEqual(new RequestBodyTooLargeError(5))
    expect(over.resume).toHaveBeenCalledOnce()
    expect(listenerTotal(over)).toBe(0)
    const kept = new FakeRequest()
    const small = readNodeBody(asRequest(kept), undefined, 5)
    kept.emit("data", Buffer.from("abc"))
    kept.emit("end")
    await small
    expect(kept.resume).not.toHaveBeenCalled()
  })

  it("rejects with a stream error and removes its listeners", async () => {
    const request = new FakeRequest()
    const pending = readNodeBody(asRequest(request), undefined, 10)
    const failure = new Error("socket reset")
    request.emit("error", failure)
    await expect(pending).rejects.toBe(failure)
    expect(listenerTotal(request)).toBe(0)
  })

  it("rejects when the client aborts and removes its listeners", async () => {
    const request = new FakeRequest()
    const pending = readNodeBody(asRequest(request), undefined, 10)
    request.emit("aborted")
    await expect(pending).rejects.toEqual(new Error("HTTP request aborted"))
    expect(listenerTotal(request)).toBe(0)
  })
})

describe("node abort signal", () => {
  const setup = (over: Partial<FakeRequest> = {}, responseOver: Partial<FakeResponse> = {}) => {
    const request = Object.assign(new FakeRequest(), over)
    const response = Object.assign(new FakeResponse(), responseOver)
    const abort = nodeAbortSignal(asRequest(request), asResponse(response))
    return { request, response, ...abort }
  }

  it("starts live and listens on the request, the response and the socket", () => {
    const { signal, request, response } = setup()
    expect(signal.aborted).toBe(false)
    expect(request.listenerCount("aborted")).toBe(1)
    expect(response.listenerCount("close")).toBe(1)
    expect(request.socket.listenerCount("close")).toBe(1)
  })

  it("aborts when the client aborts", () => {
    const { signal, request } = setup()
    request.emit("aborted")
    expect(signal.aborted).toBe(true)
  })

  it("aborts when the response or socket closes before it finished, and not after", () => {
    const early = setup()
    early.response.emit("close")
    expect(early.signal.aborted).toBe(true)
    const viaSocket = setup()
    viaSocket.request.socket.emit("close")
    expect(viaSocket.signal.aborted).toBe(true)
    const finished = setup({}, { writableFinished: true })
    finished.response.emit("close")
    finished.request.socket.emit("close")
    expect(finished.signal.aborted).toBe(false)
  })

  it("is aborted at once when the request was aborted or the response destroyed", () => {
    expect(setup({ aborted: true }).signal.aborted).toBe(true)
    expect(setup({}, { destroyed: true }).signal.aborted).toBe(true)
    expect(setup({ aborted: false }, { destroyed: false }).signal.aborted).toBe(false)
  })

  it("stops listening on cleanup", () => {
    const { cleanup, request, response, signal } = setup()
    cleanup()
    expect(request.listenerCount("aborted")).toBe(0)
    expect(response.listenerCount("close")).toBe(0)
    expect(request.socket.listenerCount("close")).toBe(0)
    request.emit("aborted")
    response.emit("close")
    expect(signal.aborted).toBe(false)
  })
})

describe("node response headers", () => {
  it("drops hop-by-hop headers", () => {
    const headers = new Headers({ "content-type": "text/plain", "x-keep": "1" })
    for (const name of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]) headers.set(name, "x")
    expect(responseHeaders(headers)).toEqual([["content-type", "text/plain"], ["x-keep", "1"]])
  })

  it("drops the headers that the Connection header names, trimmed and case-insensitively", () => {
    const headers = new Headers({ connection: " X-Custom , Keep-Alive ", "x-custom": "1", "x-other": "2" })
    expect(responseHeaders(headers)).toEqual([["x-other", "2"]])
    const exact = new Headers({ connection: "x-custom", "x-custom": "1", "x-custom-2": "2" })
    expect(responseHeaders(exact)).toEqual([["x-custom-2", "2"]])
  })

  it("returns an empty list for no headers", () => {
    expect(responseHeaders(new Headers())).toEqual([])
  })

  it("lists the cookies as one array entry after the other headers", () => {
    const headers = new Headers({ "content-type": "text/plain" })
    headers.append("set-cookie", "a=1")
    headers.append("set-cookie", "b=2")
    headers.append("x-last", "z")
    expect(responseHeaders(headers)).toEqual([["content-type", "text/plain"], ["x-last", "z"], ["set-cookie", ["a=1", "b=2"]]])
  })

  it("adds no cookie entry when there are none, or when the Connection header excludes them", () => {
    expect(responseHeaders(new Headers({ a: "1" }))).toEqual([["a", "1"]])
    const headers = new Headers({ connection: "Set-Cookie" })
    headers.append("set-cookie", "a=1")
    expect(responseHeaders(headers)).toEqual([])
  })
})

describe("node request construction", () => {
  const raw = (over: Partial<FakeRequest> = {}) => Object.assign(new FakeRequest(), { rawHeaders: ["Host", "evil.example", "X-One", "1", "X-One", "2"], ...over })

  it("refuses targets that are not origin-relative", () => {
    const expected = new ValidationError("Expected an origin-relative HTTP request target")
    for (const target of ["http://evil.example/x", "x", "", "/path#fragment", "#"]) {
      expect(() => nodeRequest(asRequest(raw()), target, "https://api.example.com", undefined, new AbortController().signal)).toThrow(expected)
    }
  })

  it("builds the request on the configured origin, keeping a leading double slash in the path", () => {
    const request = nodeRequest(asRequest(raw({ method: "GET" })), "//evil.example/x?y=1", "https://api.example.com", undefined, new AbortController().signal)
    expect(request.url).toBe("https://api.example.com//evil.example/x?y=1")
    expect(request.method).toBe("GET")
  })

  it("copies every raw header pair, including repeated ones, and nothing else", () => {
    const request = nodeRequest(asRequest(raw({ method: "GET" })), "/x", "https://api.example.com", undefined, new AbortController().signal)
    expect([...request.headers.entries()]).toEqual([["host", "evil.example"], ["x-one", "1, 2"]])
    const empty = nodeRequest(asRequest(raw({ method: "GET", rawHeaders: [] })), "/x", "https://api.example.com", undefined, new AbortController().signal)
    expect([...empty.headers.entries()]).toEqual([])
  })

  it("defaults the method to GET", () => {
    const request = nodeRequest(asRequest(raw({ method: undefined })), "/x", "https://api.example.com", undefined, new AbortController().signal)
    expect(request.method).toBe("GET")
  })

  it("passes a copy of the body to non-GET requests", async () => {
    const body = Buffer.from("payload")
    const request = nodeRequest(asRequest(raw({ method: "POST" })), "/x", "https://api.example.com", body, new AbortController().signal)
    expect(await request.text()).toBe("payload")
    const put = nodeRequest(asRequest(raw({ method: "PUT" })), "/x", "https://api.example.com", body, new AbortController().signal)
    expect(await put.text()).toBe("payload")
  })

  it("never attaches a body to GET or HEAD requests, or an empty body to others", async () => {
    for (const method of ["GET", "HEAD"]) {
      const request = nodeRequest(asRequest(raw({ method })), "/x", "https://api.example.com", Buffer.from("payload"), new AbortController().signal)
      expect(request.body).toBeNull()
    }
    const empty = nodeRequest(asRequest(raw({ method: "POST" })), "/x", "https://api.example.com", new Uint8Array(0), new AbortController().signal)
    expect(empty.body).toBeNull()
    const none = nodeRequest(asRequest(raw({ method: "POST" })), "/x", "https://api.example.com", undefined, new AbortController().signal)
    expect(none.body).toBeNull()
  })

  it("carries the abort signal and records the transport peer", () => {
    const controller = new AbortController()
    const request = nodeRequest(asRequest(raw()), "/x", "https://api.example.com", undefined, controller.signal)
    controller.abort()
    expect(request.signal.aborted).toBe(true)
    expect(resolveAdapterHttpMetadata(request)).toEqual({ peerAddress: "10.1.2.3" })
    const noPeer = nodeRequest(asRequest(Object.assign(raw(), { socket: Object.assign(new EventEmitter(), { remoteAddress: undefined }) })), "/x", "https://api.example.com", undefined, new AbortController().signal)
    expect(resolveAdapterHttpMetadata(noPeer)).toEqual({ peerAddress: null })
    expect(Object.isFrozen(resolveAdapterHttpMetadata(request))).toBe(true)
  })
})
