import { describe, expect, it } from "vitest"
import express from "express"
import supertest from "supertest"
import type { HttpCrudHandlers } from "../../http/frameworkAdapter"
import { createExpressCrudRouter, createExpressHandler } from ".."

const origin = "https://api.example.test"

describe("createExpressHandler", () => {
  it("cancels the response body of a HEAD request instead of streaming it, but streams it for GET", async () => {
    let cancelled = 0
    const handler = () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode("payload")) },
      cancel() { cancelled += 1 },
    }), { status: 200 })
    const app = express()
    app.get("/", createExpressHandler(handler, { origin }))
    const head = await supertest(app).head("/")
    expect(head.status).toBe(200)
    expect(cancelled).toBe(1)
  })

  it("streams the body for GET without cancelling it", async () => {
    let cancelled = 0
    const handler = () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode("payload")); c.close() },
      cancel() { cancelled += 1 },
    }))
    const app = express()
    app.get("/", createExpressHandler(handler, { origin }))
    const res = await supertest(app).get("/")
    expect(res.text).toBe("payload")
    expect(cancelled).toBe(0)
  })
})

describe("createExpressCrudRouter", () => {
  it("merges the parent route parameters into the handler's params", async () => {
    const seen: Array<Record<string, string>> = []
    const echo = () => new Response("ok")
    const handlers: HttpCrudHandlers = {
      list: echo, create: echo, update: echo, delete: echo,
      detail: (_request, params) => { seen.push(params); return new Response("detail") },
    }
    const app = express()
    app.use("/orgs/:orgId/people", createExpressCrudRouter(handlers, { origin }))
    const res = await supertest(app).get("/orgs/acme/people/7")
    expect(res.text).toBe("detail")
    expect(seen).toEqual([{ orgId: "acme", id: "7" }])
  })

  it("routes each CRUD method to its own handler", async () => {
    const tag = (name: string) => () => new Response(name)
    const handlers: HttpCrudHandlers = { list: tag("list"), detail: () => new Response("detail"), create: tag("create"), update: tag("update"), delete: tag("delete") }
    const app = express()
    app.use("/p", createExpressCrudRouter(handlers, { origin }))
    const client = supertest(app)
    expect((await client.get("/p")).text).toBe("list")
    expect((await client.get("/p/1")).text).toBe("detail")
    expect((await client.post("/p")).text).toBe("create")
    expect((await client.patch("/p/1")).text).toBe("update")
    expect((await client.delete("/p/1")).text).toBe("delete")
    expect((await client.put("/p/1")).status).toBe(404)
  })
})
