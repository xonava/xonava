// @ts-nocheck
import { describe, expect, it } from "vitest"
import { redactPhiDeep } from "../redact"

describe("redactPhiDeep hardening", () => {
  it("treats a __proto__ key as data instead of changing the prototype", () => {
    const input = JSON.parse('{"__proto__":{"polluted":"alice@example.com"},"ok":1}') as unknown
    const result = redactPhiDeep(input) as Record<string, unknown>
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect((result as { polluted?: unknown }).polluted).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toEqual({ polluted: "[email redacted]" })
  })

  it("bounds depth and cycles", () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect((redactPhiDeep(cyclic) as Record<string, unknown>).self).toBe("[Redacted]")
    let deep: unknown = "x"
    for (let i = 0; i < 10_000; i++) deep = { n: deep }
    expect(() => redactPhiDeep(deep)).not.toThrow()
  })
})
