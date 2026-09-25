import { describe, expect, it } from "vitest"
import { aggregateHealth } from "../health"

describe("health timestamp snapshots", () => {
  it("isolates report and component timestamps from input and result mutation", () => {
    const checkedAt = new Date("2026-01-01T00:00:00.000Z")
    const componentAt = new Date("2026-01-01T00:00:01.000Z")
    const report = aggregateHealth([{ key: "api", status: "healthy", critical: true, checkedAt: componentAt }], [], checkedAt)
    checkedAt.setTime(0); componentAt.setTime(0)
    report.checkedAt.setTime(1); report.components[0]!.checkedAt.setTime(1)
    expect(report.checkedAt.toISOString()).toBe("2026-01-01T00:00:00.000Z")
    expect(report.components[0]!.checkedAt.toISOString()).toBe("2026-01-01T00:00:01.000Z")
    expect(Object.isFrozen(report)).toBe(true)
  })

  it("rejects invalid report and component timestamps", () => {
    expect(() => aggregateHealth([], [], new Date(NaN))).toThrow()
    expect(() => aggregateHealth([{ key: "api", status: "healthy", critical: true, checkedAt: new Date(NaN) }], [])).toThrow()
  })
})
