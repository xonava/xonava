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

const MAX_REDACTION_DEPTH = 32

/**
 * Redacts PHI recursively. Keys are defined as own data properties, so a
 * `__proto__` key is redacted like any other instead of changing the
 * result's prototype; depth and cycles are bounded.
 */
export function redactPhiDeep(obj: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof obj === "string") return redactPhi(obj)
  if (!obj || typeof obj !== "object") return obj
  if (depth >= MAX_REDACTION_DEPTH || seen.has(obj)) return "[Redacted]"
  seen.add(obj)
  try {
    if (Array.isArray(obj)) return obj.map((item) => redactPhiDeep(item, depth + 1, seen))
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      Object.defineProperty(result, key, {
        value: SENSITIVE_KEYS.test(key) ? "[Redacted]" : redactPhiDeep(val, depth + 1, seen),
        enumerable: true, writable: true, configurable: true,
      })
    }
    return result
  } finally {
    seen.delete(obj)
  }
}

/** Shared sanitizer for audit values before either direct or outbox persistence. */
export const sanitizeAuditValue = redactPhiDeep
