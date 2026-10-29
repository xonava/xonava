import { describe, expect, it, vi } from "vitest"
import { Hono } from "hono"
import { createHonoHandler } from ".."

describe("createHonoHandler", () => {
  it("answers a framework error response and reports it when resolving request metadata throws", async () => {
    const reportError = vi.fn()
    const handler = vi.fn(() => new Response("must not run"))
    const app = new Hono()
    app.get("/", createHonoHandler(handler, { reportError, resolveHttpMetadata: () => { throw new Error("metadata boom") } }))
    const response = await app.request("/")
    expect(response.status).toBe(500)
    expect(handler).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledOnce()
  })
})
