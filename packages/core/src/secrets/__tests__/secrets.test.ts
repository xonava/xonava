import { describe, expect, it } from "vitest"
import { ValidationError } from "../../domain/errors"
import { isSecretReference, secretReference } from "../secrets"

describe("secret references", () => {
  it("creates frozen opaque references without secret material", () => {
    const reference = secretReference("vault", "payments/key", "v2")
    expect(reference).toEqual({ provider: "vault", key: "payments/key", version: "v2" })
    expect(Object.isFrozen(reference)).toBe(true)
    expect(isSecretReference(reference)).toBe(true)
    expect(reference).not.toHaveProperty("value")
  })

  it.each([
    ["", "key", undefined], ["   ", "key", undefined], ["vault", "", undefined],
    ["vault", "  ", undefined], ["vault", "key", ""], ["vault", "key", "   "],
  ])("rejects an invalid provider/key/version tuple", (provider, key, version) => {
    expect(() => secretReference(provider, key, version)).toThrow(ValidationError)
  })

  it("rejects malformed references and objects containing secret values", () => {
    expect(isSecretReference(null)).toBe(false)
    expect(isSecretReference("vault:key")).toBe(false)
    expect(isSecretReference({ provider: 1, key: "key" })).toBe(false)
    expect(isSecretReference({ provider: "vault", key: 1 })).toBe(false)
    expect(isSecretReference({ provider: "vault", key: "key", value: "secret" })).toBe(false)
  })
})
