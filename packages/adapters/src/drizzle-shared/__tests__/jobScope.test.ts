import { describe, expect, it } from "vitest"
import { decodePersistedJobScope, encodeJobScope, readPersistedScopeKey } from "../jobScope"

describe("job scope persistence", () => {
  it("keeps the exact platform and system key", () => {
    expect(encodeJobScope({ kind: "platform", platformKey: "tenantless-a" })).toEqual({ scope: "platform", tenantId: null, scopeKey: "tenantless-a" })
    expect(encodeJobScope({ kind: "system", systemKey: "probe" })).toEqual({ scope: "system", tenantId: null, scopeKey: "probe" })
    expect(decodePersistedJobScope("platform", null, "tenantless-a")).toEqual({ kind: "platform", platformKey: "tenantless-a" })
    expect(decodePersistedJobScope("system", null, "probe")).toEqual({ kind: "system", systemKey: "probe" })
  })

  it("stores the framework defaults and tenant scopes without a key, and decodes a missing key to the defaults", () => {
    expect(encodeJobScope({ kind: "platform", platformKey: "default" }).scopeKey).toBeNull()
    expect(encodeJobScope({ kind: "system", systemKey: "framework" }).scopeKey).toBeNull()
    expect(encodeJobScope({ kind: "tenant", tenantId: "t1" })).toEqual({ scope: "tenant", tenantId: "t1", scopeKey: null })
    expect(decodePersistedJobScope("platform", null)).toEqual({ kind: "platform", platformKey: "default" })
    expect(decodePersistedJobScope("system", null, null)).toEqual({ kind: "system", systemKey: "framework" })
    expect(readPersistedScopeKey(undefined)).toBeNull()
    expect(readPersistedScopeKey(null)).toBeNull()
    expect(readPersistedScopeKey("probe")).toBe("probe")
  })

  it("refuses inconsistent persisted rows and over-long keys", () => {
    expect(() => decodePersistedJobScope("tenant", "t1", "probe")).toThrow(/platform\/system key/)
    expect(() => decodePersistedJobScope("platform", "t1", null)).toThrow(/tenant identity/)
    expect(() => decodePersistedJobScope("system", null, "  ")).toThrow(/blank scope key/)
    expect(() => encodeJobScope({ kind: "platform", platformKey: "k".repeat(101) })).toThrow()
  })
})
