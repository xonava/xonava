import { describe, expect, it } from "vitest"
import { assertJobProgressFence, compileScheduleLifecycle, decodeStoredJobCheckpoint, isScheduleEffective, validateJobProgress } from ".."

describe("J1 contracts", () => {
  it("bounds progress and durable checkpoints", () => { expect(() => validateJobProgress({ percent: 101 })).toThrow("between 0 and 100"); expect(() => validateJobProgress({ checkpoint: { value: "x".repeat(70_000) } })).toThrow("exceeds") })
  it("rejects malformed or oversized persisted checkpoints before replay", () => { expect(() => decodeStoredJobCheckpoint("not-json")).toThrow("not valid JSON"); expect(() => decodeStoredJobCheckpoint(`{\"value\":\"${"x".repeat(70_000)}\"}`)).toThrow("exceeds"); expect(decodeStoredJobCheckpoint('{"step":"ok"}')).toEqual({ step: "ok" }) })
  it("fences progress writes by worker, claim and attempt", () => { const fence = { jobId: "j", workerId: "w", claimToken: "c", attempt: 2 }; expect(() => assertJobProgressFence(fence, fence)).not.toThrow(); expect(() => assertJobProgressFence(fence, { ...fence, attempt: 1 })).toThrow("ownership") })
  it("compiles pause, effective window and finite occurrence lifecycle", () => { const active = compileScheduleLifecycle({ effectiveFrom: "2026-01-01T00:00:00Z", effectiveUntil: "2027-01-01T00:00:00Z", remainingOccurrences: 1, owner: "ops" }); expect(isScheduleEffective(active, new Date("2026-09-11T00:00:00Z"))).toBe(true); expect(isScheduleEffective({ ...active, paused: true }, new Date("2026-09-11T00:00:00Z"))).toBe(false) })
})
