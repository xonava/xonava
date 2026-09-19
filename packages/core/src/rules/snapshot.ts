const MAX_DEPTH = 64
const MAX_NODES = 10_000

/** Defensive data snapshot used at the pure rule boundary. */
export function snapshotRuleData<T>(value: T, label: string): T {
  const seen = new WeakMap<object, object>()
  let nodes = 0
  const copy = (current: unknown, depth: number): unknown => {
    if (current === null || typeof current === "string" || typeof current === "boolean" || typeof current === "undefined") return current
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError(`${label} contains a non-finite number`)
      return current
    }
    if (typeof current === "bigint") return current
    if (typeof current !== "object") throw new TypeError(`${label} must contain data only`)
    if (depth > MAX_DEPTH) throw new RangeError(`${label} exceeds the maximum nesting depth`)
    if (current instanceof Date) {
      if (Number.isNaN(current.getTime())) throw new TypeError(`${label} contains an invalid date`)
      return Object.freeze(new Date(current.getTime()))
    }
    const prototype = Object.getPrototypeOf(current) as object | null
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must contain plain data only`)
    const prior = seen.get(current)
    if (prior) return prior
    if (++nodes > MAX_NODES) throw new RangeError(`${label} exceeds the maximum node count`)
    const target: unknown[] | Record<string, unknown> = Array.isArray(current) ? [] : Object.create(prototype as object | null) as Record<string, unknown>
    seen.set(current, target)
    for (const key of Reflect.ownKeys(current)) {
      if (Array.isArray(current) && key === "length") continue
      if (typeof key === "symbol") throw new TypeError(`${label} cannot contain symbol keys`)
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (!descriptor || !("value" in descriptor)) throw new TypeError(`${label} cannot contain accessors`)
      Object.defineProperty(target, key, { value: copy(descriptor.value, depth + 1), enumerable: descriptor.enumerable ?? false, writable: true, configurable: true })
    }
    return Object.freeze(target)
  }
  return copy(value, 0) as T
}
