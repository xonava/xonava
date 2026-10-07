import { describe, expect, it, vi } from "vitest"
import type { PersistenceProvider } from "../../persistence"
import { AggregateInvariantError, assertAggregateInvariants, assertAggregateTransition, compileAggregate, isCompiledAggregate, runAggregateTransaction } from ".."

type State = { order: { total: number }; payments: readonly { amount: number }[] }
const definition = () => compileAggregate<State>({
  key: "orders.payment", version: 1, members: ["order", "payments"],
  invariants: [
    { key: "nonnegative-total", phase: "both", check: state => state.order.total >= 0 },
    { key: "payments-within-total", phase: "after", check: state => state.payments.reduce((sum, payment) => sum + payment.amount, 0) <= state.order.total },
  ],
})

describe("aggregate consistency boundaries", () => {
  it("compiles an immutable named boundary", () => {
    const compiled = definition()
    expect(isCompiledAggregate(compiled)).toBe(true)
    expect(Object.isFrozen(compiled)).toBe(true)
    expect(Object.isFrozen(compiled.members)).toBe(true)
    expect(Object.isFrozen(compiled.invariants)).toBe(true)
  })

  it("validates both sides of an atomic-batch transition", () => {
    const transition = assertAggregateTransition(definition(), { order: { total: 100 }, payments: [] }, { order: { total: 100 }, payments: [{ amount: 100 }] })
    expect(transition.after.payments).toHaveLength(1)
  })

  it("deeply copies and freezes snapshots before invariant code receives them", () => {
    const source: State = { order: { total: 100 }, payments: [{ amount: 10 }] }
    const checked = assertAggregateInvariants(definition(), source, "after")
    expect(Object.isFrozen(checked.order)).toBe(true)
    expect(Object.isFrozen(checked.payments)).toBe(true)
    expect(Object.isFrozen(checked.payments[0])).toBe(true)
    source.order.total = 0
    expect(checked.order.total).toBe(100)
  })

  it("rejects mutable class instances and cycles in authoritative snapshots", () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    expect(() => assertAggregateInvariants(compileAggregate({ key: "a", version: 1, members: ["x"], invariants: [{ key: "ok", phase: "both", check: () => true }] }), { x: cyclic }, "before")).toThrow(/cycles/)
    expect(() => assertAggregateInvariants(compileAggregate({ key: "a", version: 1, members: ["x"], invariants: [{ key: "ok", phase: "both", check: () => true }] }), { x: new Date() }, "before")).toThrow(/plain records/)
  })

  it("rejects an invalid proposed transition before commit", () => {
    expect(() => assertAggregateTransition(definition(), { order: { total: 100 }, payments: [] }, { order: { total: 100 }, payments: [{ amount: 101 }] })).toThrow(AggregateInvariantError)
  })

  it("runs both loads and mutation inside the same serializable transaction", async () => {
    let state: State = { order: { total: 100 }, payments: [] }
    const scoped = { dialect: "scoped", capabilities: { interactiveTransactions: true } } as unknown as PersistenceProvider
    const runInTransaction = vi.fn(async (work: (provider: PersistenceProvider) => Promise<unknown>, options: unknown) => work(scoped))
    const provider = { dialect: "root", capabilities: { interactiveTransactions: true }, runInTransaction } as unknown as PersistenceProvider
    const load = vi.fn(async (received: PersistenceProvider) => { expect(received).toBe(scoped); return state })
    const mutate = vi.fn(async (received: PersistenceProvider) => { expect(received).toBe(scoped); state = { ...state, payments: [{ amount: 75 }] }; return "paid" })
    const result = await runAggregateTransaction({ definition: definition(), persistence: provider, load, mutate })
    expect(result.result).toBe("paid")
    expect(result.after.payments).toHaveLength(1)
    expect(load).toHaveBeenCalledTimes(2)
    expect(runInTransaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "serializable", accessMode: "read write" })
  })

  it("throws inside the transaction so the provider can roll back", async () => {
    let rolledBack = false
    let state: State = { order: { total: 100 }, payments: [] }
    const provider = {
      dialect: "test", capabilities: { interactiveTransactions: true },
      runInTransaction: async (work: (provider: PersistenceProvider) => Promise<unknown>) => {
        try { return await work(provider as unknown as PersistenceProvider) } catch (error) { rolledBack = true; throw error }
      },
    } as unknown as PersistenceProvider
    await expect(runAggregateTransaction({
      definition: definition(), persistence: provider, load: async () => state,
      mutate: async () => { state = { order: { total: 100 }, payments: [{ amount: 101 }] }; return undefined },
    })).rejects.toBeInstanceOf(AggregateInvariantError)
    expect(rolledBack).toBe(true)
  })

  it("supports phase-specific invariants", () => {
    const compiled = definition()
    expect(() => assertAggregateInvariants(compiled, { order: { total: 100 }, payments: [{ amount: 101 }] }, "before")).not.toThrow()
    expect(() => assertAggregateInvariants(compiled, { order: { total: 100 }, payments: [{ amount: 101 }] }, "after")).toThrow(/invariant/i)
  })

  it("requires exact declared snapshot membership", () => {
    expect(() => assertAggregateInvariants(definition(), { order: { total: 1 } } as State, "before")).toThrow(/missing member/)
    expect(() => assertAggregateInvariants(definition(), { order: { total: 1 }, payments: [], customer: {} } as State, "before")).toThrow(/undeclared member/)
  })

  it("rejects uncompiled definitions and providers without transactions", async () => {
    const raw = { key: "a", version: 1, members: ["a"], invariants: [{ key: "ok", phase: "both", check: () => true }] }
    expect(() => assertAggregateInvariants(raw as never, { a: {} }, "before")).toThrow(/compiled/)
    await expect(runAggregateTransaction({ definition: definition(), persistence: { dialect: "x", capabilities: {} } as PersistenceProvider, load: vi.fn(), mutate: vi.fn() })).rejects.toThrow(/interactive transaction/)
  })

  it.each([
    { key: "", version: 1, members: ["a"], invariants: [{ key: "ok", phase: "both", check: () => true }] },
    { key: "a", version: 0, members: ["a"], invariants: [{ key: "ok", phase: "both", check: () => true }] },
    { key: "a", version: 1, members: [], invariants: [{ key: "ok", phase: "both", check: () => true }] },
    { key: "a", version: 1, members: ["x", "x"], invariants: [{ key: "ok", phase: "both", check: () => true }] },
    { key: "a", version: 1, members: ["x"], invariants: [] },
  ])("rejects malformed aggregate definitions %#", value => expect(() => compileAggregate(value as never)).toThrow())

  it("normalizes invariant exceptions as configuration failures", () => {
    const compiled = compileAggregate({ key: "a", version: 1, members: ["x"], invariants: [{ key: "throws", phase: "both", check: () => { throw new Error("secret") } }] })
    expect(() => assertAggregateInvariants(compiled, { x: {} }, "before")).toThrow(/threw during evaluation/)
  })
})

describe("aggregate snapshots with shared references (final pass)", () => {
  it("accepts an object referenced twice and still rejects real cycles", () => {
    const definition = compileAggregate({ key: "shared", version: 1, members: ["lines"], invariants: [{ key: "ok", phase: "both", check: () => true }] })
    const line = { sku: "a" }
    expect(() => assertAggregateInvariants(definition, { lines: [line, line] }, "before")).not.toThrow()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => assertAggregateInvariants(definition, { lines: cyclic }, "before")).toThrow(/cycles/)
  })
})
