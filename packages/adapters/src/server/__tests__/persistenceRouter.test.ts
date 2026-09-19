import { describe, expect, it, vi } from "vitest"
import { TrustedPersistenceRouter } from "../persistenceRouter"

const tenantScope = { kind: "tenant" as const, tenantId: "tenant-a" }
const provider = { scope: tenantScope, scopeId: "scope", dialect: "pg", capabilities: {}, repository: vi.fn() }
describe("trusted persistence router", () => {
  it("routes only registered logical sources using trusted scope", async () => {
    const resolve = vi.fn(async () => provider as never)
    const router = new TrustedPersistenceRouter({ primary: { capabilities: { readConsistency: ["strong"], writable: true, localTransactions: true }, resolve } })
    await expect(router.resolve({ source: "primary", scope: tenantScope, access: "read", consistency: "strong" })).resolves.toBe(provider)
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ scope: tenantScope, source: "primary" }))
    await expect(router.resolve({ source: "client-injected", scope: tenantScope, access: "read", consistency: "strong" })).rejects.toThrow(/not registered/)
  })
  it("enforces write and consistency capabilities", async () => {
    const router = new TrustedPersistenceRouter({ replica: { capabilities: { readConsistency: ["eventual"], writable: false, localTransactions: false }, resolve: async () => provider as never } })
    await expect(router.resolve({ source: "replica", scope: tenantScope, access: "write", consistency: "eventual" })).rejects.toThrow(/read-only/)
    await expect(router.resolve({ source: "replica", scope: tenantScope, access: "read", consistency: "strong" })).rejects.toThrow(/does not prove/)
  })
})
