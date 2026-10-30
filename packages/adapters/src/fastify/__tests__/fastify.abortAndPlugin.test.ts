import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it } from "vitest"
import Fastify from "fastify"
import type { HttpCrudHandlers } from "../../http/frameworkAdapter"
import { createFastifyHandler, fastifyCrudPlugin } from ".."

const origin = "https://api.example.test"
const invoke = (handler: ReturnType<typeof createFastifyHandler>, f: { request: unknown; reply: unknown }) => (handler as unknown as (request: never, reply: never) => Promise<unknown>)(f.request as never, f.reply as never)
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

function fakes(url: string | null = "/x") {
  const socket = new EventEmitter()
  const raw = Object.assign(new EventEmitter(), { readableEnded: true, destroyed: false, aborted: false, headers: {}, rawHeaders: [] as string[], method: "GET", url: url ?? undefined, socket: Object.assign(socket, { remoteAddress: "1.2.3.4" }) })
  const replyRaw = Object.assign(new EventEmitter(), { destroyed: false, writableFinished: false })
  const sent: unknown[] = []
  const reply = { raw: replyRaw, code: (c: number) => { sent.push(["code", c]); return reply }, header: () => reply, send: (payload?: unknown) => { sent.push(["send", payload]); return reply } }
  const request = { raw, body: undefined, method: "GET", params: undefined }
  return { raw, socket, replyRaw, reply, request, sent }
}

describe("createFastifyHandler abort bookkeeping", () => {
  it("releases the abort listeners when the response finishes", async () => {
    const f = fakes()
    await invoke(createFastifyHandler(() => new Response("ok"), { origin }), f)
    expect(f.raw.listenerCount("aborted")).toBe(1)
    f.replyRaw.emit("finish")
    expect(f.raw.listenerCount("aborted")).toBe(0)
    expect(f.replyRaw.listenerCount("close")).toBe(1)
    expect(f.socket.listenerCount("close")).toBe(0)
  })

  it("releases the abort listeners when the connection closes", async () => {
    const f = fakes()
    await invoke(createFastifyHandler(() => new Response("ok"), { origin }), f)
    f.replyRaw.emit("close")
    expect(f.raw.listenerCount("aborted")).toBe(0)
    expect(f.replyRaw.listenerCount("finish")).toBe(1)
    expect(f.socket.listenerCount("close")).toBe(0)
  })

  it("falls back to the root target when the raw request has no url", async () => {
    const f = fakes(null)
    let seen = ""
    await invoke(createFastifyHandler(req => { seen = req.url; return new Response("ok") }, { origin }), f)
    expect(seen).toBe(`${origin}/`)
    expect(f.sent[0]).toEqual(["code", 200])
  })
})

describe("fastifyCrudPlugin", () => {
  const handlers = (): HttpCrudHandlers => {
    const echo = async (req: Request) => new Response(`${req.method}:${req.headers.get("content-type")}:${await req.text()}`)
    return { list: echo, detail: echo, create: echo, update: echo, delete: echo }
  }
  async function build(maxBodyBytes?: number) {
    const app = Fastify()
    cleanup.push(() => app.close())
    await app.register(fastifyCrudPlugin, { origin, prefix: "/people", handlers: handlers(), ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }) })
    await app.ready()
    return app
  }

  it("answers an oversized body with the framework's 413 REQUEST_BODY_TOO_LARGE", async () => {
    const app = await build(4)
    const res = await app.inject({ method: "POST", url: "/people/", payload: "12345", headers: { "content-type": "text/plain" } })
    expect(res.statusCode).toBe(413)
    expect(JSON.stringify(res.json())).toContain("REQUEST_BODY_TOO_LARGE")
    expect(res.headers["content-type"]).toContain("application/json")
    const ok = await app.inject({ method: "POST", url: "/people/", payload: "1234", headers: { "content-type": "text/plain" } })
    expect(ok.statusCode).toBe(200)
    expect(ok.body).toBe("POST:text/plain:1234")
  })

  it("leaves other Fastify errors to Fastify's own reply", async () => {
    const app = await build()
    const res = await app.inject({ method: "POST", url: "/people/", payload: "abc", headers: { "content-type": "text/plain", "content-length": "10" } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe("FST_ERR_CTP_INVALID_CONTENT_LENGTH")
  })

  it("passes the original content-type and body of non-JSON and JSON requests through untouched", async () => {
    const app = await build()
    const json = await app.inject({ method: "POST", url: "/people/", payload: "{\"a\":1}", headers: { "content-type": "application/json" } })
    expect(json.body).toBe("POST:application/json:{\"a\":1}")
    const none = await app.inject({ method: "GET", url: "/people/" })
    expect(none.body).toBe("GET:null:")
    const bare = await app.inject({ method: "POST", url: "/people/", payload: "raw" })
    expect(bare.statusCode).toBe(200)
  })

  it("rejects an invalid configuration at registration", async () => {
    const app = Fastify()
    cleanup.push(() => app.close())
    await expect(app.register(fastifyCrudPlugin, { origin: "file:///tmp", handlers: handlers() }).ready()).rejects.toThrow()
  })
})
