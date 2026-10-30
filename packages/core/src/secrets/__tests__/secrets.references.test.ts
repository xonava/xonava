import { describe, expect, it } from "vitest"
import { ValidationError } from "../../domain/errors"
import { isSecretReference, secretReference } from "../secrets"

const M = "Secret references require non-empty provider, key and optional version."
const bad = (...args: unknown[]) => {
  try { (secretReference as (...a: unknown[]) => unknown)(...args) } catch (e) {
    expect(e).toBeInstanceOf(ValidationError)
    expect((e as Error).message).toBe(M)
    return
  }
  throw new Error("expected ValidationError")
}

describe("secretReference", () => {
  it("rejects non-string and blank parts", () => {
    bad(5, "k")
    bad("p", 5)
    bad(undefined, "k")
    bad("p", undefined)
    bad("", "k")
    bad("  ", "k")
    bad("p", "")
    bad("p", "  ")
    bad("p", "k", 5)
    bad("p", "k", "")
    bad("p", "k", "  ")
    bad("p", "k", null)
  })
  it("builds a frozen reference, omitting an absent version", () => {
    const plain = secretReference("p", "k")
    expect(plain).toStrictEqual({ provider: "p", key: "k" })
    expect("version" in plain).toBe(false)
    expect(Object.isFrozen(plain)).toBe(true)
    expect(secretReference("p", "k", "v2")).toStrictEqual({ provider: "p", key: "k", version: "v2" })
  })
})

describe("isSecretReference", () => {
  it("accepts only objects with non-blank provider and key and no value", () => {
    expect(isSecretReference(secretReference("p", "k"))).toBe(true)
    expect(isSecretReference({ provider: "p", key: "k" })).toBe(true)
    for (const v of [null, undefined, "x", 5, true, () => 1]) expect(isSecretReference(v)).toBe(false)
    expect(isSecretReference({})).toBe(false)
    expect(isSecretReference({ provider: "p" })).toBe(false)
    expect(isSecretReference({ key: "k" })).toBe(false)
    expect(isSecretReference({ provider: " ", key: "k" })).toBe(false)
    expect(isSecretReference({ provider: "", key: "k" })).toBe(false)
    expect(isSecretReference({ provider: "p", key: " " })).toBe(false)
    expect(isSecretReference({ provider: "p", key: "" })).toBe(false)
    expect(isSecretReference({ provider: 5, key: "k" })).toBe(false)
    expect(isSecretReference({ provider: "p", key: 5 })).toBe(false)
    expect(isSecretReference({ provider: "p", key: "k", value: "secret" })).toBe(false)
  })
})
