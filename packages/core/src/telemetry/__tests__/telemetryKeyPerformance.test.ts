import { describe, expect, it } from "vitest"
import { boundedTelemetryAttributes, isSensitiveTelemetryKey, SENSITIVE_TELEMETRY_KEY_PATTERNS, SENSITIVE_TELEMETRY_KEY_SEGMENTS } from "../telemetry"

/** The original implementation, with its backtracking camel-case splitter, as an oracle for SHORT keys. */
function referenceIsSensitive(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[\s_.-]/g, "")
  if (SENSITIVE_TELEMETRY_KEY_PATTERNS.some((pattern) => normalized.includes(pattern))) return true
  const segments = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").toLowerCase().split(/[\s_.-]+/)
  return segments.some((segment) => SENSITIVE_TELEMETRY_KEY_SEGMENTS.includes(segment))
}

function timed(fn: () => void): number {
  const started = performance.now()
  fn()
  return performance.now() - started
}

describe("isSensitiveTelemetryKey", () => {
  it("agrees with the original implementation on ordinary keys", () => {
    for (const key of ["authHeader", "x-auth", "author", "otp_code", "userOTP", "footprint", "AUTHToken", "XMLAuthHeader", "myOTPValue", "OTP", "auth", "Auth", "aAuth", "a1Otp", "order.id", "ORDERId", "", "_", "ÉAuth", "İAuth"]) {
      expect(isSensitiveTelemetryKey(key), key).toBe(referenceIsSensitive(key))
    }
    expect(isSensitiveTelemetryKey("authHeader")).toBe(true)
    expect(isSensitiveTelemetryKey("author")).toBe(false)
    expect(isSensitiveTelemetryKey("userOTP")).toBe(true)
  })

  it("agrees with the original implementation on 40,000 random short keys", () => {
    let state = 7
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32 }
    const alphabet = ["a", "A", "u", "U", "t", "T", "h", "H", "o", "O", "p", "P", "_", "-", ".", " ", "1", "0", "z", "Z"]
    for (let run = 0; run < 40_000; run += 1) {
      let key = ""
      const length = Math.floor(random() * 14)
      for (let i = 0; i < length; i += 1) key += alphabet[Math.floor(random() * alphabet.length)]
      if (isSensitiveTelemetryKey(key) !== referenceIsSensitive(key)) expect.fail(`diverged on ${JSON.stringify(key)}`)
    }
  })

  it.each([
    ["capitals then a digit", (n: number) => "AB".repeat(n / 2) + "1"],
    ["capitals only", (n: number) => "A".repeat(n)],
    ["capital runs separated by lower-case", (n: number) => "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!".repeat(n / 58)],
    ["camelCase words", (n: number) => "aB".repeat(n / 2)],
    ["separators", (n: number) => "a._-".repeat(n / 4)],
  ])("%s: a 200 kB key is classified well under half a second", (_name, build) => {
    const key = build(200_000)
    expect(timed(() => isSensitiveTelemetryKey(key))).toBeLessThan(500)
  })

  it("still finds a whole-segment secret word inside a huge key", () => {
    expect(isSensitiveTelemetryKey(`${"A".repeat(100_000)}Auth${"b".repeat(100)}`)).toBe(false)
    expect(isSensitiveTelemetryKey(`${"A".repeat(100_000)}_auth_${"b".repeat(100)}`)).toBe(true)
  })

  it("boundedTelemetryAttributes ignores over-long keys without scanning them", () => {
    expect(timed(() => boundedTelemetryAttributes("m", { ["A".repeat(200_000)]: "v" }))).toBeLessThan(500)
  })
})
