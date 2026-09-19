import { describe, expect, it } from "vitest"
import { assertRuntimeCapability, isRuntimeCapability, requireCapability } from "../runtimeCapabilities"
import { RuntimeCapabilityError } from "../../domain"

describe("runtime capability closed universe (P1-02)", () => {
  it("recognizes every known runtime capability", () => {
    expect(isRuntimeCapability("deferredExecution")).toBe(true)
    expect(isRuntimeCapability("objectStore")).toBe(true)
    expect(isRuntimeCapability("cache")).toBe(true)
  })

  it("rejects unknown runtime capability names", () => {
    expect(isRuntimeCapability("deferred_execution")).toBe(false)
    expect(isRuntimeCapability("cache")).toBe(true)
    expect(isRuntimeCapability("bypassAuthority")).toBe(false)
    expect(isRuntimeCapability("")).toBe(false)
  })

  it("asserts known names without throwing", () => {
    expect(() => assertRuntimeCapability("deferredExecution")).not.toThrow()
    expect(() => assertRuntimeCapability("cache")).not.toThrow()
  })

  it.each(["deferred_execution", "bypassAuthority", "undefined", ""])(
    "throws RuntimeCapabilityError for unknown name %s",
    (name) => {
      expect(() => assertRuntimeCapability(name)).toThrow(RuntimeCapabilityError)
      try {
        assertRuntimeCapability(name)
      } catch (error) {
        expect(error).toMatchObject({ code: "RUNTIME_CAPABILITY_REQUIRED", details: { capability: name } })
      }
    },
  )

  it("keeps requireCapability usable for non-runtime capability sets", () => {
    const persistenceCapabilities = { interactiveTransactions: true, atomicBatch: false }
    expect(() => requireCapability(persistenceCapabilities, "interactiveTransactions")).not.toThrow()
    expect(() => requireCapability(persistenceCapabilities, "atomicBatch")).toThrow(RuntimeCapabilityError)
  })
})
