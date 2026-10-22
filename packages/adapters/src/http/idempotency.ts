import type { IdempotencyCompletion, IdempotencyPort, IdempotencyRequest } from "@xonava/core/events"
import { canonicalJsonString, legacyJavaScriptOrderJsonString } from "@xonava/core/serialization"
import type { RequestContext } from "@xonava/core/domain"

/**
 * v3: canonical JSON in RFC 8785 key order. v2 serialized integer-like object
 * keys in JavaScript property order; a retry whose stored record still carries
 * a v2 fingerprint is matched via {@link legacyFingerprintJson}.
 */
export const IDEMPOTENCY_FINGERPRINT_VERSION = "v3"
const LEGACY_IDEMPOTENCY_FINGERPRINT_VERSION = "v2"
export const SERIALIZED_RESPONSE_VERSION = "v1"
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255
export const MAX_IDEMPOTENCY_CANONICAL_BYTES = 1024 * 1024
export const MAX_SERIALIZED_RESPONSE_BODY_BYTES = 4 * 1024 * 1024

export type IdempotencySecurityContext = {
  scope: string
  actorId: string
  actorType: string
  tenantId: string | null
  roleId: string | null
  roleSlug: string | null
  branchId: string | null
  departmentId: string | null
  impersonatedById: string | null
}

/** Stable principal identity for the idempotency scope namespace. */
export function buildIdempotencyScopeIdentity(context: RequestContext): string {
  const { actor, subject } = context.identity
  return `${context.scopeId}:${actor.kind}:${actor.id}:${subject.kind}:${subject.id}`
}

export function buildIdempotencySecurityContext(context: RequestContext): IdempotencySecurityContext {
  const { actor, subject } = context.identity
  return {
    scope: context.scopeId,
    actorId: actor.id,
    actorType: actor.kind,
    tenantId: context.scope.kind === "tenant" ? context.scope.tenantId : null,
    roleId: null,
    roleSlug: null,
    branchId: null,
    departmentId: null,
    impersonatedById: actor.id === subject.id && actor.kind === subject.kind ? null : actor.id,
  }
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
])

const REPLAY_HEADER_ALLOWLIST = new Set(["content-type", "cache-control", "etag", "retry-after"])

export interface SerializedResponse {
  version: typeof SERIALIZED_RESPONSE_VERSION
  body: string
  status: number
  headers: Array<[string, string]>
}

function assertHeader(name: string, value: string): void {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value)) throw new Error("Invalid serialized idempotency response header")
}

/** The material to fingerprint exceeds {@link MAX_IDEMPOTENCY_CANONICAL_BYTES}; for client input this is a bad request, not a fault. */
export class IdempotencyPayloadTooLargeError extends Error {
  constructor() {
    super("Idempotency fingerprint payload is too large")
    this.name = "IdempotencyPayloadTooLargeError"
  }
}

async function digestFingerprintInput(version: string, canonical: string): Promise<string> {
  const encoded = new TextEncoder().encode(`${version}\0${canonical}`)
  if (encoded.byteLength > MAX_IDEMPOTENCY_CANONICAL_BYTES) {
    throw new IdempotencyPayloadTooLargeError()
  }
  const digest = await crypto.subtle.digest("SHA-256", encoded)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function fingerprintJson(value: unknown): Promise<string> {
  return digestFingerprintInput(IDEMPOTENCY_FINGERPRINT_VERSION, canonicalJsonString(value))
}

/**
 * COMPATIBILITY ONLY: the v2 fingerprint of `value` (JavaScript key order), used
 * solely to recognise idempotency records written before the RFC 8785 fix.
 * Never use it for new records; remove it with v2.
 */
export async function legacyFingerprintJson(value: unknown): Promise<string> {
  return digestFingerprintInput(LEGACY_IDEMPOTENCY_FINGERPRINT_VERSION, legacyJavaScriptOrderJsonString(value))
}

export async function serializeResponse(response: Response): Promise<SerializedResponse> {
  const body = await response.text()
  if (new TextEncoder().encode(body).byteLength > MAX_SERIALIZED_RESPONSE_BODY_BYTES) {
    throw new Error("Idempotency response body is too large")
  }
  const headers = Array.from(response.headers.entries()).filter(([name]) => {
    const lower = name.toLowerCase()
    return REPLAY_HEADER_ALLOWLIST.has(lower) && !HOP_BY_HOP_HEADERS.has(lower)
  })
  headers.forEach(([name, value]) => assertHeader(name, value))
  return {
    version: SERIALIZED_RESPONSE_VERSION,
    body,
    status: response.status,
    headers,
  }
}

export function deserializeResponse(serialized: SerializedResponse): Response {
  if (!serialized || typeof serialized !== "object" || serialized.version !== SERIALIZED_RESPONSE_VERSION || typeof serialized.body !== "string" || !Array.isArray(serialized.headers)) {
    throw new Error("Invalid serialized idempotency response")
  }
  if (!Number.isInteger(serialized.status) || serialized.status < 200 || serialized.status > 599) {
    throw new Error("Invalid serialized idempotency response status")
  }
  const headers: Array<[string, string]> = []
  const names = new Set<string>()
  for (const header of serialized.headers) {
    if (!Array.isArray(header) || header.length !== 2 || typeof header[0] !== "string" || typeof header[1] !== "string") {
      throw new Error("Invalid serialized idempotency response headers")
    }
    assertHeader(header[0], header[1])
    const name = header[0].toLowerCase()
    if (!REPLAY_HEADER_ALLOWLIST.has(name) || HOP_BY_HOP_HEADERS.has(name) || names.has(name)) throw new Error("Invalid serialized idempotency response headers")
    names.add(name)
    headers.push([header[0], header[1]])
  }
  if (new TextEncoder().encode(serialized.body).byteLength > MAX_SERIALIZED_RESPONSE_BODY_BYTES) {
    throw new Error("Idempotency response body is too large")
  }
  return new Response(serialized.body, {
    status: serialized.status,
    headers,
  })
}

export type SerializedResponseIdempotencyPort = IdempotencyPort<SerializedResponse>

const MAX_RATE_LIMIT_KEY_LENGTH = 128

/** Bounds caller-provided rate-limit key material with a canonical hash. */
export async function boundRateLimitKeyMaterial(value: string): Promise<string> {
  if (value.length <= MAX_RATE_LIMIT_KEY_LENGTH) return value
  const digest = await fingerprintJson({ material: value })
  return `${value.slice(0, MAX_RATE_LIMIT_KEY_LENGTH)}:${digest}`
}

export type IdempotencyCompletionForResponse = IdempotencyCompletion<SerializedResponse>

export type IdempotencyRequestForResponse = IdempotencyRequest
