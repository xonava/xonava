import { ConfigurationError } from "@xonava/core/domain"
import { assertDurableIdentifier, CorruptJobMetadataError, type JobExecutionScope, type JobScope } from "@xonava/core/execution"

export function decodePersistedJobFingerprint(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CorruptJobMetadataError("Persisted job fingerprint is missing")
  }
  return value
}

/**
 * Where a job's or schedule's platform/system key lives.
 *
 * A platform or system scope carries a key (`platformKey` / `systemKey`) that tenant scopes do not have. It is stored
 * in its own nullable `scope_key` column, never in `tenant_id`: `tenant_id` is the tenant identity (tenant requesters
 * filter on it, tenant timezones are resolved from it, and requester reads of platform/system rows rely on it being
 * NULL), so reusing it would change the meaning of every query that touches it. The partition-head and running-sibling
 * checks and the MySQL active-partition unique index include `scope_key`, so jobs of different keys neither serialize
 * against nor merge with each other.
 *
 * The framework defaults are stored as NULL, not as the literal default. Rows written before the column existed (and
 * rows written by older workers during a rolling deploy) have NULL, which decodes to the default; keeping the default
 * NULL on write means an old and a new worker agree on the partition of every default-key job.
 */
export const DEFAULT_PLATFORM_KEY = "default"
export const DEFAULT_SYSTEM_KEY = "framework"
const MAX_SCOPE_KEY_BYTES = 100

export function decodePersistedJobScope(scope: JobScope, tenantId: string | null, scopeKey: string | null = null): JobExecutionScope {
  if (scope === "tenant") {
    if (!tenantId) throw new ConfigurationError("Persisted tenant job is missing tenant identity")
    if (scopeKey !== null) throw new ConfigurationError("Persisted tenant job carries a platform/system key")
    return { kind: "tenant", tenantId }
  }
  if (tenantId !== null) throw new ConfigurationError(`Persisted ${scope} job carries tenant identity`)
  if (scopeKey !== null && scopeKey.trim().length === 0) throw new ConfigurationError(`Persisted ${scope} job has a blank scope key`)
  return scope === "platform"
    ? { kind: "platform", platformKey: scopeKey ?? DEFAULT_PLATFORM_KEY }
    : { kind: "system", systemKey: scopeKey ?? DEFAULT_SYSTEM_KEY }
}

/** Reads the optional scope-key column of a row: absent, NULL and undefined all mean "the framework default". */
export function readPersistedScopeKey(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value)
}

export function encodeJobScope(scope: JobExecutionScope): { scope: JobScope; tenantId: string | null; scopeKey: string | null } {
  if (scope.kind === "tenant") return { scope: "tenant", tenantId: scope.tenantId, scopeKey: null }
  const key = scope.kind === "platform" ? scope.platformKey : scope.systemKey
  const defaultKey = scope.kind === "platform" ? DEFAULT_PLATFORM_KEY : DEFAULT_SYSTEM_KEY
  if (key === defaultKey) return { scope: scope.kind, tenantId: null, scopeKey: null }
  assertDurableIdentifier(key, `${scope.kind} scope key`, MAX_SCOPE_KEY_BYTES)
  return { scope: scope.kind, tenantId: null, scopeKey: key }
}
