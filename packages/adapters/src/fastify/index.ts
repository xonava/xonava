import type { FastifyPluginAsync, RouteHandlerMethod } from "fastify"
import { Readable } from "node:stream"
import type { ReadableStream } from "node:stream/web"
import { createFrameworkErrorHandler } from "../http/handleFrameworkCoreError"
import { crudHttpRoutes, invokeHttpHandler, type HttpHandler, type HttpCrudHandlers } from "../http/frameworkAdapter"
import { nodeAbortSignal, nodeRequest, readNodeBody, responseHeaders, validateNodeOptions, type NodeHttpAdapterOptions } from "../http/nodeAdapter"

export type FastifyAdapterOptions = NodeHttpAdapterOptions

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
      response = await invokeHttpHandler(handler, fetchRequest, request.params as Record<string, string>, options)
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
  for (const route of crudHttpRoutes(options.handlers)) {
    app.route({ method: route.method, url: route.path, handler: createFastifyHandler(route.handler, options) })
  }
}
