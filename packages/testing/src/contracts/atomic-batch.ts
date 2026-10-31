import { beforeEach, describe, expect, it } from "vitest"
import type { AtomicBatchCapableProvider, AtomicBatchPlan, PersistenceProvider } from "@xonava/core/persistence"

export interface AtomicBatchContractOptions<TCommand> {
  createProvider: () => PersistenceProvider
  createAtomicProvider: (provider: PersistenceProvider) => AtomicBatchCapableProvider<TCommand>
  createAtomicPlan: () => AtomicBatchPlan<TCommand>
  beforeEach?: () => void | Promise<void>
}

/** Runs the atomic command/audit/outbox ordering contract independently of CRUD persistence. */
export function runAtomicBatchContractTests<TCommand>(
  label: string,
  options: AtomicBatchContractOptions<TCommand>,
): void {
  describe(`Atomic batch contract: ${label}`, { concurrent: false }, () => {
    let provider: PersistenceProvider

    beforeEach(() => {
      provider = options.createProvider()
      return options.beforeEach?.()
    })

    it("executes command, audit, and outbox items in plan order", async () => {
      const plan = options.createAtomicPlan()
      const result = await options.createAtomicProvider(provider).executeAtomicBatch(plan)

      expect(result).toHaveLength(plan.items.length)
      expect(result.map((item) => item.kind)).toEqual(plan.items.map((item) => item.kind))
    })
  })
}
