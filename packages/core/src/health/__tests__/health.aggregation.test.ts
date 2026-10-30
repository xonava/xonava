import { describe, expect, it } from "vitest"
import { ValidationError } from "../../domain/errors"
import { aggregateHealth, type HealthComponent } from "../health"

const at = new Date(5000)
const c = (o: Record<string, unknown> = {}): HealthComponent => ({ key: "a", status: "healthy", critical: true, checkedAt: new Date(1), ...o }) as HealthComponent
const COMPONENT = "Health components require unique non-empty keys, valid status, and valid times."
const fails = (live: unknown, ready: unknown, message: string, when: unknown = at) => {
  try { aggregateHealth(live as never, ready as never, when as never) } catch (e) {
    expect(e).toBeInstanceOf(ValidationError)
    expect((e as Error).message).toBe(message)
    return
  }
  throw new Error(`expected: ${message}`)
}

describe("aggregateHealth validation", () => {
  it("requires a valid time and array inputs", () => {
    const m = "Health report time must be valid."
    fails([], [], m, "now")
    fails([], [], m, new Date(Number.NaN))
    fails("x", [], m)
    fails([], "x", m)
    fails(undefined, [], m)
    expect(aggregateHealth([], [], at).checkedAt.getTime()).toBe(5000)
    expect(aggregateHealth([], []).checkedAt).toBeInstanceOf(Date)
  })
  it("validates every component field", () => {
    fails([null], [], COMPONENT)
    fails(["x"], [], COMPONENT)
    fails([c({ key: 5 })], [], COMPONENT)
    fails([c({ key: "" })], [], COMPONENT)
    fails([c({ key: "  " })], [], COMPONENT)
    fails([c({ status: "ok" })], [], COMPONENT)
    fails([c({ status: undefined })], [], COMPONENT)
    fails([c({ critical: "yes" })], [], COMPONENT)
    fails([c({ checkedAt: "2026" })], [], COMPONENT)
    fails([c({ checkedAt: new Date(Number.NaN) })], [], COMPONENT)
    fails([c({ message: 5 })], [], COMPONENT)
    fails([c()], [c()], COMPONENT)
    fails([c(), c()], [], COMPONENT)
    for (const status of ["healthy", "degraded", "unhealthy"]) expect(aggregateHealth([c({ status })], [], at).components[0]!.status).toBe(status)
    expect(aggregateHealth([c({ message: "m" })], [], at).components[0]!.message).toBe("m")
    expect(aggregateHealth([c({ critical: false })], [], at).components[0]!.critical).toBe(false)
  })
  it("labels component and report snapshots", () => {
    expect(() => aggregateHealth([c({ extra: () => 1 })] as never, [], at)).toThrow("Health component must contain data only")
    const many = Array.from({ length: 10_001 }, (_, i) => c({ key: `k${i}` }))
    expect(() => aggregateHealth(many, [], at)).toThrow("Health report exceeds the maximum array length")
  })
})

describe("aggregateHealth status", () => {
  const status = (live: HealthComponent[], ready: HealthComponent[]) => { const r = aggregateHealth(live, ready, at); return [r.live, r.ready, r.status] }
  it("is healthy when all components are healthy", () => {
    expect(status([c({ key: "l" })], [c({ key: "r" })])).toEqual([true, true, "healthy"])
    expect(status([], [])).toEqual([true, true, "healthy"])
  })
  it("fails liveness only for critical unhealthy liveness components", () => {
    expect(status([c({ key: "x", status: "healthy" }), c({ key: "l", status: "unhealthy" })], [])).toEqual([false, false, "unhealthy"])
    expect(status([c({ key: "l", status: "unhealthy" }), c({ key: "x", status: "healthy" })], [])).toEqual([false, false, "unhealthy"])
    expect(status([c({ key: "l", status: "unhealthy", critical: false })], [])).toEqual([true, true, "degraded"])
    expect(status([c({ key: "l", status: "degraded" })], [])).toEqual([true, true, "degraded"])
  })
  it("fails readiness only for critical unhealthy readiness components", () => {
    expect(status([], [c({ key: "x", status: "healthy" }), c({ key: "r", status: "unhealthy" })])).toEqual([true, false, "unhealthy"])
    expect(status([], [c({ key: "r", status: "unhealthy" }), c({ key: "x", status: "healthy" })])).toEqual([true, false, "unhealthy"])
    expect(status([], [c({ key: "r", status: "unhealthy", critical: false })])).toEqual([true, true, "degraded"])
    expect(status([], [c({ key: "r", status: "degraded" })])).toEqual([true, true, "degraded"])
  })
  it("treats an unhealthy liveness as not ready even when readiness is clean", () => {
    expect(status([c({ key: "l", status: "unhealthy" })], [c({ key: "r" })])).toEqual([false, false, "unhealthy"])
  })
  it("returns a frozen report of snapshotted components in liveness-then-readiness order", () => {
    const report = aggregateHealth([c({ key: "l" })], [c({ key: "r" })], at)
    expect(report.components.map(x => x.key)).toEqual(["l", "r"])
    expect(Object.isFrozen(report)).toBe(true)
    expect(Object.isFrozen(report.components)).toBe(true)
    expect(report.checkedAt).not.toBe(at)
  })
})
