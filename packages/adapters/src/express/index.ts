import { Router, type RequestHandler } from "express"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream } from "node:stream/web"
import { createFrameworkErrorHandler } from "../http/handleFrameworkCoreError"
import { crudHttpRoutes, invokeHttpHandler, type HttpHandler, type HttpCrudHandlers } from "../http/frameworkAdapter"
import { nodeAbortSignal, nodeRequest, readNodeBody, responseHeaders, validateNodeOptions, type NodeHttpAdapterOptions } from "../http/nodeAdapter"

export type ExpressAdapterOptions = NodeHttpAdapterOptions

/** Mount before body parsers, or after an uncompressed express.raw parser. */
export function createExpressHandler(handler: HttpHandler, options: ExpressAdapterOptions): RequestHandler {
  const { origin, maxBodyBytes } = validateNodeOptions(options)
  return (request, reply, next) => {
    const abort = nodeAbortSignal(request, reply)
    const run = async () => {
      let response: Response
      try {
        const body = await readNodeBody(request, request.body as unknown, maxBodyBytes)
        const fetchRequest = nodeRequest(request, request.originalUrl, origin, body, abort.signal)
        response = await invokeHttpHandler(handler, fetchRequest, request.params as Record<string, string>, options)
      } catch (error) {
        response = createFrameworkErrorHandler(options)(error)
      }
      reply.status(response.status)
      for (const [name, value] of responseHeaders(response.headers)) reply.setHeader(name, value)
      if (request.method === 'HEAD' || !response.body) {
        await response.body?.cancel()
        reply.end()
      } else {
        await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), reply)
      }
    }
    void run().catch(next).finally(abort.cleanup)
  }
}

/** Mount with app.use('/people', createExpressCrudRouter(handlers, options)). */
export function createExpressCrudRouter(handlers: HttpCrudHandlers, options: ExpressAdapterOptions): Router {
  validateNodeOptions(options)
  const router = Router({ mergeParams: true })
  for (const route of crudHttpRoutes(handlers)) {
    const handler = createExpressHandler(route.handler, options)
    switch (route.method) {
      case 'GET': router.get(route.path, handler); break
      case 'POST': router.post(route.path, handler); break
      case 'PATCH': router.patch(route.path, handler); break
      case 'DELETE': router.delete(route.path, handler); break
    }
  }
  return router
}
