import { describe, expect, it, vi } from "vitest"
import { readonlyMap, readonlySet } from "../readonlyCollections"

describe("readonly collection views", () => {
  it("supports every map read API without exposing a mutable map", () => {
    const view = readonlyMap([["a", 1], ["b", 2]])
    expect(view.size).toBe(2)
    expect(view.get("a")).toBe(1)
    expect(view.has("b")).toBe(true)
    expect([...view]).toEqual([["a", 1], ["b", 2]])
    expect([...view.entries()]).toEqual([...view])
    expect([...view.keys()]).toEqual(["a", "b"])
    expect([...view.values()]).toEqual([1, 2])
    const receiver = { sum: 0 }
    view.forEach(function (this: typeof receiver, value, key, collection) { this.sum += value; expect(collection).toBe(view); expect(collection.has(key)).toBe(true) }, receiver)
    expect(receiver.sum).toBe(3)
    expect((view as Map<string, number>).set).toBeUndefined()
    expect(Object.isFrozen(view)).toBe(true)
  })

  it("supports every set read API and passes the readonly view to callbacks", () => {
    const view = readonlySet(["a", "b", "a"])
    expect(view.size).toBe(2)
    expect(view.has("a")).toBe(true)
    expect([...view]).toEqual(["a", "b"])
    expect([...view.entries()]).toEqual([["a", "a"], ["b", "b"]])
    expect([...view.keys()]).toEqual(["a", "b"])
    expect([...view.values()]).toEqual(["a", "b"])
    const callback = vi.fn((value, duplicate, collection) => { expect(value).toBe(duplicate); expect(collection).toBe(view) })
    view.forEach(callback)
    expect(callback).toHaveBeenCalledTimes(2)
    expect((view as Set<string>).add).toBeUndefined()
    expect(Object.isFrozen(view)).toBe(true)
  })
})
