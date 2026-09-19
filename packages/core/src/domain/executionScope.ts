import { canonicalJsonString, decodeCanonicalJson, encodeBase64UrlUnpadded, decodeBase64UrlUnpadded, CanonicalJsonError } from "../serialization/canonicalJson"
import { EXECUTION_SCOPE_ID_PREFIX } from "../spec/authority"
import { CANONICAL_JSON_LIMITS_V1, FORMAT_DEFAULT_MAX_CANONICAL_BYTES, SERIALIZATION_LIMIT_EXCEEDED_ERROR } from "../spec/formatVersions"

export type ExecutionScope =
  | { readonly kind: "application"; readonly applicationKey: string }
  | { readonly kind: "tenant"; readonly tenantId: string }
  | { readonly kind: "platform"; readonly platformKey: string }
  | { readonly kind: "system"; readonly systemKey: string }

export type ExecutionScopeId = string & { readonly __brand: "ExecutionScopeId" }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

export function validateExecutionScope(scope: unknown): ExecutionScope {
  if (!isRecord(scope) || typeof scope.kind !== "string") {
    throw new CanonicalJsonError("invalid ExecutionScope: missing kind")
  }
  switch (scope.kind) {
    case "application": {
      if (!nonBlank(scope.applicationKey)) {
        throw new CanonicalJsonError("invalid application scope: applicationKey must be non-empty string")
      }
      if (Object.keys(scope).length !== 2) throw new CanonicalJsonError("invalid application scope: extra keys")
      return { kind: "application", applicationKey: scope.applicationKey }
    }
    case "tenant": {
      if (!nonBlank(scope.tenantId)) {
        throw new CanonicalJsonError("invalid tenant scope: tenantId must be non-empty string")
      }
      if (Object.keys(scope).length !== 2) throw new CanonicalJsonError("invalid tenant scope: extra keys")
      return { kind: "tenant", tenantId: scope.tenantId }
    }
    case "platform": {
      if (!nonBlank(scope.platformKey)) {
        throw new CanonicalJsonError("invalid platform scope: platformKey must be non-empty string")
      }
      if (Object.keys(scope).length !== 2) throw new CanonicalJsonError("invalid platform scope: extra keys")
      return { kind: "platform", platformKey: scope.platformKey }
    }
    case "system": {
      if (!nonBlank(scope.systemKey)) {
        throw new CanonicalJsonError("invalid system scope: systemKey must be non-empty string")
      }
      if (Object.keys(scope).length !== 2) throw new CanonicalJsonError("invalid system scope: extra keys")
      return { kind: "system", systemKey: scope.systemKey }
    }
    default:
      throw new CanonicalJsonError(`invalid ExecutionScope kind: ${String(scope.kind)}`)
  }
}

export function encodeExecutionScopeId(scope: ExecutionScope): ExecutionScopeId {
  const validated = validateExecutionScope(scope)
  const json = canonicalJsonString(validated)
  const bytes = new TextEncoder().encode(json)
  if (bytes.byteLength > FORMAT_DEFAULT_MAX_CANONICAL_BYTES.executionScopeIdentitySource) {
    throw new CanonicalJsonError(
      `execution scope canonical bytes ${bytes.byteLength} exceeds limit ${FORMAT_DEFAULT_MAX_CANONICAL_BYTES.executionScopeIdentitySource}`,
      { code: SERIALIZATION_LIMIT_EXCEEDED_ERROR },
    )
  }
  if (bytes.byteLength > CANONICAL_JSON_LIMITS_V1.maxUtf8Bytes) {
    throw new CanonicalJsonError(`execution scope bytes exceeds absolute ceiling`, { code: SERIALIZATION_LIMIT_EXCEEDED_ERROR })
  }
  const b64 = encodeBase64UrlUnpadded(bytes)
  return `${EXECUTION_SCOPE_ID_PREFIX}${b64}` as ExecutionScopeId
}

export function decodeExecutionScopeId(scopeId: string): ExecutionScope {
  if (typeof scopeId !== "string") throw new CanonicalJsonError("scopeId must be string")
  if (!scopeId.startsWith(EXECUTION_SCOPE_ID_PREFIX)) {
    throw new CanonicalJsonError(`scopeId must start with ${EXECUTION_SCOPE_ID_PREFIX}`)
  }
  const b64 = scopeId.slice(EXECUTION_SCOPE_ID_PREFIX.length)
  if (b64.length === 0) throw new CanonicalJsonError("scopeId missing base64url payload")
  const bytes = decodeBase64UrlUnpadded(b64)
  if (bytes.byteLength > FORMAT_DEFAULT_MAX_CANONICAL_BYTES.executionScopeIdentitySource) {
    throw new CanonicalJsonError(`decoded scope bytes ${bytes.byteLength} exceeds limit`, { code: SERIALIZATION_LIMIT_EXCEEDED_ERROR })
  }
  let json: string
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new CanonicalJsonError("scopeId contains invalid UTF-8")
  }
  const parsed = decodeCanonicalJson(json)
  const validated = validateExecutionScope(parsed)
  // Verify byte-for-byte re-encoding identity
  const reEncoded = encodeExecutionScopeId(validated)
  if (reEncoded !== scopeId) {
    throw new CanonicalJsonError("scopeId is not canonical: re-encoding mismatch")
  }
  return validated
}

export function executionScopesEqual(left: ExecutionScope, right: ExecutionScope): boolean {
  return encodeExecutionScopeId(left) === encodeExecutionScopeId(right)
}

export function isExecutionScopeKind<K extends ExecutionScope["kind"]>(
  scope: ExecutionScope,
  kind: K,
): scope is Extract<ExecutionScope, { readonly kind: K }> {
  return scope.kind === kind
}

export function isAuthorityNarrowing(source: ExecutionScope, target: ExecutionScope): boolean {
  if (executionScopesEqual(source, target)) return true
  return (source.kind === "platform" || source.kind === "system") && target.kind === "tenant"
}
