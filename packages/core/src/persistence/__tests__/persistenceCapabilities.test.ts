import { describe, expect, it, vi } from "vitest"
import {
  supportsAtomicBatch,
  supportsInteractiveTransactions,
  supportsTenantScopedAtomicBatch,
  type PersistenceProvider,
} from "../provider"

function base(capabilities: Partial<PersistenceProvider["capabilities"]> = {}): PersistenceProvider {
  const provider: PersistenceProvider = {
    dialect: "test",
    capabilities: {
      interactiveTransactions: false,
      atomicBatch: false,
      returningInsert: false,
      readSessions: false,
      jsonQueries: false,
      exactDecimal: false,
      persistentConnection: false,
      ...capabilities,
    },
    repository: vi.fn(),
  }
  return provider
}

describe("persistence capability guards", () => {
  it.each([
    ["no transaction flag", base(), false],
    ["flag without runner", base({ interactiveTransactions: true }), false],
    ["flag and runner", { ...base({ interactiveTransactions: true }), runInTransaction: vi.fn() }, true],
  ])("detects interactive transactions: %s", (_name, provider, expected) => {
    expect(supportsInteractiveTransactions(provider)).toBe(expected)
  })

  it("requires a function for the tenant command encoder", () => {
    const provider = {
      ...base({ atomicBatch: true, atomicBatchScope: "tenant-scoped" }),
      tenantId: "tenant-1",
      commandEncoder: { tenantId: "tenant-1", encode: "not-a-function" },
      executeAtomicBatch: vi.fn(),
    } as never
    expect(supportsAtomicBatch(provider)).toBe(false)
    expect(supportsTenantScopedAtomicBatch(provider)).toBe(false)
  })

  it.each([
    ["disabled", base(), false, false],
    ["unscoped with executor", { ...base({ atomicBatch: true }), executeAtomicBatch: vi.fn() }, true, false],
    ["tenant scoped incomplete", { ...base({ atomicBatch: true, atomicBatchScope: "tenant-scoped" }), executeAtomicBatch: vi.fn() }, false, false],
    ["tenant scoped complete", {
      ...base({ atomicBatch: true, atomicBatchScope: "tenant-scoped" }),
      tenantId: "tenant-1",
      commandEncoder: { tenantId: "tenant-1", encode: vi.fn() },
      executeAtomicBatch: vi.fn(),
    }, true, true],
    ["malformed scope", { ...base({ atomicBatch: true, atomicBatchScope: "global" as never }), executeAtomicBatch: vi.fn() }, false, false],
  ] as const)("detects atomic batches: %s", (_name, provider, expectedAtomic, expectedTenant) => {
    expect(supportsAtomicBatch(provider)).toBe(expectedAtomic)
    expect(supportsTenantScopedAtomicBatch(provider)).toBe(expectedTenant)
  })

  it("supports the explicit unscoped atomic batch scope", () => {
    const provider = { ...base({ atomicBatch: true, atomicBatchScope: "unscoped" }), executeAtomicBatch: vi.fn() }
    expect(supportsAtomicBatch(provider)).toBe(true)
    expect(supportsTenantScopedAtomicBatch(provider)).toBe(false)
  })
})
