import type { IncomingMessage, ServerResponse } from "node:http"
import { ConfigurationError, ValidationError } from "@xonava/core/domain"
import { DEFAULT_MAX_JSON_BODY_BYTES, RequestBodyTooLargeError } from "./requestBody"
import { setAdapterHttpMetadata, type HttpAdapterOptions } from "./frameworkAdapter"

export interface NodeHttpAdapterOptions extends HttpAdapterOptions {
  /** Public HTTP(S) origin. Host and forwarded headers are never trusted to construct URLs. */
  origin: string
  maxBodyBytes?: number
}

export function validateNodeOptions(options: NodeHttpAdapterOptions): { origin: string; maxBodyBytes: number } {
  const url = new URL(options.origin)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new ConfigurationError("HTTP adapter origin must be an HTTP(S) origin without credentials, path, query, or fragment")
  }
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_JSON_BODY_BYTES
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0) throw new ConfigurationError("maxBodyBytes must be a non-negative safe integer")
  return { origin: url.origin, maxBodyBytes }
}

/** Preserve the original bytes; reconstructing parsed JSON changes validation and fingerprints. */
export async function readNodeBody(request: IncomingMessage, parsedBody: unknown, maxBytes: number): Promise<Uint8Array | undefined> {
  if (parsedBody !== undefined) {
    if (!(parsedBody instanceof Uint8Array)) throw new ConfigurationError("HTTP adapters require an unparsed body or a raw Buffer; mount before JSON/text body parsers")
    if (parsedBody.byteLength > maxBytes) throw new RequestBodyTooLargeError(maxBytes)
    return parsedBody
  }
  if (request.readableEnded) {
    if (Number(request.headers['content-length'] ?? 0) > 0 || request.headers['transfer-encoding']) throw new ConfigurationError("HTTP request body was consumed before the adapter")
    return undefined
  }
  if (request.destroyed) throw new Error("HTTP request aborted")
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const cleanup = () => {
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
      request.off('aborted', onAborted)
    }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const onAborted = () => onError(new Error("HTTP request aborted"))
    const onEnd = () => { cleanup(); resolve(size ? Buffer.concat(chunks) : undefined) }
    const onData = (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > maxBytes) {
        cleanup()
        request.resume()
        reject(new RequestBodyTooLargeError(maxBytes))
      } else chunks.push(chunk)
    }
    request.on('data', onData)
    request.once('end', onEnd)
    request.once('error', onError)
    request.once('aborted', onAborted)
  })
}

export function nodeAbortSignal(request: IncomingMessage, response: ServerResponse): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const close = () => { if (!response.writableFinished) abort() }
  request.once('aborted', abort)
  response.once('close', close)
  request.socket.once('close', close)
  if (request.aborted || response.destroyed) abort()
  return { signal: controller.signal, cleanup: () => { request.off('aborted', abort); response.off('close', close); request.socket.off('close', close) } }
}

const hopByHop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

export function responseHeaders(headers: Headers): Array<[string, string | string[]]> {
  const excluded = new Set([...hopByHop, ...(headers.get('connection') ?? '').toLowerCase().split(',').map(value => value.trim())])
  const result: Array<[string, string | string[]]> = []
  headers.forEach((value, key) => { if (!excluded.has(key) && key !== 'set-cookie') result.push([key, value]) })
  if (!excluded.has('set-cookie') && headers.getSetCookie().length) result.push(['set-cookie', headers.getSetCookie()])
  return result
}

export function nodeRequest(raw: IncomingMessage, target: string, origin: string, body: Uint8Array | undefined, signal: AbortSignal): Request {
  if (!target.startsWith('/') || target.includes('#')) throw new ValidationError("Expected an origin-relative HTTP request target")
  const headers = new Headers()
  for (let index = 0; index < raw.rawHeaders.length; index += 2) headers.append(raw.rawHeaders[index]!, raw.rawHeaders[index + 1]!)
  // Concatenation keeps a leading // in the path from overriding the configured origin.
  const request = new Request(origin + target, {
    method: raw.method ?? 'GET', headers, signal,
    ...(body?.byteLength && raw.method !== 'GET' && raw.method !== 'HEAD' ? { body: new Uint8Array(body) } : {}),
  })
  setAdapterHttpMetadata(request, { peerAddress: raw.socket.remoteAddress ?? null })
  return request
}
