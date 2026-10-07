/**
 * The one time abstraction in core. Every capability that needs time takes a
 * Clock (or a TimerClock when it must also schedule), so tests and other
 * language ports inject time the same way everywhere.
 */
export interface Clock {
  now(): Date
}

/** A clock that can also schedule and cancel cooperative timers. */
export interface TimerClock extends Clock {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemClock: TimerClock = Object.freeze({
  now: () => new Date(),
  setTimeout: (callback: () => void, ms: number): unknown => setTimeout(callback, ms),
  clearTimeout: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
})
