import type { Principal } from "../../domain/principal"
import type { PersistenceProvider } from "../../persistence/provider"

export type AuditSanitizer = (value: unknown) => unknown
export type AuditFieldClassification = "include" | "mask" | "omit"
export type AuditFieldClassifications = Record<string, AuditFieldClassification>

const SENSITIVE_AUDIT_KEYS = /(?:address|api.?key|auth|birth|card|clinical|diagnos|email|name|note|password|patient|phone|secret|ssn|symptom|token|medical|\bmrn\b)/i
const SENSITIVE_AUDIT_VALUE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b|\b(?:\+?\d[ -.]*){10,}\b|\b\d{4}-\d{2}-\d{2}\b/g
export const MAX_AUDIT_VALUE_DEPTH = 64
export const MAX_AUDIT_VALUE_NODES = 10_000

type AuditTransformMode = "sanitize" | "classify"

function boundedAuditTransform(
  value: unknown,
  mode: AuditTransformMode,
  classifications?: AuditFieldClassifications,
): unknown {
  let nodes = 0
  const ancestors = new WeakSet<object>()

  const transform = (current: unknown, depth: number): unknown => {
    if (depth > MAX_AUDIT_VALUE_DEPTH || ++nodes > MAX_AUDIT_VALUE_NODES) return "[truncated]"
    if (typeof current === "string") return mode === "sanitize" ? current.replace(SENSITIVE_AUDIT_VALUE, "[redacted]") : current
    if (current === null || typeof current !== "object") return current
    if (ancestors.has(current)) return "[circular]"

    ancestors.add(current)
    try {
      if (Array.isArray(current)) {
        const result: unknown[] = []
        for (let index = 0; index < current.length; index += 1) {
          if (nodes >= MAX_AUDIT_VALUE_NODES) {
            result.push("[truncated]")
            break
          }
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
          result.push(!descriptor || !("value" in descriptor) ? "[unavailable]" : transform(descriptor.value, depth + 1))
        }
        return result
      }

      const result: Record<string, unknown> = Object.create(null)
      for (const key in current) {
        if (!Object.hasOwn(current, key)) continue
        if (nodes >= MAX_AUDIT_VALUE_NODES) {
          result.__truncated__ = "[truncated]"
          break
        }
        const classification = classifications?.[key]
        if (mode === "classify" && classification === "omit") continue
        if (mode === "sanitize" && SENSITIVE_AUDIT_KEYS.test(key)) {
          result[key] = "[redacted]"
          continue
        }
        if (mode === "classify" && classification === "mask") {
          result[key] = "[masked]"
          continue
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        result[key] = !descriptor || !("value" in descriptor) ? "[unavailable]" : transform(descriptor.value, depth + 1)
      }
      return result
    } finally {
      ancestors.delete(current)
    }
  }

  return transform(value, 0)
}

/** Conservative fallback used when an operation has not supplied an app policy. */
export function defaultAuditSanitizer(value: unknown): unknown {
  return boundedAuditTransform(value, "sanitize")
}

/** Applies explicit schema policy before heuristic redaction. Omission is structural and wins. */
export function classifyAuditValue(value: unknown, classifications?: AuditFieldClassifications): unknown {
  if (!classifications || !value || typeof value !== "object") return value
  return boundedAuditTransform(value, "classify", classifications)
}

export interface AuditRecord {
  id: string
  occurredAt: Date
  action: string
  resourceType: string
  resourceId: string
  actor: Principal
  tenantId: string | null
  oldValue: Record<string, unknown> | null
  newValue: Record<string, unknown> | null
  metadata?: Record<string, unknown>
}

export function buildAuditRecord(args: {
  id: string
  occurredAt: Date
  actor: Principal
  action: string
  resourceType: string
  resourceId: string
  tenantId: string | null
  oldValue?: Record<string, unknown> | null
  newValue?: Record<string, unknown> | null
  metadata?: Record<string, unknown>
}): AuditRecord {
  return {
    id: args.id,
    occurredAt: args.occurredAt,
    actor: args.actor,
    action: args.action,
    resourceType: args.resourceType,
    resourceId: args.resourceId,
    tenantId: args.tenantId,
    oldValue: args.oldValue ?? null,
    newValue: args.newValue ?? null,
    ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
  }
}

export interface AuditSink {
  write(record: AuditRecord): Promise<void>
}

export interface AuditSinkFactory {
  create(persistence: PersistenceProvider): AuditSink
}

/** Adapts a persistence-aware sink constructor to the common composition port. */
export function createAuditSinkFactory(create: (persistence: PersistenceProvider) => AuditSink): AuditSinkFactory {
  return { create }
}
