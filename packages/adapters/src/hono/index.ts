import { Hono, type Context, type Env, type Handler } from "hono"
import type { HttpRequestMetadata } from "../http/trustedClientIp"
import { createFrameworkErrorHandler } from "../http/handleFrameworkCoreError"
import { crudHttpRoutes, invokeHttpHandler, setAdapterHttpMetadata, type HttpAdapterOptions, type HttpCrudHandlers, type HttpHandler } from "../http/frameworkAdapter"

export interface HonoAdapterOptions<E extends Env = Env> extends HttpAdapterOptions {
  /** Use authenticated runtime connection information, never forwarded headers alone. */
  resolveHttpMetadata?: (context: Context<E>) => HttpRequestMetadata
}

export function createHonoHandler<E extends Env = Env>(handler: HttpHandler, options: HonoAdapterOptions<E> = {}): Handler<E> {
  return async context => {
    try {
      const request = context.req.raw
      if (options.resolveHttpMetadata) setAdapterHttpMetadata(request, options.resolveHttpMetadata(context))
      return await invokeHttpHandler(handler, request, context.req.param(), options)
    } catch (error) {
      return createFrameworkErrorHandler(options)(error)
    }
  }
}

/** Mount using app.route('/people', createHonoCrudApp(handlers)). */
export function createHonoCrudApp<E extends Env = Env>(handlers: HttpCrudHandlers, options: HonoAdapterOptions<E> = {}): Hono<E> {
  const app = new Hono<E>()
  for (const route of crudHttpRoutes(handlers)) app.on(route.method, route.path, createHonoHandler(route.handler, options))
  return app
}
