/**
 * Linear-time text redaction for the audit sanitizer.
 *
 * Behaviour-equivalent to replacing every match of
 *
 *   /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b|\b(?:\+?\d[ -.]*){10,}\b|\b\d{4}-\d{2}-\d{2}\b/g
 *
 * with the placeholder, but without regular-expression backtracking: that expression takes quadratic time on inputs such as
 * "a.a.a.…" (32 kB took 2.4 s, 100 kB ~25 s). Each alternative is decided at a candidate start position in O(1) amortised time from
 * arrays computed in single passes over the text, and the three alternatives are tried in the original priority order at each
 * position, which reproduces the leftmost / first-alternative semantics of the regular expression.
 */

export const AUDIT_REDACTION_PLACEHOLDER = "[redacted]"

const isDigit = (c: number): boolean => c >= 48 && c <= 57
const isLetter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
/** `\w`: [A-Za-z0-9_]. */
const isWord = (c: number): boolean => isDigit(c) || isLetter(c) || c === 95
/** [A-Za-z0-9._%+-] — characters of an email local part. */
const isLocal = (c: number): boolean => isDigit(c) || isLetter(c) || c === 46 || c === 95 || c === 37 || c === 43 || c === 45
/** [A-Za-z0-9.-] — characters of an email domain. */
const isDomain = (c: number): boolean => isDigit(c) || isLetter(c) || c === 46 || c === 45
/** [ -.] — the code-point range U+0020..U+002E, the separators allowed between phone digits. */
const isSeparator = (c: number): boolean => c >= 32 && c <= 46
const isPhoneChar = (c: number): boolean => isDigit(c) || isSeparator(c)

/** Replaces emails, phone-number-like digit runs and ISO calendar dates in `text`. Runs in O(text.length). */
export function redactSensitiveText(text: string): string {
  const n = text.length
  // Every pattern needs an '@' (email) or a digit (phone, date).
  let candidate = false
  for (let i = 0; i < n; i += 1) {
    const c = text.charCodeAt(i)
    if (c === 64 || isDigit(c)) { candidate = true; break }
  }
  if (!candidate) return text

  const codes = new Uint16Array(n + 1) // codes[n] === 0: a non-word sentinel past the end
  for (let i = 0; i < n; i += 1) codes[i] = text.charCodeAt(i)
  const wordAt = (i: number): boolean => i >= 0 && i < n && isWord(codes[i]!)
  const boundaryAt = (i: number): boolean => wordAt(i - 1) !== wordAt(i)

  // localEnd[i]: end (exclusive) of the run of local-part characters starting at i. phoneEnd[i]: same for digits and separators.
  const localEnd = new Int32Array(n + 1)
  const phoneEnd = new Int32Array(n + 1)
  localEnd[n] = n
  phoneEnd[n] = n
  for (let i = n - 1; i >= 0; i -= 1) {
    const c = codes[i]!
    localEnd[i] = isLocal(c) ? localEnd[i + 1]! : i
    phoneEnd[i] = isPhoneChar(c) ? phoneEnd[i + 1]! : i
  }
  // digitsBefore[i]: digits in [0, i). digitPositions: index of every digit. lastBoundary[i]: largest j <= i with a word boundary at j.
  const digitsBefore = new Int32Array(n + 1)
  const digitPositions: number[] = []
  const lastBoundary = new Int32Array(n + 1)
  let last = -1
  for (let i = 0; i <= n; i += 1) {
    if (boundaryAt(i)) last = i
    lastBoundary[i] = last
    if (i < n) {
      const digit = isDigit(codes[i]!)
      digitsBefore[i + 1] = digitsBefore[i]! + (digit ? 1 : 0)
      if (digit) digitPositions.push(i)
    }
  }

  // End of the email domain + TLD that follows the '@' at `at`, or -1. Memoised: each '@' is analysed once, and domain runs never overlap.
  const domainCache = new Map<number, number>()
  const domainEnd = (at: number): number => {
    const cached = domainCache.get(at)
    if (cached !== undefined) return cached
    let stop = at + 1
    while (stop < n && isDomain(codes[stop]!)) stop += 1
    // The regex backtracks the greedy domain run to the LAST '.' that has a domain character before it, at least two letters after it
    // and a word boundary right after those letters (which are all the letters up to the first non-letter).
    let result = -1
    let lettersAfter = 0 // letters in [k + 1, stop)
    for (let k = stop - 1; k >= at + 2; k -= 1) {
      // lettersAfter currently counts the letter run beginning at k + 1
      const c = codes[k + 1]!
      lettersAfter = k + 1 < stop && isLetter(c) ? lettersAfter + 1 : 0
      if (codes[k] === 46 && lettersAfter >= 2) {
        const tldEnd = k + 1 + lettersAfter
        if (!wordAt(tldEnd)) { result = tldEnd; break }
      }
    }
    domainCache.set(at, result)
    return result
  }

  const emailAt = (i: number): number => {
    if (!isLocal(codes[i]!) || !boundaryAt(i)) return -1
    const end = localEnd[i]!
    return end < n && codes[end] === 64 ? domainEnd(end) : -1
  }

  const phoneAt = (i: number): number => {
    const first = codes[i]!
    const digitIndex = first === 43 ? i + 1 : i
    if (!isDigit(codes[digitIndex]!) || !boundaryAt(i)) return -1
    // The tenth digit (counting from the first one of this candidate) must lie inside the run of digits and separators.
    const tenth = digitsBefore[digitIndex]! + 9
    if (tenth >= digitPositions.length) return -1
    const run = phoneEnd[i]!
    const tenthAt = digitPositions[tenth]!
    if (tenthAt >= run) return -1
    // The regex is greedy: the match ends at the largest boundary inside the run that leaves at least ten digits.
    const end = lastBoundary[run]!
    return end > tenthAt ? end : -1
  }

  const dateAt = (i: number): number => {
    if (i + 10 > n || !boundaryAt(i)) return -1
    for (let k = 0; k < 10; k += 1) {
      const c = codes[i + k]!
      if (k === 4 || k === 7) { if (c !== 45) return -1 } else if (!isDigit(c)) return -1
    }
    return boundaryAt(i + 10) ? i + 10 : -1
  }

  let out = ""
  let copied = 0
  let i = 0
  while (i < n) {
    let end = emailAt(i)
    if (end < 0) end = phoneAt(i)
    if (end < 0) end = dateAt(i)
    if (end < 0) { i += 1; continue }
    out += text.slice(copied, i) + AUDIT_REDACTION_PLACEHOLDER
    copied = end
    i = end
  }
  return copied === 0 ? text : out + text.slice(copied)
}
