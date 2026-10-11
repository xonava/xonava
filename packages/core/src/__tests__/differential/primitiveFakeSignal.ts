/**
 * A minimal AbortSignal stand-in that counts live listeners exactly:
 * `once` listeners are dropped when they fire, duplicates of the same
 * function are ignored (as EventTarget does), and `removeEventListener`
 * is idempotent. Used to prove the resilience executor never leaks abort
 * listeners on a caller-supplied signal.
 */
export class FakeSignal {
  aborted = false
  reason: unknown = undefined
  private readonly listeners = new Map<EventListener, boolean>()
  adds = 0
  removes = 0

  get liveListeners(): number { return this.listeners.size }

  addEventListener(type: string, listener: EventListener, options?: boolean | { once?: boolean }): void {
    if (type !== "abort") return
    this.adds++
    if (!this.listeners.has(listener)) this.listeners.set(listener, typeof options === "object" && options?.once === true)
  }

  removeEventListener(type: string, listener: EventListener): void {
    if (type !== "abort") return
    this.removes++
    this.listeners.delete(listener)
  }

  abort(reason: unknown): void {
    if (this.aborted) return
    this.aborted = true
    this.reason = reason
    for (const [listener, once] of [...this.listeners]) {
      if (once) this.listeners.delete(listener)
      listener(new Event("abort"))
    }
  }

  asSignal(): AbortSignal { return this as unknown as AbortSignal }
}
