import { describe, expect, it } from "vitest"
import { redactPhi, redactPhiDeep } from "../redact"

/** Equivalence oracle: the original (quadratic) pattern set, kept only here. */
const LEGACY_PATTERNS = [
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: "[email redacted]" },
  { pattern: /\b(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, replacement: "[phone redacted]" },
  { pattern: /\b\d{4}[-]\d{2}[-]\d{2}\b/g, replacement: "[date redacted]" },
  { pattern: /\b(?:\d[ -]*?){13,16}\b/g, replacement: "[card redacted]" },
]
const MARKER = /^\[(?:redacted|email redacted|phone redacted|date redacted|card redacted)\]$/i
function legacyRedactPhi(value: string): string {
  if (MARKER.test(value)) return value
  let result = value
  for (const { pattern, replacement } of LEGACY_PATTERNS) result = result.replace(pattern, replacement)
  return result
}

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 }
}

const FRAGMENTS = [
  "a", "b", "Z", "x1", "_", ".", "-", "+", "%", "@", "@", "co", "com", "org", "e", "a.b", "john.doe", "user+tag", "mail.example.com",
  " ", "  ", ",", "(", ")", "é", "\n", "1", "2", "9", "555", "1234", "5551234567", "+1 ", "(555) 123-4567", "555-123-4567", "2024-01-31",
  "4111 1111 1111 1111", "4111-1111-1111-1111", "-", "--", "[email redacted]", "x@y.zz", "a@b.cc", "a@b.c", "@@", "a@", "@b.co",
]

describe("redactPhi linear-time email scanner", () => {
  it("matches the legacy regex set on fragment-built and random strings", () => {
    const rand = lcg(20240601)
    const alphabet = "ab1_.-+%@ ()éZ9x,"
    for (let i = 0; i < 6000; i += 1) {
      let s = ""
      if (i % 2 === 0) {
        const parts = 1 + Math.floor(rand() * 10)
        for (let p = 0; p < parts; p += 1) s += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]
      } else {
        const len = Math.floor(rand() * 40)
        for (let p = 0; p < len; p += 1) s += alphabet[Math.floor(rand() * alphabet.length)]
      }
      expect(redactPhi(s), JSON.stringify(s)).toBe(legacyRedactPhi(s))
    }
  })

  it("keeps ordinary results", () => {
    expect(redactPhi("mail alice@example.com or bob.smith+x@mail.example.co.uk now")).toBe("mail [email redacted] or [email redacted] now")
    expect(redactPhi("call 555-123-4567 on 2024-01-31")).toBe("call [phone redacted] on [date redacted]")
    expect(redactPhi("a@b.c")).toBe("a@b.c")
    expect(redactPhi("[email redacted]")).toBe("[email redacted]")
    expect(redactPhiDeep({ note: "x", list: ["a@b.com"] })).toEqual({ note: "[Redacted]", list: ["[email redacted]"] })
  })

  const SIZE = 200_000
  const shapes: Record<string, string> = {
    "dot-letter pairs": "a.".repeat(SIZE / 2),
    "dash-letter pairs": "a-".repeat(SIZE / 2),
    "digit-dot pairs": "1.".repeat(SIZE / 2),
    "plus pairs": "+1".repeat(SIZE / 2),
    "at then dot pairs": `a@${"a.".repeat(SIZE / 2)}`,
    "at then dotted domain and digit": `a@${"b.".repeat(SIZE / 2)}1`,
    "repeated local@domain.": "a@a.".repeat(SIZE / 4),
    "many ats": "x@".repeat(SIZE / 2),
    "local run with trailing at": `${"a.".repeat(SIZE / 2 - 1)}a@`,
    "long domain without tld": `a@${"b".repeat(SIZE)}`,
    "digit runs": "1".repeat(SIZE),
    "spaced digits": "1 ".repeat(SIZE / 2),
  }
  for (const [name, input] of Object.entries(shapes)) {
    it(`redacts a ${SIZE / 1000} kB ${name} input in linear time`, () => {
      const started = performance.now()
      redactPhi(input)
      expect(performance.now() - started).toBeLessThan(500)
    })
  }

  it("redacts every email in a large body in linear time", () => {
    const body = "contact alice@example.com today. ".repeat(30_000)
    const started = performance.now()
    const out = redactPhi(body)
    expect(performance.now() - started).toBeLessThan(500)
    expect(out.startsWith("contact [email redacted] today. ")).toBe(true)
    expect(out).not.toContain("@")
  })
})
