import { describe, expect, it } from "vitest"
import { snapshotData } from "../snapshotData"
import { cloneAndFreezeDefinition } from "../definitionIntegrity"

const chain = (levels: number): Record<string, unknown> => {
  const root: Record<string, unknown> = {}
  let cursor = root
  for (let i = 0; i < levels; i += 1) { const next: Record<string, unknown> = {}; cursor["n"] = next; cursor = next }
  return root
}
const ghostProxy = (target: object): object => new Proxy(target, {
  ownKeys: (t) => [...Reflect.ownKeys(t), "ghost"],
  getOwnPropertyDescriptor: (t, key) => (key === "ghost" ? undefined : Reflect.getOwnPropertyDescriptor(t, key)),
})

describe("snapshotData", () => {
  it("validates its limits", () => {
    const invalid = "Snapshot limits are invalid"
    for (const maxDepth of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => snapshotData({}, { maxDepth })).toThrow(new RangeError(invalid))
    for (const maxNodes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => snapshotData({}, { maxNodes })).toThrow(new RangeError(invalid))
    expect(snapshotData({ a: 1 }, { maxDepth: 0, maxNodes: 1 })).toEqual({ a: 1 })
  })
  it("uses the default label and honours a custom one", () => {
    expect(() => snapshotData(new Date(Number.NaN))).toThrow(new TypeError("Snapshot contains an invalid date"))
    expect(() => snapshotData(new Date(Number.NaN), { label: "Config" })).toThrow(new TypeError("Config contains an invalid date"))
    expect(() => snapshotData(Number.NaN, { label: "Config" })).toThrow(new TypeError("Config contains a non-finite number"))
    expect(() => snapshotData(Number.POSITIVE_INFINITY)).toThrow(new TypeError("Snapshot contains a non-finite number"))
  })
  it("accepts primitives and rejects functions and symbols", () => {
    for (const v of [null, undefined, "s", true, false, 0, -1.5, 10n]) expect(snapshotData(v)).toBe(v)
    expect(() => snapshotData(() => 1)).toThrow(new TypeError("Snapshot must contain data only"))
    expect(() => snapshotData(Symbol("x"))).toThrow(new TypeError("Snapshot must contain data only"))
    expect(() => snapshotData({ a: () => 1 }, { label: "L" })).toThrow(new TypeError("L must contain data only"))
  })
  it("enforces the nesting depth inclusively", () => {
    expect(snapshotData(chain(2), { maxDepth: 2 })).toEqual(chain(2))
    expect(() => snapshotData(chain(3), { maxDepth: 2 })).toThrow(new RangeError("Snapshot exceeds the maximum nesting depth"))
    expect(() => snapshotData({ a: {} }, { maxDepth: 0 })).toThrow(new RangeError("Snapshot exceeds the maximum nesting depth"))
    expect(() => snapshotData(chain(300))).toThrow(new RangeError("Snapshot exceeds the maximum nesting depth"))
    expect(snapshotData(chain(64))).toEqual(chain(64))
    expect(() => snapshotData(chain(65))).toThrow(RangeError)
  })
  it("clones dates and rejects invalid ones at any position", () => {
    const d = new Date(5)
    const copy = snapshotData(d)
    expect(copy).toBeInstanceOf(Date)
    expect(copy).not.toBe(d)
    expect(copy.getTime()).toBe(5)
    expect(() => snapshotData({ d: new Date(Number.NaN) })).toThrow(new TypeError("Snapshot contains an invalid date"))
  })
  it("rejects non-plain prototypes and keeps null prototypes", () => {
    class Box { x = 1 }
    const plain = "Snapshot must contain plain data only"
    expect(() => snapshotData(new Box())).toThrow(new TypeError(plain))
    expect(() => snapshotData(new Map())).toThrow(new TypeError(plain))
    expect(() => snapshotData(Object.setPrototypeOf([], null))).toThrow(new TypeError(plain))
    class Sub extends Array {}
    expect(() => snapshotData(new Sub())).toThrow(new TypeError(plain))
    const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 })
    const out = snapshotData(nullProto)
    expect(Object.getPrototypeOf(out)).toBeNull()
    expect(out["a"]).toBe(1)
    expect(Object.getPrototypeOf(snapshotData({ a: 1 }))).toBe(Object.prototype)
    expect(Array.isArray(snapshotData([1, 2]))).toBe(true)
  })
  it("enforces node and array length limits inclusively", () => {
    expect(snapshotData({ a: {}, b: {} }, { maxNodes: 3 })).toEqual({ a: {}, b: {} })
    expect(() => snapshotData({ a: {}, b: {}, c: {} }, { maxNodes: 3 })).toThrow(new RangeError("Snapshot exceeds the maximum node count"))
    expect(snapshotData([1, 2, 3], { maxNodes: 3 })).toEqual([1, 2, 3])
    expect(() => snapshotData([1, 2, 3, 4], { maxNodes: 3 })).toThrow(new RangeError("Snapshot exceeds the maximum array length"))
    expect(() => snapshotData(Array.from({ length: 10_001 }, () => 0))).toThrow(new RangeError("Snapshot exceeds the maximum array length"))
  })
  it("rejects cycles but preserves shared references", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic["self"] = cyclic
    expect(() => snapshotData(cyclic)).toThrow(new TypeError("Snapshot cannot contain cycles"))
    const shared = { v: 1 }
    const out = snapshotData({ x: shared, y: shared })
    expect(out.x).toBe(out.y)
    expect(out.x).not.toBe(shared)
    const pair = snapshotData([shared, shared])
    expect(pair[0]).toBe(pair[1])
  })
  it("rejects symbol keys and accessors but ignores keys without descriptors", () => {
    expect(() => snapshotData({ [Symbol("k")]: 1 })).toThrow(new TypeError("Snapshot cannot contain symbol keys"))
    const getter = {}
    Object.defineProperty(getter, "g", { get: () => 1, enumerable: true })
    expect(() => snapshotData(getter)).toThrow(new TypeError("Snapshot cannot contain accessors"))
    expect(snapshotData(ghostProxy({ a: 1 }))).toEqual({ a: 1 })
    expect(Object.keys(snapshotData(ghostProxy({ a: 1 })))).toEqual(["a"])
  })
  it("preserves enumerability, holes and freezes the result", () => {
    const hidden = {}
    Object.defineProperty(hidden, "h", { value: 1, enumerable: false })
    Object.defineProperty(hidden, "v", { value: 2, enumerable: true })
    const out = snapshotData(hidden)
    expect(Object.getOwnPropertyDescriptor(out, "h")?.enumerable).toBe(false)
    expect(Object.getOwnPropertyDescriptor(out, "v")?.enumerable).toBe(true)
    expect(Object.isFrozen(out)).toBe(true)
    const holes = snapshotData(new Array(3))
    expect(holes).toHaveLength(3)
    expect(0 in holes).toBe(false)
    expect(Object.isFrozen(holes)).toBe(true)
  })
  it("turns dates into clone-on-read accessors that survive re-snapshotting", () => {
    const out = snapshotData({ a: new Date(5), b: new Date(7), n: 1 })
    expect(out.a.getTime()).toBe(5)
    expect(out.a).not.toBe(out.a)
    expect(Object.keys(out)).toEqual(["a", "b", "n"])
    const again = snapshotData(out)
    expect(again.a.getTime()).toBe(5)
    expect(again.b.getTime()).toBe(7)
    expect(snapshotData(again).b.getTime()).toBe(7)
    const hidden = {}
    Object.defineProperty(hidden, "d", { value: new Date(9), enumerable: false })
    const snap = snapshotData(hidden) as { d: Date }
    expect(Object.getOwnPropertyDescriptor(snap, "d")?.enumerable).toBe(false)
    expect(Object.getOwnPropertyDescriptor(snapshotData(snap), "d")?.enumerable).toBe(false)
    expect(snap.d.getTime()).toBe(9)
    const arr = snapshotData([new Date(1), new Date(2)])
    expect(arr.map(d => d.getTime())).toEqual([1, 2])
    expect(snapshotData(arr).map(d => d.getTime())).toEqual([1, 2])
  })
})

