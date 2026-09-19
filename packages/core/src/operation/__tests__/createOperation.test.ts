import { describe, expect, it } from "vitest"
import { createOperation } from "../createOperation"
import { createOperationContext } from "../operationContext"
import type { PersistenceProvider } from "../../persistence"

function operationContext() {
  const persistence: PersistenceProvider = {
    dialect: "test",
    capabilities: { interactiveTransactions: false, atomicBatch: false, returningInsert: false, readSessions: false, jsonQueries: false, exactDecimal: false, persistentConnection: false },
    repository: () => { throw new Error("not used") },
  }
  return createOperationContext({ persistence, runtimeCapabilities: { deferredExecution: true, cache: false } })
}

describe("createOperation", () => {
  it("rejects invalid definitions before creating a runner", () => {
    expect(() => createOperation({ key: "", kind: "read", execute: async () => "done" })).toThrow(/key must be non-empty/i)
  })

  it("freezes the definition exposed by the runner", () => {
    const runner = createOperation({ key: "frozen", kind: "read", execute: async () => "done" })
    expect(Object.isFrozen(runner.definition)).toBe(true)
  })

  it("runs both public runner methods", async () => {
    const runner = createOperation({ key: "run", kind: "read", execute: async ({ input }) => ({ input }) })
    await expect(runner.run({ operation: operationContext(), input: "value" })).resolves.toEqual({ input: "value" })
    await expect(runner.runDetailed({ operation: operationContext(), input: "value" })).resolves.toMatchObject({ result: { input: "value" } })
  })
})
