import { describe, expect, it } from "vitest"
import { defaultAuditSanitizer } from "../audit"
import { redactSensitiveText } from "../auditRedaction"

/** The original (backtracking) expression: kept only as a test oracle for SHORT inputs. */
const REFERENCE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b|\b(?:\+?\d[ -.]*){10,}\b|\b\d{4}-\d{2}-\d{2}\b/g
const reference = (text: string): string => text.replace(REFERENCE, "[redacted]")

function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

function timed(fn: () => void): number {
  const started = performance.now()
  fn()
  return performance.now() - started
}

describe("redactSensitiveText equivalence with the original expression", () => {
  const ordinary = [
    "email@example.com and 2026-08-05",
    "+1 234 567 8901",
    "call +44 20 7946 0958 or (555) 123-4567 now",
    "john.doe+tag@sub.example.co.uk, jane_doe@example.org.",
    "no sensitive data here",
    "",
    "a@b.c", "a@b.cc", "a@b.cc_", "x@y.z.com", "user@host..com", "user@-host.com", "@example.com", "a@@b.com",
    "ssn 123-45-6789 id 1234567890 id 12345678901234",
    "1234567890_", "1 2 3 4 5 6 7 8 9 0_", "1-2-3-4-5-6-7-8-9-0.", "++1234567890", "+ 1234567890", "x1234567890",
    "2026-08-05T10:00:00Z", "12026-08-05", "2026-08-055", "2026-08-05_", "date=2026-08-05;",
    "mail me: a.b@c.de/x and 0123456789/ and 0123456789!",
    "user@example.com1", "user@example.com_", "user@example.comm-", "u@e.co.m",
  ]
  it.each(ordinary)("matches the original on %j", (input) => {
    expect(redactSensitiveText(input)).toBe(reference(input))
  })

  it("still redacts ordinary contact details", () => {
    expect(redactSensitiveText("mail jane.doe@example.com now")).toBe("mail [redacted] now")
    expect(redactSensitiveText("tel +1 (555) 123-4567")).toBe("tel +[redacted]")
    expect(redactSensitiveText("born 1990-02-03")).toBe("born [redacted]")
    expect(defaultAuditSanitizer({ note: "x", body: "a@b.io; 2026-01-01; +1 234 567 8901" })).toEqual({ note: "[redacted]", body: "[redacted]; [redacted]; +[redacted]" })
  })

  it("matches the original on 60,000 random strings drawn from a collision-heavy alphabet", () => {
    const random = lcg(0xc0ffee)
    const alphabets = [
      ["a", "b", ".", "@", "-", "_", "+", "%", " ", "1", "0"],
      ["1", "2", "3", " ", "-", ".", "+", "(", ")", "/", "a", "_"],
      ["2", "0", "-", "1", "5", "a", "T", " ", "."],
      ["a", "b", "c", ".", "@", "1", "-", "_", "!", " "],
    ]
    for (let run = 0; run < 60_000; run += 1) {
      const alphabet = alphabets[run % alphabets.length]!
      const length = Math.floor(random() * 40)
      let text = ""
      for (let i = 0; i < length; i += 1) text += alphabet[Math.floor(random() * alphabet.length)]
      const actual = redactSensitiveText(text)
      if (actual !== reference(text)) expect.fail(`diverged on ${JSON.stringify(text)}: ${JSON.stringify(actual)} vs ${JSON.stringify(reference(text))}`)
    }
  })

  it("matches the original on random strings built from realistic fragments", () => {
    const random = lcg(42)
    const fragments = ["john", ".", "doe", "@", "example", ".com", " ", "+1", "555", "-", "123", "4567", "(", ")", "2026-08-05", "12", "x", "_", "co.uk", ",", "\n", "é", "😀"]
    for (let run = 0; run < 20_000; run += 1) {
      let text = ""
      const parts = Math.floor(random() * 12)
      for (let i = 0; i < parts; i += 1) text += fragments[Math.floor(random() * fragments.length)]
      const actual = redactSensitiveText(text)
      if (actual !== reference(text)) expect.fail(`diverged on ${JSON.stringify(text)}`)
    }
  })
})

describe("redactSensitiveText is linear-time on adversarial input", () => {
  const SIZE = 200_000
  // Generous on purpose: v8 coverage (release certification) slows these runs several-fold, while a quadratic regression needs many seconds at 200 kB.
  const BUDGET_MS = 2_000
  const shapes: Array<[string, (size: number) => string]> = [
    ["a.a.a. repeated", (n) => "a.".repeat(n / 2)],
    ["a.a.a.@ then dots", (n) => "a.".repeat(n / 4) + "@" + "a.".repeat(n / 4)],
    ["local part with no @", (n) => "a".repeat(n)],
    ["many @ without a domain", (n) => "a@".repeat(n / 2)],
    ["@ and long domain with no TLD", (n) => "x@" + "a-".repeat(n / 2)],
    ["domain full of dots after @", (n) => "x@" + ".".repeat(n)],
    ["repeated user@host. with trailing digit", (n) => "u@h.a1 ".repeat(n / 7)],
    ["tld followed by underscore", (n) => "u@" + "h.".repeat(n / 4) + "ab_" + "x".repeat(n / 4)],
    ["digits and separators then underscore", (n) => "1 ".repeat(n / 2) + "_"],
    ["digit run then word char", (n) => "1".repeat(n) + "_"],
    ["pluses and digits", (n) => "+1".repeat(n / 2) + "_"],
    ["separators only", (n) => " -.".repeat(n / 3)],
    ["digits with nine-digit islands", (n) => "123456789 ".repeat(n / 10)],
    ["dates without boundary", (n) => "2026-08-05_".repeat(n / 11)],
    ["unicode", (n) => "é.".repeat(n / 2) + "😀@".repeat(n / 8)],
  ]
  it.each(shapes)("%s: 200 kB within the linear-time budget", (_name, build) => {
    const input = build(SIZE)
    expect(input.length).toBeGreaterThanOrEqual(SIZE / 2)
    expect(timed(() => redactSensitiveText(input))).toBeLessThan(BUDGET_MS)
    expect(timed(() => defaultAuditSanitizer({ nested: [input] }))).toBeLessThan(BUDGET_MS)
  })

  it("grows roughly linearly: 20x the input costs far less than 400x the time", () => {
    const small = "a.".repeat(5_000)
    const large = "a.".repeat(100_000)
    redactSensitiveText(small) // warm up
    const smallMs = Math.max(timed(() => redactSensitiveText(small)), 0.05)
    const largeMs = timed(() => redactSensitiveText(large))
    expect(largeMs).toBeLessThan(Math.max(smallMs * 20 * 6, 200))
  })

  it("redacts a contact detail embedded in a huge string", () => {
    const filler = "a.".repeat(100_000)
    expect(redactSensitiveText(`${filler} mail jane@example.com ${filler} 2026-08-05 ${filler}`)).toBe(`${filler} mail [redacted] ${filler} [redacted] ${filler}`)
  })
})
