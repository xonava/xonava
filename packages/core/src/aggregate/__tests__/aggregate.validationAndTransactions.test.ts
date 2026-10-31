import { describe, expect, it, vi } from "vitest"
import { ConfigurationError } from "../../domain"
import type { PersistenceProvider } from "../../persistence"
import { AggregateInvariantError, assertAggregateInvariants, assertAggregateTransition, compileAggregate, isCompiledAggregate, runAggregateTransaction } from ".."

const ok = { key: "inv", phase: "both", check: () => true } as const
const def = (o: Record<string, unknown> = {}) => ({ key: "agg", version: 1, members: ["a"], invariants: [ok], ...o })
const rejects = (value: unknown, message: string) => expect(() => compileAggregate(value as never)).toThrow(new ConfigurationError(message))

describe("compileAggregate validation", () => {
  it("validates key and version", () => {
    for (const v of [null, undefined, "x", 5]) rejects(v, "Aggregate key is invalid")
    for (const key of ["", "-a", "a b", "a".repeat(201), 5]) rejects(def({ key }), "Aggregate key is invalid")
    for (const version of [0, -1, 1.5, Number.NaN]) rejects(def({ version }), "Aggregate version must be a positive safe integer")
    expect(compileAggregate(def({ key: "a".repeat(200) })).key).toHaveLength(200)
  })
  it("bounds member and invariant counts inclusively", () => {
    const m = "Aggregate must declare between 1 and 100 members"
    rejects(def({ members: [] }), m)
    rejects(def({ members: "a" }), m)
    rejects(def({ members: Array.from({ length: 101 }, (_, i) => `m${i}`) }), m)
    expect(compileAggregate(def({ members: Array.from({ length: 100 }, (_, i) => `m${i}`) })).members).toHaveLength(100)
    const i = "Aggregate must declare between 1 and 100 invariants"
    rejects(def({ invariants: [] }), i)
    rejects(def({ invariants: "x" }), i)
    rejects(def({ invariants: Array.from({ length: 101 }, (_, n) => ({ ...ok, key: `i${n}` })) }), i)
    expect(compileAggregate(def({ invariants: Array.from({ length: 100 }, (_, n) => ({ ...ok, key: `i${n}` })) })).invariants).toHaveLength(100)
  })
  it("requires unique valid member keys", () => {
    const m = "Aggregate members must be unique valid keys"
    rejects(def({ members: ["a", "a"] }), m)
    rejects(def({ members: ["a b"] }), m)
    rejects(def({ members: [5] }), m)
    rejects(def({ members: ["ok", ""] }), m)
    rejects(def({ members: ["ok", 5] }), m)
    expect(compileAggregate(def({ members: ["a", "b"] })).members).toEqual(["a", "b"])
  })
  it("requires unique valid invariant keys, a known phase and a check function", () => {
    const k = "Aggregate invariant keys must be unique valid keys"
    rejects(def({ invariants: [null] }), k)
    rejects(def({ invariants: [{ ...ok, key: "bad key" }] }), k)
    rejects(def({ invariants: [{ ...ok, key: 5 }] }), k)
    rejects(def({ invariants: [ok, ok] }), k)
    rejects(def({ invariants: [ok, { ...ok, key: "other" }, { ...ok, key: "inv" }] }), k)
    rejects(def({ invariants: [{ ...ok, phase: "during" }] }), 'Aggregate invariant "inv" is invalid')
    rejects(def({ invariants: [{ ...ok, check: "no" }] }), 'Aggregate invariant "inv" is invalid')
    for (const phase of ["before", "after", "both"]) expect(compileAggregate(def({ invariants: [{ ...ok, phase }] })).invariants[0]!.phase).toBe(phase)
  })
  it("returns a frozen compiled definition recognised only by identity", () => {
    const input = def({ members: ["a", "b"] })
    const compiled = compileAggregate(input as never)
    expect(isCompiledAggregate(compiled)).toBe(true)
    expect(isCompiledAggregate({ ...compiled })).toBe(false)
    expect(isCompiledAggregate(null)).toBe(false)
    expect(isCompiledAggregate(5)).toBe(false)
    expect(compiled.members).not.toBe(input.members)
    expect(Object.isFrozen(compiled)).toBe(true)
    expect(Object.isFrozen(compiled.members)).toBe(true)
    expect(Object.isFrozen(compiled.invariants)).toBe(true)
    expect(Object.isFrozen(compiled.invariants[0])).toBe(true)
    expect(Object.keys(compiled.invariants[0]!).sort()).toEqual(["check", "key", "phase"])
    expect(compiled.version).toBe(1)
  })
})

