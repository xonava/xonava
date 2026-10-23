// @ts-nocheck
import { describe, expect, it } from "vitest"
import { expectNearLinear } from "../../../../core/src/__tests__/timing"
import { redactPhi, redactPhiDeep } from "../redact"

// The cost on each input is compared with the cost on a quarter-size input of the same shape, so coverage
// instrumentation or a loaded machine cannot fail these tests; only super-linear growth can. The small input is built
// by the same builder, not sliced from the large one: slicing can drop a shape's trailing "@" and turn it into a
// cheaper input, which made the ratio meaningless.
const nearLinear = (build: (size: number) => string, size: number) => expectNearLinear((n) => { const input = build(n); return () => redactPhi(input) }, { size })

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
  const shapes: Record<string, (n: number) => string> = {
    "dot-letter pairs": (n) => "a.".repeat(n / 2),
    "dash-letter pairs": (n) => "a-".repeat(n / 2),
    "digit-dot pairs": (n) => "1.".repeat(n / 2),
    "plus pairs": (n) => "+1".repeat(n / 2),
    "at then dot pairs": (n) => `a@${"a.".repeat(n / 2)}`,
    "at then dotted domain and digit": (n) => `a@${"b.".repeat(n / 2)}1`,
    "repeated local@domain.": (n) => "a@a.".repeat(n / 4),
    "many ats": (n) => "x@".repeat(n / 2),
    "local run with trailing at": (n) => `${"a.".repeat(n / 2 - 1)}a@`,
    "long domain without tld": (n) => `a@${"b".repeat(n)}`,
    "digit runs": (n) => "1".repeat(n),
    "spaced digits": (n) => "1 ".repeat(n / 2),
  }
  for (const [name, build] of Object.entries(shapes)) {
    it(`redacts a ${SIZE / 1000} kB ${name} input in linear time`, async () => {
      await nearLinear(build, SIZE)
    })
  }

  it("redacts every email in a large body in linear time", async () => {
    const sentence = "contact alice@example.com today. "
    const body = sentence.repeat(30_000)
    await nearLinear((n) => sentence.repeat(Math.round(n / sentence.length)), body.length)
    const out = redactPhi(body)
    expect(out.startsWith("contact [email redacted] today. ")).toBe(true)
    expect(out).not.toContain("@")
  })
})
