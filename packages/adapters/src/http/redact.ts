const PHI_PATTERNS = [
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: "[email redacted]" },
  { pattern: /\b(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, replacement: "[phone redacted]" },
  { pattern: /\b\d{4}[-]\d{2}[-]\d{2}\b/g, replacement: "[date redacted]" },
  { pattern: /\b(?:\d[ -]*?){13,16}\b/g, replacement: "[card redacted]" },
]
const REDACTION_MARKER = /^\[(?:redacted|email redacted|phone redacted|date redacted|card redacted)\]$/i
const SENSITIVE_KEYS = /(?:address|api.?key|auth|birth|card|clinical|diagnos|email|name|note|password|patient|phone|secret|ssn|symptom|token|medical|\bmrn\b)/i

export function redactPhi(value: string): string {
  if (REDACTION_MARKER.test(value)) return value
  let result = value
  for (const { pattern, replacement } of PHI_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

export function redactPhiDeep(obj: unknown): unknown {
  if (typeof obj === "string") return redactPhi(obj)
  if (Array.isArray(obj)) return obj.map(redactPhiDeep)
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEYS.test(key)
        ? "[Redacted]"
        : redactPhiDeep(val)
    }
    return result
  }
  return obj
}

/** Shared sanitizer for audit values before either direct or outbox persistence. */
export const sanitizeAuditValue = redactPhiDeep
