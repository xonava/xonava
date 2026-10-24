import { createHash, createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import { ConfigurationError } from "../../domain/errors"
import { hmacSha256, hmacSha256Hex } from "../hmac"
import { sha256Hex } from "../sha256"
import { assertEntityVersion, assertEntityVersionCanIncrement, isEntityVersion } from "../version"

function caught(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value)
const bytes = (length: number, fill: number): Uint8Array => new Uint8Array(length).fill(fill)

describe("entity version mutation kills", () => {
  it("accepts exactly the non-negative safe integers", () => {
    expect(isEntityVersion(0)).toBe(true)
    expect(isEntityVersion(1)).toBe(true)
    expect(isEntityVersion(Number.MAX_SAFE_INTEGER)).toBe(true)
    expect(isEntityVersion(-1)).toBe(false)
    expect(isEntityVersion(-0.5)).toBe(false)
    expect(isEntityVersion(1.5)).toBe(false)
    expect(isEntityVersion(Number.MAX_SAFE_INTEGER + 1)).toBe(false)
    expect(isEntityVersion(Number.NaN)).toBe(false)
    expect(isEntityVersion(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isEntityVersion("1")).toBe(false)
    expect(isEntityVersion(1n)).toBe(false)
    expect(isEntityVersion(null)).toBe(false)
    expect(isEntityVersion(undefined)).toBe(false)
  })

  it("assertEntityVersion throws a ConfigurationError with the exact message", () => {
    for (const bad of [-1, 1.5, Number.NaN, "2", null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
      const error = caught(() => assertEntityVersion(bad))
      expect(error).toBeInstanceOf(ConfigurationError)
      expect((error as ConfigurationError).message).toBe("Entity version must be a non-negative safe integer.")
    }
    expect(caught(() => assertEntityVersion(0))).toBeUndefined()
  })

  it("assertEntityVersionCanIncrement validates the value before the increment limit", () => {
    for (const bad of [-1, 1.5, "1", undefined]) {
      const error = caught(() => assertEntityVersionCanIncrement(bad))
      expect(error).toBeInstanceOf(ConfigurationError)
      expect((error as ConfigurationError).message).toBe("Entity version must be a non-negative safe integer.")
    }
    const limit = caught(() => assertEntityVersionCanIncrement(Number.MAX_SAFE_INTEGER))
    expect(limit).toBeInstanceOf(ConfigurationError)
    expect((limit as ConfigurationError).message).toBe("Entity version cannot be incremented beyond the maximum safe integer.")
    expect(caught(() => assertEntityVersionCanIncrement(Number.MAX_SAFE_INTEGER - 1))).toBeUndefined()
    expect(caught(() => assertEntityVersionCanIncrement(0))).toBeUndefined()
  })
})

describe("hmac mutation kills", () => {
  it("rejects a non Uint8Array key or message with the exact TypeError", () => {
    for (const [key, message] of [
      ["key", utf8("m")],
      [utf8("k"), "message"],
      ["key", "message"],
      [undefined, undefined],
    ] as const) {
      const error = caught(() => hmacSha256(key as never, message as never))
      expect(error).toBeInstanceOf(TypeError)
      expect((error as TypeError).message).toBe("hmacSha256 expects Uint8Array key and message")
    }
    expect(caught(() => hmacSha256(new Uint8Array(0), new Uint8Array(0)))).toBeUndefined()
  })

  it("matches the platform HMAC at every key length around the block size", () => {
    for (const keyLength of [0, 1, 63, 64, 65, 66, 128, 129]) {
      const key = Uint8Array.from({ length: keyLength }, (_, index) => (index * 7 + 3) & 0xff)
      for (const messageLength of [0, 1, 55, 56, 64, 100]) {
        const message = Uint8Array.from({ length: messageLength }, (_, index) => (index * 13 + 5) & 0xff)
        const expected = createHmac("sha256", key).update(message).digest("hex")
        expect(hmacSha256Hex(key, message)).toBe(expected)
        expect(Buffer.from(hmacSha256(key, message)).toString("hex")).toBe(expected)
      }
    }
  })

  it("keeps a 64 byte key un-hashed and a 65 byte key hashed (distinct from each other)", () => {
    expect(hmacSha256Hex(bytes(64, 0xaa), utf8("x"))).toBe(createHmac("sha256", bytes(64, 0xaa)).update("x").digest("hex"))
    expect(hmacSha256Hex(bytes(65, 0xaa), utf8("x"))).toBe(createHmac("sha256", bytes(65, 0xaa)).update("x").digest("hex"))
    expect(hmacSha256Hex(bytes(64, 0xaa), utf8("x"))).not.toBe(hmacSha256Hex(bytes(65, 0xaa), utf8("x")))
  })

  it("returns a 32 byte digest, zero-padded lowercase hex of 64 characters", () => {
    const digest = hmacSha256(utf8("Jefe"), utf8("what do ya want for nothing?"))
    expect(digest).toBeInstanceOf(Uint8Array)
    expect(digest.length).toBe(32)
    const hex = hmacSha256Hex(utf8("Jefe"), utf8("what do ya want for nothing?"))
    expect(hex).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843")
    // a digest with a leading zero byte keeps its two hex digits
    let found = false
    for (let counter = 0; counter < 4000 && !found; counter++) {
      const message = utf8(`zero-${counter}`)
      const mac = hmacSha256(utf8("k"), message)
      if (mac.some((byte) => byte < 16)) {
        expect(hmacSha256Hex(utf8("k"), message)).toBe(createHmac("sha256", "k").update(message).digest("hex"))
        found = true
      }
    }
    expect(found).toBe(true)
  })

  it("does not modify the key or the message", () => {
    const key = bytes(70, 1)
    const message = bytes(10, 2)
    hmacSha256(key, message)
    expect([...key]).toEqual([...bytes(70, 1)])
    expect([...message]).toEqual([...bytes(10, 2)])
  })
})

describe("sha256 mutation kills", () => {
  it("hashes fixed vectors exactly, including padding boundaries", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(sha256Hex(utf8("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    for (const length of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000]) {
      const input = Uint8Array.from({ length }, (_, index) => (index * 31 + 7) & 0xff)
      expect(sha256Hex(input)).toBe(createHash("sha256").update(input).digest("hex"))
    }
  })
})
