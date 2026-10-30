import { describe, expect, it, vi } from "vitest"
import { ConfigurationError } from "@xonava/core/domain"
import { TrustedPersistenceRouter } from "../persistenceRouter"

const tenantA = { kind: "tenant" as const, tenantId: "tenant-a" }
const tenantB = { kind: "tenant" as const, tenantId: "tenant-b" }
const capabilities = { readConsistency: ["strong"], writable: true, localTransactions: true } as never

describe("TrustedPersistenceRouter", () => {
  it("rejects an empty binding registry with a ConfigurationError", () => {
    expect(() => new TrustedPersistenceRouter({})).toThrow(ConfigurationError)
    expect(() => new TrustedPersistenceRouter({})).toThrow("Persistence router requires at least one trusted datasource binding.")
  })

  it("rejects a provider for another tenant with the exact message", async () => {
    const router = new TrustedPersistenceRouter({ primary: { capabilities, resolve: async () => ({ scope: tenantB }) as never } })
    const failure = router.resolve({ source: "primary", scope: tenantA, access: "read", consistency: "strong" } as never)
    await expect(failure).rejects.toBeInstanceOf(ConfigurationError)
    await expect(failure).rejects.toThrow("Datasource 'primary' returned a provider for a different execution scope.")
  })

  it("rejects a binding that returns no provider, or a provider without a valid scope, as a ConfigurationError", async () => {
    const none = new TrustedPersistenceRouter({ primary: { capabilities, resolve: async () => undefined as never } })
    await expect(none.resolve({ source: "primary", scope: tenantA, access: "read", consistency: "strong" } as never)).rejects.toBeInstanceOf(ConfigurationError)
    const unscoped = new TrustedPersistenceRouter({ primary: { capabilities, resolve: async () => ({}) as never } })
    await expect(unscoped.resolve({ source: "primary", scope: undefined as never, access: "read", consistency: "strong" })).rejects.toBeInstanceOf(ConfigurationError)
    const malformed = new TrustedPersistenceRouter({ primary: { capabilities, resolve: async () => ({ scope: { kind: "tenant" } }) as never } })
    await expect(malformed.resolve({ source: "primary", scope: { kind: "tenant" } as never, access: "read", consistency: "strong" })).rejects.toBeInstanceOf(ConfigurationError)
  })

  it("hands the binding a frozen copy of the request and returns the provider for the same scope", async () => {
    const resolve = vi.fn(async () => ({ scope: { ...tenantA } }) as never)
    const router = new TrustedPersistenceRouter({ primary: { capabilities, resolve } })
    const request = { source: "primary", scope: tenantA, access: "write", consistency: "strong" } as never
    await router.resolve(request)
    const passed = (resolve.mock.calls[0] as unknown[])[0]
    expect(Object.isFrozen(passed)).toBe(true)
    expect(passed).not.toBe(request)
    expect(passed).toEqual(request)
  })
})
