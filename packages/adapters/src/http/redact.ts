const EMAIL_REPLACEMENT = "[email redacted]"
const PHI_PATTERNS = [
  { pattern: /\b(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, replacement: "[phone redacted]" },
  { pattern: /\b\d{4}[-]\d{2}[-]\d{2}\b/g, replacement: "[date redacted]" },
  { pattern: /\b(?:\d[ -]*?){13,16}\b/g, replacement: "[card redacted]" },
]
const REDACTION_MARKER = /^\[(?:redacted|email redacted|phone redacted|date redacted|card redacted)\]$/i
const SENSITIVE_KEYS = /(?:address|api.?key|auth|birth|card|clinical|diagnos|email|name|note|password|patient|phone|secret|ssn|symptom|token|medical|\bmrn\b)/i

const isDigit = (c: number): boolean => c >= 48 && c <= 57
const isLetter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
/** `\w`: [A-Za-z0-9_]. */
const isWord = (c: number): boolean => isDigit(c) || isLetter(c) || c === 95
/** [A-Za-z0-9._%+-]: characters of an email local part. */
const isLocal = (c: number): boolean => isDigit(c) || isLetter(c) || c === 46 || c === 95 || c === 37 || c === 43 || c === 45
/** [A-Za-z0-9.-]: characters of an email domain. */
const isDomain = (c: number): boolean => isDigit(c) || isLetter(c) || c === 46 || c === 45

/**
 * Linear-time equivalent of replacing every match of
 * `/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g` with the email placeholder.
 * That expression backtracks quadratically on inputs such as "a.a.a.…" (40 kB took
 * 2.4 s), and the write handler applies it to request bodies of up to 1 MB. The local part
 * can only end at the '@' that closes its character run, and each '@' is analysed once
 * (domain runs never overlap), so the scan is O(n).
 */
function redactEmails(text: string): string {
  if (!text.includes("@")) return text
  const n = text.length
  const codes = new Uint16Array(n + 1) // codes[n] === 0: a non-word sentinel past the end
  for (let i = 0; i < n; i += 1) codes[i] = text.charCodeAt(i)
  const wordAt = (i: number): boolean => i >= 0 && i < n && isWord(codes[i]!)
  const boundaryAt = (i: number): boolean => wordAt(i - 1) !== wordAt(i)
  // localEnd[i]: end (exclusive) of the run of local-part characters starting at i.
  const localEnd = new Int32Array(n + 1)
  localEnd[n] = n
  for (let i = n - 1; i >= 0; i -= 1) localEnd[i] = isLocal(codes[i]!) ? localEnd[i + 1]! : i

  // End of the domain + TLD after the '@' at `at`, or -1. The regex backtracks the greedy
  // domain run to the LAST '.' that has a domain character before it, at least two letters
  // after it (all letters up to the first non-letter) and a word boundary right after them.
  const domainCache = new Map<number, number>()
  const domainEnd = (at: number): number => {
    const cached = domainCache.get(at)
    if (cached !== undefined) return cached
    let stop = at + 1
    while (stop < n && isDomain(codes[stop]!)) stop += 1
    let result = -1
    let lettersAfter = 0 // consecutive letters starting at k + 1
    for (let k = stop - 1; k >= at + 2; k -= 1) {
      lettersAfter = k + 1 < stop && isLetter(codes[k + 1]!) ? lettersAfter + 1 : 0
      if (codes[k] === 46 && lettersAfter >= 2) {
        const tldEnd = k + 1 + lettersAfter
        if (!wordAt(tldEnd)) { result = tldEnd; break }
      }
    }
    domainCache.set(at, result)
    return result
  }

  let out = ""
  let copied = 0
  let i = 0
  while (i < n) {
    let end = -1
    if (isLocal(codes[i]!) && boundaryAt(i)) {
      const at = localEnd[i]!
      if (at < n && codes[at] === 64) end = domainEnd(at)
    }
    if (end < 0) { i += 1; continue }
    out += text.slice(copied, i) + EMAIL_REPLACEMENT
    copied = end
    i = end
  }
  return copied === 0 ? text : out + text.slice(copied)
}

export function redactPhi(value: string): string {
  if (REDACTION_MARKER.test(value)) return value
  let result = redactEmails(value)
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
