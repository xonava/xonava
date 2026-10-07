import { describe, expect, it } from "vitest"
import { createHmac } from "node:crypto"
import { hmacSha256Hex } from "../hmac"

const hex = (value: string) => Uint8Array.from(value.match(/../g)!.map((pair) => Number.parseInt(pair, 16)))
const utf8 = (value: string) => new TextEncoder().encode(value)

describe("HMAC-SHA256", () => {
  it("matches the RFC 4231 test vectors", () => {
    const vectors: [Uint8Array, Uint8Array, string][] = [
      [hex("0b".repeat(20)), utf8("Hi There"), "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"],
      [utf8("Jefe"), utf8("what do ya want for nothing?"), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"],
      [hex("aa".repeat(20)), hex("dd".repeat(50)), "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"],
      [hex("aa".repeat(131)), utf8("Test Using Larger Than Block-Size Key - Hash Key First"), "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"],
    ]
    for (const [key, message, expected] of vectors) expect(hmacSha256Hex(key, message)).toBe(expected)
  })

  it("agrees with the platform implementation for generated inputs", () => {
    let seed = 7
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
    for (let iteration = 0; iteration < 200; iteration++) {
      const key = Uint8Array.from({ length: next() % 150 }, () => next() & 0xff)
      const message = Uint8Array.from({ length: next() % 300 }, () => next() & 0xff)
      expect(hmacSha256Hex(key, message)).toBe(createHmac("sha256", key).update(message).digest("hex"))
    }
  })
})

import { fingerprintWithDomainSeparator, fingerprintIdempotency } from "../fingerprint"
import { FINGERPRINT_DOMAIN_SEPARATORS } from "../../spec/versions"

describe("fingerprint domain separation", () => {
  it("accepts the framework separators unchanged", () => {
    for (const separator of Object.values(FINGERPRINT_DOMAIN_SEPARATORS)) expect(() => fingerprintWithDomainSeparator(separator, { a: 1 })).not.toThrow()
    expect(fingerprintIdempotency({ a: 1 })).toBe(fingerprintWithDomainSeparator(FINGERPRINT_DOMAIN_SEPARATORS.idempotency, { a: 1 }))
  })

  it("rejects separators that could make domain || value ambiguous", () => {
    for (const bad of ["", "app", "app:v1", "app:v1:x", "App:v1:", "app::v1:", "app:v1:{", "app v1:"]) expect(() => fingerprintWithDomainSeparator(bad, 1)).toThrow(/domainSeparator/)
    expect(() => fingerprintWithDomainSeparator("app:orders:v2:", 1)).not.toThrow()
  })
})
