import { ConfigurationError } from "@xonava/core/domain"
import { CorruptJobMetadataError, type JobExecutionScope, type JobScope } from "@xonava/core/execution"

export function decodePersistedJobFingerprint(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CorruptJobMetadataError("Persisted job fingerprint is missing")
  }
  return value
}

export function decodePersistedJobScope(scope: JobScope, tenantId: string | null): JobExecutionScope {
  if (scope === "tenant") {
    if (!tenantId) throw new ConfigurationError("Persisted tenant job is missing tenant identity")
    return { kind: "tenant", tenantId }
  }
  if (tenantId !== null) throw new ConfigurationError(`Persisted ${scope} job carries tenant identity`)
  return scope === "platform"
    ? { kind: "platform", platformKey: "default" }
    : { kind: "system", systemKey: "framework" }
}

export function encodeJobScope(scope: JobExecutionScope): { scope: JobScope; tenantId: string | null } {
  return { scope: scope.kind, tenantId: scope.kind === "tenant" ? scope.tenantId : null }
}
