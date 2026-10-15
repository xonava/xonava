import { describe, expect, it } from "vitest"
import { supportsAtomicBatch, type AtomicBatchPlan, type AtomicBatchProvider, type PersistenceProvider } from "@xonava/core/persistence"

type CreateUser = { kind: "create-user"; email: string }

describe("typed atomic batch plans", () => {
  it("preserves command typing and resolves ordered results", async () => {
    let receivedEmail: string | undefined
    const executeAtomicBatch = async (plan: AtomicBatchPlan<CreateUser>) => {
      const command = plan.items[0]
      expect(command?.kind).toBe("command")
      if (command?.kind === "command") receivedEmail = command.command.email
      return [{ kind: "command" as const, result: { id: "user-1" } }]
    }

    const provider: AtomicBatchProvider<CreateUser> & PersistenceProvider = {
      dialect: "memory",
      capabilities: {
        interactiveTransactions: false,
        atomicBatch: true,
        returningInsert: false,
        readSessions: false,
        jsonQueries: false,
        exactDecimal: false,
        persistentConnection: false,
      },
      repository: (() => ({
        findById: async () => null,
        findMany: async () => ({ rows: [], rowCount: 0, page: 1, pageSize: 10 }),
        insert: async () => ({ id: "user-1" }),
        update: async () => ({ id: "user-1" }),
        delete: async () => undefined,
      })),
      executeAtomicBatch,
    }

    const plan: AtomicBatchPlan<CreateUser> = {
      items: [{ kind: "command", command: { kind: "create-user", email: "a@example.com" } }],
    }

    expect(supportsAtomicBatch(provider)).toBe(true)
    await expect(provider.executeAtomicBatch(plan)).resolves.toEqual([{ kind: "command", result: { id: "user-1" } }])
    expect(receivedEmail).toBe("a@example.com")
  })

  it("does not treat a raw provider with atomic capability alone as atomic-batch capable", () => {
    const provider = {
      dialect: "memory",
      capabilities: {
        interactiveTransactions: false,
        atomicBatch: true,
        returningInsert: false,
        readSessions: false,
        jsonQueries: false,
        exactDecimal: false,
        persistentConnection: false,
      },
      repository: (() => ({})) as unknown as AtomicBatchProvider<CreateUser>["repository"],
    }

    expect(supportsAtomicBatch(provider)).toBe(false)
  })
})