describe("aggregate snapshots", () => {
  const compiled = compileAggregate({ key: "agg", version: 1, members: ["a", "b"], invariants: [ok] })
  const run = (value: unknown) => assertAggregateInvariants(compiled, value as never, "before")
  it("requires a record with exactly the declared members", () => {
    for (const v of [null, undefined, "x", 5, [1, 2]]) expect(() => run(v)).toThrow(new ConfigurationError("Aggregate snapshot must be a record"))
    expect(() => run({ a: 1 })).toThrow(new ConfigurationError('Aggregate snapshot is missing member "b"'))
    expect(() => run({ a: 1, b: 2, c: 3 })).toThrow(new ConfigurationError('Aggregate snapshot contains undeclared member "c"'))
  })
  it("deep-freezes copies of primitive, array and plain-record members", () => {
    const input = { a: 5, b: { list: [1, { x: "y" }], nul: null } }
    const out = run(input) as { a: number; b: { list: [number, { x: string }]; nul: null } }
    expect(out.a).toBe(5)
    expect(out.b.nul).toBeNull()
    expect(out.b).not.toBe(input.b)
    expect(Object.isFrozen(out)).toBe(true)
    expect(Object.isFrozen(out.b)).toBe(true)
    expect(Object.isFrozen(out.b.list)).toBe(true)
    expect(Object.isFrozen(out.b.list[1])).toBe(true)
    expect(Object.getPrototypeOf(out.b)).toBeNull()
    expect(run({ a: "s", b: undefined })).toEqual({ a: "s", b: undefined })
  })
  it("rejects non-plain values and cycles but allows shared references", () => {
    const m = new ConfigurationError("Aggregate snapshot values must be plain records and arrays")
    class Box { x = 1 }
    expect(() => run({ a: new Box(), b: 1 })).toThrow(m)
    expect(() => run({ a: new Date(), b: 1 })).toThrow(m)
    expect(() => run({ a: [new Map()], b: 1 })).toThrow(m)
    expect(run({ a: Object.assign(Object.create(null), { x: 1 }), b: 1 })).toEqual({ a: { x: 1 }, b: 1 })
    const cyc: Record<string, unknown> = {}
    cyc["self"] = cyc
    expect(() => run({ a: cyc, b: 1 })).toThrow(new ConfigurationError("Aggregate snapshot must not contain cycles"))
    const arrCycle: unknown[] = []
    arrCycle.push(arrCycle)
    expect(() => run({ a: arrCycle, b: 1 })).toThrow(new ConfigurationError("Aggregate snapshot must not contain cycles"))
    const shared = { v: 1 }
    const out = run({ a: shared, b: [shared, shared] }) as { a: object; b: object[] }
    expect(out.b[0]).toEqual({ v: 1 })
    expect(out.b[1]).toEqual({ v: 1 })
  })
})

describe("aggregate invariants", () => {
  const phased = compileAggregate<{ x: number; y: number }>({
    key: "agg", version: 1, members: ["x", "y"],
    invariants: [
      { key: "x-before", phase: "before", check: s => s.x >= 0 },
      { key: "y-after", phase: "after", check: s => s.y >= 0 },
      { key: "sum-both", phase: "both", check: s => s.x + s.y < 100 },
    ],
  })
  it("reports the failing invariant, aggregate and phase", () => {
    try { assertAggregateInvariants(phased, { x: -1, y: 0 }, "before") } catch (e) {
      expect(e).toBeInstanceOf(AggregateInvariantError)
      const err = e as AggregateInvariantError
      expect(err.message).toBe("Aggregate invariant failed")
      expect([err.aggregateKey, err.invariantKey, err.phase]).toEqual(["agg", "x-before", "before"])
      expect(err.details).toEqual({ aggregateKey: "agg", invariantKey: "x-before", phase: "before" })
      return
    }
    throw new Error("expected failure")
  })
  it("only evaluates invariants for the active phase and requires a strict true", () => {
    expect(() => assertAggregateInvariants(phased, { x: 0, y: -1 }, "before")).not.toThrow()
    expect(() => assertAggregateInvariants(phased, { x: -1, y: 0 }, "after")).not.toThrow()
    expect(() => assertAggregateInvariants(phased, { x: 0, y: -1 }, "after")).toThrow(AggregateInvariantError)
    expect(() => assertAggregateInvariants(phased, { x: 60, y: 60 }, "before")).toThrow(AggregateInvariantError)
    expect(() => assertAggregateInvariants(phased, { x: 60, y: 60 }, "after")).toThrow(AggregateInvariantError)
    const truthy = compileAggregate({ key: "t", version: 1, members: ["x"], invariants: [{ key: "truthy", phase: "both", check: (() => 1) as never }] })
    expect(() => assertAggregateInvariants(truthy, { x: 1 }, "before")).toThrow(AggregateInvariantError)
  })
  it("wraps thrown checks with the invariant key and cause", () => {
    const cause = new Error("boom")
    const c = compileAggregate({ key: "t", version: 1, members: ["x"], invariants: [{ key: "bad", phase: "both", check: () => { throw cause } }] })
    try { assertAggregateInvariants(c, { x: 1 }, "before") } catch (e) {
      expect(e).toBeInstanceOf(ConfigurationError)
      expect((e as Error).message).toBe('Aggregate invariant "bad" threw during evaluation')
      expect((e as Error).cause).toBe(cause)
      return
    }
    throw new Error("expected failure")
  })
  it("requires a compiled definition", () => {
    expect(() => assertAggregateInvariants({ ...phased } as never, { x: 0, y: 0 }, "before")).toThrow(new ConfigurationError("Aggregate invariant evaluation requires a compiled aggregate"))
  })
  it("checks a transition with before and after phases and returns frozen snapshots", () => {
    const t = assertAggregateTransition(phased, { x: 0, y: -5 }, { x: -5, y: 0 })
    expect(t.before).toEqual({ x: 0, y: -5 })
    expect(t.after).toEqual({ x: -5, y: 0 })
    expect(Object.isFrozen(t)).toBe(true)
    const phaseOf = (fn: () => unknown) => { try { fn() } catch (e) { return (e as AggregateInvariantError).phase } return undefined }
    expect(phaseOf(() => assertAggregateTransition(phased, { x: -1, y: 0 }, { x: 0, y: 0 }))).toBe("before")
    expect(phaseOf(() => assertAggregateTransition(phased, { x: 0, y: 0 }, { x: 0, y: -1 }))).toBe("after")
    expect(phaseOf(() => assertAggregateTransition(phased, { x: 0, y: 0 }, { x: 0, y: 0 }))).toBeUndefined()
    return
    throw new Error("expected failure")
  })
})

