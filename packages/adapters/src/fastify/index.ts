import type { FastifyPluginAsync, RouteHandlerMethod } from "fastify"
import { Readable } from "node:stream"
import type { ReadableStream } from "node:stream/web"
import { createFrameworkErrorHandler } from "../http/handleFrameworkCoreError"
import { RequestBodyTooLargeError } from "../http/requestBody"
import { crudHttpRoutes, invokeHttpHandler, type HttpHandler, type HttpCrudHandlers } from "../http/frameworkAdapter"
import { nodeAbortSignal, nodeRequest, readNodeBody, responseHeaders, validateNodeOptions, type NodeHttpAdapterOptions } from "../http/nodeAdapter"

export type FastifyAdapterOptions = NodeHttpAdapterOptions

/**
 * Fastify's router hands out a params object with its own prototype. Handlers fingerprint the raw path
 * parameters for idempotency, and canonical JSON accepts only plain objects, so copy them into one.
 */
function plainParams(params: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries((params ?? {}) as Record<string, string>))
}

/** Individual routes require a raw Buffer content-type parser (see fastifyCrudPlugin). */
export function createFastifyHandler(handler: HttpHandler, options: FastifyAdapterOptions): RouteHandlerMethod {
  const { origin, maxBodyBytes } = validateNodeOptions(options)
  return async (request, reply) => {
    const abort = nodeAbortSignal(request.raw, reply.raw)
    reply.raw.once('close', abort.cleanup)
    reply.raw.once('finish', abort.cleanup)
    let response: Response
    try {
      const body = await readNodeBody(request.raw, request.body, maxBodyBytes)
      const fetchRequest = nodeRequest(request.raw, request.raw.url ?? '/', origin, body, abort.signal)
      response = await invokeHttpHandler(handler, fetchRequest, plainParams(request.params), options)
    } catch (error) {
      response = createFrameworkErrorHandler(options)(error)
    }
    reply.code(response.status)
    for (const [name, value] of responseHeaders(response.headers)) reply.header(name, value)
    if (request.method === 'HEAD' || !response.body) {
      await response.body?.cancel()
      return reply.send()
    }
    return reply.send(Readable.fromWeb(response.body as ReadableStream<Uint8Array>))
  }
}

/** Register with Fastify's prefix option; parser changes remain inside this plugin. */
export const fastifyCrudPlugin: FastifyPluginAsync<FastifyAdapterOptions & { handlers: HttpCrudHandlers }> = async (app, options) => {
  const { maxBodyBytes } = validateNodeOptions(options)
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: Math.max(1, maxBodyBytes) }, (_request, body, done) => done(null, body))
  // Fastify answers a Content-Type it cannot parse (an empty value, a comma list) with its own 415 before the body
  // is read, which would skip the shared body checks and their order. The adapter rebuilds the Fetch request from the
  // raw header lines, so give Fastify's parser selection a neutral type and leave the original untouched.
  app.addHook('onRequest', async (request) => {
    if (request.raw.headers['content-type'] !== undefined) request.raw.headers['content-type'] = 'application/octet-stream'
  })
  // Fastify refuses an oversized body in its own parser, before any handler runs. Answer it with the framework's
  // 413 REQUEST_BODY_TOO_LARGE so every adapter reports the same status and code.
  app.setErrorHandler(async (error, _request, reply) => {
    if ((error as { code?: unknown }).code !== 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.send(error)
    const response = createFrameworkErrorHandler(options)(new RequestBodyTooLargeError(maxBodyBytes))
    reply.code(response.status)
    for (const [name, value] of responseHeaders(response.headers)) reply.header(name, value)
    return reply.send(await response.text())
  })
  for (const route of crudHttpRoutes(options.handlers)) {
    app.route({ method: route.method, url: route.path, handler: createFastifyHandler(route.handler, options) })
  }
}
