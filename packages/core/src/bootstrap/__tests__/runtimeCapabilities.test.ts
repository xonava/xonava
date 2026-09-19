import { describe, expect, it } from "vitest"
import { requireCapability } from "../runtimeCapabilities"
import { RuntimeCapabilityError } from "../../domain"

describe("runtime capabilities", () => {
  it("accepts enabled capabilities", () => {
    expect(() => requireCapability({ cache: true }, "cache")).not.toThrow()
  })

  it("throws a structured error for unavailable capabilities", () => {
    expect(() => requireCapability({ cache: false }, "cache"))
      .toThrow(RuntimeCapabilityError)
    try {
      requireCapability({ cache: false }, "cache")
    } catch (error) {
      expect(error).toMatchObject({ details: { capability: "cache" } })
    }
  })
})
