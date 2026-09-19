import { describe, expect, it } from "vitest"
import { sha256Bytes, sha256Hex } from "../sha256"

const encode = (value: string): Uint8Array => new TextEncoder().encode(value)

describe("dependency-free SHA-256", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"],
  ])("matches the FIPS vector for %j", (message, digest) => {
    expect(sha256Hex(encode(message))).toBe(digest)
  })

  it("matches the million-a stress vector", () => {
    expect(sha256Hex(encode("a".repeat(1_000_000)))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    )
  })

  it("returns bytes without mutating the input", () => {
    const input = encode("portable core")
    const original = input.slice()
    const digest = sha256Bytes(input)
    expect(input).toEqual(original)
    expect(digest).toHaveLength(32)
    expect(digest).not.toBe(input)
  })
})