describe("cloneAndFreezeDefinition", () => {
  it("clones, freezes and preserves shared references", () => {
    const shared = { x: 1 }
    const src = { a: shared, b: shared, list: [shared] }
    const out = cloneAndFreezeDefinition(src)
    expect(out).not.toBe(src)
    expect(out.a).toBe(out.b)
    expect(out.a).not.toBe(shared)
    expect(out.list[0]).toBe(out.a)
    expect(Object.isFrozen(out)).toBe(true)
    expect(Object.isFrozen(out.list)).toBe(true)
    expect(Object.isFrozen(out.a)).toBe(true)
  })
  it("keeps non-framework objects by reference unless data-only", () => {
    const date = new Date(1)
    const out = cloneAndFreezeDefinition({ date })
    expect(out.date).toBe(date)
    expect(Object.isFrozen(date)).toBe(false)
    expect(() => cloneAndFreezeDefinition({ date }, true)).toThrow(new TypeError("Security snapshot requires plain data objects."))
    const acc = {}
    Object.defineProperty(acc, "g", { get: () => 1, enumerable: true })
    expect(() => cloneAndFreezeDefinition(acc, true)).toThrow(new TypeError("Security snapshot cannot contain accessors."))
    expect(Object.getOwnPropertyDescriptor(cloneAndFreezeDefinition(acc), "g")?.get).toBeTypeOf("function")
  })
  it("enforces the nesting depth", () => {
    const m = new RangeError("Framework definition exceeds the maximum nesting depth.")
    expect(cloneAndFreezeDefinition(chain(64))).toEqual(chain(64))
    expect(() => cloneAndFreezeDefinition(chain(65))).toThrow(m)
    expect(() => cloneAndFreezeDefinition(chain(500))).toThrow(m)
  })
  it("enforces the node count inclusively", () => {
    const m = new RangeError("Framework definition exceeds the maximum node count.")
    const list = (n: number) => Array.from({ length: n }, () => ({}))
    expect(cloneAndFreezeDefinition(list(9_999))).toHaveLength(9_999)
    expect(() => cloneAndFreezeDefinition(list(10_000))).toThrow(m)
  })
  it("skips keys that report no descriptor", () => {
    const out = cloneAndFreezeDefinition(ghostProxy({ a: 1 }) as { a: number })
    expect(Object.keys(out)).toEqual(["a"])
    expect(Object.isFrozen(out)).toBe(true)
  })
})
