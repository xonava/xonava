import type { HttpRequestMetadata } from "./trustedClientIp"
import { createFrameworkErrorHandler, type FrameworkErrorHandlerOptions } from "./handleFrameworkCoreError"

export interface HttpHandlerContext {
  params?: Promise<unknown>
}

/** Compatible with createFrameworkWriteHandler and Fetch-native application handlers. */
export type HttpHandler = (request: Request, context?: HttpHandlerContext) => Response | Promise<Response>

/** The public result of CRUD(), including its distinct detail parameter convention. */
export interface HttpCrudHandlers {
  list: (request: Request) => Response | Promise<Response>
  detail: (request: Request, params: Record<string, string>) => Response | Promise<Response>
  create: HttpHandler
  update: HttpHandler
  delete: HttpHandler
}

export interface HttpAdapterOptions extends FrameworkErrorHandlerOptions {}

const metadata = new WeakMap<Request, Readonly<HttpRequestMetadata>>()

/** Supply as adapterDeps.resolveHttpMetadata to use authenticated transport metadata. */
export function resolveAdapterHttpMetadata(request: Request): Readonly<HttpRequestMetadata> | undefined {
  return metadata.get(request)
}

export function setAdapterHttpMetadata(request: Request, value: HttpRequestMetadata): void {
  metadata.set(request, Object.freeze({ ...value }))
}

export async function invokeHttpHandler(handler: HttpHandler, request: Request, params: Record<string, string>, options: HttpAdapterOptions): Promise<Response> {
  try {
    return await handler(request, { params: Promise.resolve(params) })
  } catch (error) {
    return createFrameworkErrorHandler(options)(error)
  }
}

export function crudHttpRoutes(handlers: HttpCrudHandlers): Array<{ method: "GET" | "POST" | "PATCH" | "DELETE"; path: string; handler: HttpHandler }> {
  return [
    { method: "GET", path: "/", handler: handlers.list },
    { method: "GET", path: "/:id", handler: (request, context) => Promise.resolve(context?.params).then(params => handlers.detail(request, params as Record<string, string>)) },
    { method: "POST", path: "/", handler: handlers.create },
    { method: "PATCH", path: "/:id", handler: handlers.update },
    { method: "DELETE", path: "/:id", handler: handlers.delete },
  ]
}
