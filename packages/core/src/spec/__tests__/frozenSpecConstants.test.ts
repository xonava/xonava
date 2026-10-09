import { describe, expect, it } from "vitest"
import { CANONICAL_JSON_LIMITS_V1, FORMAT_DEFAULT_MAX_CANONICAL_BYTES } from "../formatVersions"
import { V1_REQUIRED_GUARANTEES } from "../guarantees"
import { FINGERPRINT_DOMAIN_SEPARATORS } from "../versions"

describe("spec constants are immutable at runtime", () => {
  it("freezes canonical JSON limits and format byte ceilings", () => {
    expect(Object.isFrozen(CANONICAL_JSON_LIMITS_V1)).toBe(true)
    expect(Object.isFrozen(FORMAT_DEFAULT_MAX_CANONICAL_BYTES)).toBe(true)
    expect(() => { (CANONICAL_JSON_LIMITS_V1 as { maxDepth: number }).maxDepth = 1_000_000 }).toThrow(TypeError)
    expect(CANONICAL_JSON_LIMITS_V1.maxDepth).toBe(64)
  })

  it("freezes fingerprint domain separators", () => {
    expect(Object.isFrozen(FINGERPRINT_DOMAIN_SEPARATORS)).toBe(true)
  })

  it("deep-freezes the required guarantee lists", () => {
    expect(Object.isFrozen(V1_REQUIRED_GUARANTEES)).toBe(true)
    for (const list of Object.values(V1_REQUIRED_GUARANTEES)) expect(Object.isFrozen(list)).toBe(true)
  })
})
