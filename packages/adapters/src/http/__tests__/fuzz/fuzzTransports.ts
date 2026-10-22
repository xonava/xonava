import http from "node:http"
import type { AddressInfo } from "node:net"
import express from "express"
import Fastify from "fastify"
import { Hono } from "hono"
import { createExpressCrudRouter, createExpressHandler } from "../../../express"
import { createFastifyHandler, fastifyCrudPlugin } from "../../../fastify"
import { createHonoCrudApp, createHonoHandler } from "../../../hono"
import { DEFAULT_MAX_JSON_BODY_BYTES, RequestBodyTooLargeError } from "../../requestBody"
import { responseHeaders } from "../../nodeAdapter"
import { createFrameworkErrorHandler } from "../../handleFrameworkCoreError"
import type { HttpCrudHandlers, HttpHandler } from "../../frameworkAdapter"

export const ORIGIN = "https://api.example.test"
export const BASE_PATH = "/api/people"
export const CUSTOM_PATH = "/api/custom"

export interface FuzzRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE"
  /** Path and query, already percent-encoded (visible ASCII only). */
  target: string
  /** Header lines in order; a repeated name is sent as a repeated header line where the transport allows it. */
  headers: ReadonlyArray<readonly [string, string]>
  body?: Uint8Array
}

export interface FuzzResponse { status: number; text: string; bytes: Uint8Array; headers: Headers }

export interface FuzzTransport {
  readonly name: "express" | "fastify" | "hono"
  send(request: FuzzRequest): Promise<FuzzResponse>
}

function nodeRequest(port: number, request: FuzzRequest): Promise<FuzzResponse> {
  return new Promise((resolve, reject) => {
    const rawHeaders: string[] = []
    for (const [name, value] of request.headers) rawHeaders.push(name, value)
    // A raw header list gets no automatic Host; HTTP/1.1 servers answer 400 without one.
    if (!request.headers.some(([name]) => name.toLowerCase() === "host")) rawHeaders.push("host", `127.0.0.1:${port}`)
    if (request.body !== undefined) rawHeaders.push("content-length", String(request.body.byteLength))
    const outgoing = http.request({ host: "127.0.0.1", port, method: request.method, path: request.target, headers: rawHeaders as unknown as http.OutgoingHttpHeaders, agent: false }, (incoming) => {
      const chunks: Buffer[] = []
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk))
      incoming.on("error", reject)
      incoming.on("end", () => {
        const bytes = new Uint8Array(Buffer.concat(chunks))
        const headers = new Headers()
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!)
        resolve({ status: incoming.statusCode ?? 0, text: new TextDecoder().decode(bytes), bytes, headers })
      })
    })
    outgoing.on("error", reject)
    outgoing.end(request.body === undefined ? undefined : Buffer.from(request.body))
  })
}

export interface FuzzTransports {
  readonly transports: readonly FuzzTransport[]
  close(): Promise<void>
}

export interface TransportMounts {
  crud?: HttpCrudHandlers
  /** A single handler answered at `${CUSTOM_PATH}/:id` for every method. */
  custom?: HttpHandler
  maxBodyBytes?: number
}

/** Express and Fastify on real ephemeral sockets (so raw header lines reach the adapters), Hono through its fetch entry. */
export async function createFuzzTransports(mounts: TransportMounts): Promise<FuzzTransports> {
  const maxBodyBytes = mounts.maxBodyBytes ?? DEFAULT_MAX_JSON_BODY_BYTES
  const closers: Array<() => Promise<unknown>> = []

  const expressApp = express()
  if (mounts.crud) expressApp.use(BASE_PATH, createExpressCrudRouter(mounts.crud, { origin: ORIGIN, maxBodyBytes }))
  if (mounts.custom) {
    const router = express.Router()
    router.all("/:id", createExpressHandler(mounts.custom, { origin: ORIGIN, maxBodyBytes }))
    expressApp.use(CUSTOM_PATH, router)
  }
  const expressServer = http.createServer(expressApp)
  await new Promise<void>((resolve) => expressServer.listen(0, "127.0.0.1", resolve))
  closers.push(() => new Promise((resolve) => { expressServer.closeAllConnections(); expressServer.close(resolve) }))
  const expressPort = (expressServer.address() as AddressInfo).port

  // Fastify's default 100-character route-parameter limit answers its own 414 before any handler runs; raise it above the largest id sent.
  const fastify = Fastify({ routerOptions: { maxParamLength: 20_000 } })
  if (mounts.crud) await fastify.register(fastifyCrudPlugin, { prefix: BASE_PATH, handlers: mounts.crud, origin: ORIGIN, maxBodyBytes })
  if (mounts.custom) {
    await fastify.register(async (scope) => {
      // A standalone route owns its parser setup. This mirrors fastifyCrudPlugin, including the neutral media type.
      scope.addHook("onRequest", async (request) => { if (request.raw.headers["content-type"] !== undefined) request.raw.headers["content-type"] = "application/octet-stream" })
      // ...and its 413 mapping.
      scope.setErrorHandler(async (error, _request, reply) => {
        if ((error as { code?: unknown }).code !== "FST_ERR_CTP_BODY_TOO_LARGE") return reply.send(error)
        const response = createFrameworkErrorHandler({})(new RequestBodyTooLargeError(maxBodyBytes))
        reply.code(response.status)
        for (const [name, value] of responseHeaders(response.headers)) reply.header(name, value)
        return reply.send(await response.text())
      })
      scope.removeAllContentTypeParsers()
      scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: maxBodyBytes }, (_request, body, done) => done(null, body))
      scope.all("/:id", createFastifyHandler(mounts.custom!, { origin: ORIGIN, maxBodyBytes }))
    }, { prefix: CUSTOM_PATH })
  }
  await fastify.listen({ port: 0, host: "127.0.0.1" })
  closers.push(() => fastify.close())
  const fastifyPort = (fastify.server.address() as AddressInfo).port

  const hono = new Hono()
  if (mounts.crud) hono.route(BASE_PATH, createHonoCrudApp(mounts.crud))
  if (mounts.custom) hono.all(`${CUSTOM_PATH}/:id`, createHonoHandler(mounts.custom, { resolveHttpMetadata: () => ({ peerAddress: "127.0.0.1" }) }))

  const transports: FuzzTransport[] = [
    { name: "express", send: (request) => nodeRequest(expressPort, request) },
    { name: "fastify", send: (request) => nodeRequest(fastifyPort, request) },
    {
      name: "hono",
      send: async (request) => {
        const headers = new Headers()
        for (const [name, value] of request.headers) headers.append(name, value)
        const response = await hono.request(ORIGIN + request.target, { method: request.method, headers, ...(request.body !== undefined ? { body: new Blob([request.body as BlobPart]) } : {}) })
        const bytes = new Uint8Array(await response.arrayBuffer())
        return { status: response.status, text: new TextDecoder().decode(bytes), bytes, headers: response.headers }
      },
    },
  ]
  return { transports, close: async () => { for (const close of closers.splice(0)) await close() } }
}
