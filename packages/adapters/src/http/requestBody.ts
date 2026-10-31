import type { ValidationSchema } from "@xonava/core/kernel"
import { ValidationError } from "@xonava/core/domain"
import type { HttpRequestMetadata } from "./trustedClientIp"

export const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024

export class InvalidJsonError extends Error {
  readonly code = "INVALID_JSON"

  constructor() {
    super("Invalid JSON body")
    this.name = "InvalidJsonError"
  }
}

export class RequestBodyTooLargeError extends Error {
  readonly code = "REQUEST_BODY_TOO_LARGE"

  constructor(readonly maxBytes: number) {
    super("Request body is too large")
    this.name = "RequestBodyTooLargeError"
  }
}

export class UnsupportedMediaTypeError extends Error {
  readonly code = "UNSUPPORTED_MEDIA_TYPE"

  constructor() {
    super("Request content type must be JSON encoded as UTF-8")
    this.name = "UnsupportedMediaTypeError"
  }
}

export class RequestBodyNotAcceptedError extends Error {
  readonly code = "BODY_NOT_ACCEPTED"

  constructor() {
    super("This operation does not accept a request body")
    this.name = "RequestBodyNotAcceptedError"
  }
}

function assertJsonContentType(request: Request): void {
  const contentType = request.headers.get("content-type")
  if (!contentType) throw new UnsupportedMediaTypeError()
  const [mediaType, ...parameters] = contentType.split(";").map((part) => part.trim().toLowerCase())
  if (mediaType !== "application/json" && !/^application\/[^;\s]+\+json$/.test(mediaType ?? "")) {
    throw new UnsupportedMediaTypeError()
  }
  const charset = parameters.find((parameter) => parameter.startsWith("charset="))?.slice("charset=".length)
  if (charset && charset !== "utf-8") throw new UnsupportedMediaTypeError()
}

async function readBodyText(request: Request, maxBytes: number): Promise<string> {
  const contentLength = request.headers.get("content-length")
  const declaredLength = contentLength ? Number(contentLength) : NaN
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes)
  }

  const body = request.clone().body
  if (!body) return ""

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        throw new RequestBodyTooLargeError(maxBytes)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new InvalidJsonError()
  }
}

export async function parseJsonBodySafely<TSchema>(
  request: Request,
  schema?: ValidationSchema,
  maxBytes = DEFAULT_MAX_JSON_BODY_BYTES,
): Promise<TSchema | undefined> {
  const text = await readBodyText(request, maxBytes)
  if (!text) {
    if (!schema) return undefined
  } else {
    if (!schema) throw new RequestBodyNotAcceptedError()
    assertJsonContentType(request)
  }

  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error
    throw new InvalidJsonError()
  }

  return schema.parseAsync(raw) as Promise<TSchema>
}

const MAX_REQUEST_METADATA_LENGTH = 256
const MAX_USER_AGENT_LENGTH = 512

function generateRequestId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }
}

function boundedHeader(request: Request, name: string, maxLength: number): string {
  return (request.headers.get(name) ?? "").trim().slice(0, maxLength)
}

export type TrustedClientIpResolver = (request: Request, metadata?: HttpRequestMetadata) => string | null | undefined

export const DEFAULT_MAX_QUERY_PARAMETER_BYTES = 64 * 1024

export function parseUniqueQueryParameters(request: Request): Record<string, string> {
  const query: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, value] of new URL(request.url).searchParams.entries()) {
    if (Object.hasOwn(query, key)) throw new ValidationError(`Duplicate query parameter: ${key}`)
    if (new TextEncoder().encode(value).byteLength > DEFAULT_MAX_QUERY_PARAMETER_BYTES) {
      throw new ValidationError(`Query parameter "${key}" exceeds the maximum of ${DEFAULT_MAX_QUERY_PARAMETER_BYTES} UTF-8 bytes`)
    }
    query[key] = value
  }
  return query
}

export function resolveRequestMetadata(
  request: Request,
  resolveClientIp?: TrustedClientIpResolver,
  metadata?: HttpRequestMetadata,
): { requestId: string; correlationId: string; ipAddress: string; userAgent: string | null } {
  const resolvedIp = resolveClientIp?.(request, metadata)?.trim().slice(0, MAX_REQUEST_METADATA_LENGTH)
  const requestId = generateRequestId()
  return {
    requestId,
    correlationId: boundedHeader(request, "x-correlation-id", MAX_REQUEST_METADATA_LENGTH) || requestId,
    ipAddress: resolvedIp || "unknown",
    userAgent: boundedHeader(request, "user-agent", MAX_USER_AGENT_LENGTH) || null,
  }
}
