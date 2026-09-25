import { describe, expect, it } from "vitest"
import { snapshotData } from "../snapshotData"

describe("snapshotData", () => {
  it("keeps date properties immutable across every standard setter", () => {
    const timestamp = Date.parse("2026-01-02T03:04:05.006Z")
    const original = new Date(timestamp)
    const snapshot = snapshotData({ occurredAt: original }, { label: "Test data" })
    original.setTime(0)

    const setters = [
      "setDate", "setFullYear", "setHours", "setMilliseconds", "setMinutes", "setMonth", "setSeconds", "setTime",
      "setUTCDate", "setUTCFullYear", "setUTCHours", "setUTCMilliseconds", "setUTCMinutes", "setUTCMonth", "setUTCSeconds", "setYear",
    ] as const
    const datePrototype = Date.prototype as unknown as Record<string, (...args: number[]) => number>
    for (const setter of setters) {
      Reflect.apply(datePrototype[setter]!, snapshot.occurredAt, [0])
      expect(snapshot.occurredAt.getTime()).toBe(timestamp)
    }
    Date.prototype.setTime.call(snapshot.occurredAt, 1)
    expect(snapshot.occurredAt.getTime()).toBe(timestamp)
  })

  it("preserves Date compatibility, enumeration, JSON, nested objects, and arrays", () => {
    const iso = "2026-01-02T03:04:05.006Z"
    const snapshot = snapshotData({ nested: { dates: [new Date(iso)] } })
    const first = snapshot.nested.dates[0]!
    expect(first).toBeInstanceOf(Date)
    expect(first.toISOString()).toBe(iso)
    expect(snapshot.nested.dates[0]).not.toBe(snapshot.nested.dates[0])
    expect({ ...snapshot.nested.dates }[0]).toEqual(new Date(iso))
    expect(JSON.stringify(snapshot)).toBe(`{"nested":{"dates":["${iso}"]}}`)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.nested.dates)).toBe(true)
  })

  it("rejects invalid dates and accessors without invoking them", () => {
    expect(() => snapshotData({ at: new Date(NaN) })).toThrow(/invalid date/)
    let invoked = false
    const value = Object.defineProperty({}, "at", { enumerable: true, get() { invoked = true; return new Date() } })
    expect(() => snapshotData(value)).toThrow(/accessors/)
    expect(invoked).toBe(false)
  })

  it("rejects cycles and non-plain array subclasses", () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => snapshotData(cycle)).toThrow(/cycles/)

    class CustomArray extends Array<unknown> {}
    expect(() => snapshotData(new CustomArray("value"))).toThrow(/plain data/)
  })

  it("preserves sparse array length and holes", () => {
    const input = new Array<unknown>(3)
    input[1] = "middle"
    const snapshot = snapshotData({ input })

    expect(snapshot.input).toHaveLength(3)
    expect(0 in snapshot.input).toBe(false)
    expect(snapshot.input[1]).toBe("middle")
    expect(2 in snapshot.input).toBe(false)
    expect(Object.isFrozen(snapshot.input)).toBe(true)
  })

  it("rejects sparse arrays whose length exceeds the node budget", () => {
    expect(() => snapshotData(new Array(11), { maxNodes: 10 })).toThrow(/array length/)
  })

  it("safely re-snapshots Core-created date accessors", () => {
    const first = snapshotData({ nested: [{ at: new Date("2026-01-01T00:00:00.000Z") }] })
    const second = snapshotData(first)
    first.nested[0]!.at.setTime(0)
    second.nested[0]!.at.setTime(1)
    expect(second.nested[0]!.at.toISOString()).toBe("2026-01-01T00:00:00.000Z")
    expect(second).not.toBe(first)
  })
})
