import { describe, expect, it, vi } from "vitest"
import { systemClock } from "../clock"
import { parseIsoInstant } from "../isoInstant"

describe("parseIsoInstant", () => {
  const bad = (text: unknown) => expect(parseIsoInstant(text)).toBeNaN()
  const good = (text: string) => expect(parseIsoInstant(text)).toBe(Date.parse(text))

  it("rejects non-strings even when they stringify to an instant", () => {
    bad({ toString: () => "2026-01-01" })
    bad(new String("2026-01-01"))
    bad(20260101)
    bad(undefined)
    bad("2026-01-01 ")
  })
  it("validates month and day against the calendar", () => {
    bad("2026-00-05")
    bad("2026-13-05")
    bad("2026-01-00")
    bad("2026-01-32")
    bad("2026-02-29")
    bad("2026-04-31")
    good("2024-02-29")
    good("2026-02-28")
    good("2026-12-31")
    good("2026-01-01")
    good("2026-04-30")
  })
  it("validates the time of day", () => {
    bad("2026-01-01T24:00:00Z")
    bad("2026-01-01T23:60:00Z")
    bad("2026-01-01T23:59:60Z")
    bad("2026-01-01T24:00Z")
    bad("2026-01-01T00:60Z")
    good("2026-01-01T23:59:59Z")
    good("2026-01-01T23:59Z")
    good("2026-01-01T00:00:00.123Z")
    good("2026-01-01T23:59:59.999Z")
  })
  it("validates the numeric offset", () => {
    bad("2026-01-01T10:00:00+24:00")
    bad("2026-01-01T10:00:00+23:60")
    bad("2026-01-01T10:00:00-24:00")
    bad("2026-01-01T10:00:00-00:60")
    good("2026-01-01T10:00:00+23:59")
    good("2026-01-01T10:00:00-23:59")
    good("2026-01-01T10:00:00+05:30")
    good("2026-01-01T10:00Z")
  })
})

describe("systemClock", () => {
  it("is frozen and reads the wall clock", () => {
    expect(Object.isFrozen(systemClock)).toBe(true)
    const before = Date.now()
    const now = systemClock.now()
    expect(now).toBeInstanceOf(Date)
    expect(now.getTime()).toBeGreaterThanOrEqual(before)
    expect(now.getTime()).toBeLessThanOrEqual(Date.now())
  })
  it("schedules and cancels timers", () => {
    vi.useFakeTimers()
    try {
      const fired = vi.fn()
      const handle = systemClock.setTimeout(fired, 50)
      expect(handle).toBeDefined()
      vi.advanceTimersByTime(49)
      expect(fired).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(fired).toHaveBeenCalledTimes(1)
      const cancelled = vi.fn()
      const other = systemClock.setTimeout(cancelled, 10)
      systemClock.clearTimeout(other)
      vi.advanceTimersByTime(100)
      expect(cancelled).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
})