describe("runAggregateTransaction", () => {
  type S = { n: number }
  const compiled = compileAggregate<S>({
    key: "agg", version: 1, members: ["n"],
    invariants: [{ key: "pos-before", phase: "before", check: s => s.n >= 0 }, { key: "small-after", phase: "after", check: s => s.n < 10 }],
  })
  const provider = (runInTransaction: unknown) => ({ dialect: "t", capabilities: { interactiveTransactions: true }, runInTransaction }) as unknown as PersistenceProvider
  const passthrough = () => vi.fn(async (work: (p: PersistenceProvider) => Promise<unknown>) => work(provider(undefined)))
  it("requires a compiled aggregate, interactive transactions and functions", async () => {
    await expect(runAggregateTransaction({ definition: { ...compiled } as never, persistence: provider(passthrough()), load: vi.fn(), mutate: vi.fn() })).rejects.toThrow(new ConfigurationError("Aggregate transaction requires a compiled aggregate"))
    await expect(runAggregateTransaction({ definition: compiled, persistence: { dialect: "x", capabilities: {} } as never, load: vi.fn(), mutate: vi.fn() })).rejects.toThrow(new ConfigurationError('Aggregate "agg" requires interactive transaction support'))
    const message = new ConfigurationError("Aggregate transaction requires load and mutate functions")
    await expect(runAggregateTransaction({ definition: compiled, persistence: provider(passthrough()), load: "x" as never, mutate: vi.fn() })).rejects.toThrow(message)
    await expect(runAggregateTransaction({ definition: compiled, persistence: provider(passthrough()), load: vi.fn(), mutate: "x" as never })).rejects.toThrow(message)
  })
  it("loads, mutates and re-loads inside one serializable read-write transaction", async () => {
    let state: S = { n: 1 }
    const run = passthrough()
    const mutate = vi.fn(async (_p: PersistenceProvider, before: S) => { state = { n: before.n + 1 }; return "done" })
    const out = await runAggregateTransaction({ definition: compiled, persistence: provider(run), load: async () => state, mutate })
    expect(out).toEqual({ result: "done", before: { n: 1 }, after: { n: 2 } })
    expect(Object.isFrozen(out)).toBe(true)
    expect(Object.isFrozen(mutate.mock.calls[0]![1])).toBe(true)
    expect(run).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "serializable", accessMode: "read write" })
  })
  it("lets the caller override transaction options", async () => {
    const run = passthrough()
    await runAggregateTransaction({ definition: compiled, persistence: provider(run), load: async () => ({ n: 1 }), mutate: async () => 1, transaction: { isolationLevel: "read committed" } as never })
    expect(run).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "read committed", accessMode: "read write" })
  })
  it("checks the before invariants before mutating and the after invariants after", async () => {
    const mutate = vi.fn(async () => 1)
    const before = await runAggregateTransaction({ definition: compiled, persistence: provider(passthrough()), load: async () => ({ n: -1 }), mutate }).catch(e => e as AggregateInvariantError)
    expect(before).toBeInstanceOf(AggregateInvariantError)
    expect((before as AggregateInvariantError).phase).toBe("before")
    expect(mutate).not.toHaveBeenCalled()
    let state: S = { n: 1 }
    const after = await runAggregateTransaction({ definition: compiled, persistence: provider(passthrough()), load: async () => state, mutate: async () => { state = { n: 50 }; return 1 } }).catch(e => e as AggregateInvariantError)
    expect(after).toBeInstanceOf(AggregateInvariantError)
    expect((after as AggregateInvariantError).phase).toBe("after")
    expect((after as AggregateInvariantError).invariantKey).toBe("small-after")
  })
})
