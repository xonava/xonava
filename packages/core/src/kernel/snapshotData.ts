const DEFAULT_MAX_DEPTH = 64
const DEFAULT_MAX_NODES = 10_000

// Private provenance for date accessors created by this module. WeakMap keeps
// the trust marker unforgeable and does not retain completed snapshots.
const snapshotDateProperties = new WeakMap<object, Map<PropertyKey, number>>()

export interface SnapshotDataOptions {
  readonly label?: string
  readonly maxDepth?: number
  readonly maxNodes?: number
}

/**
 * Takes a bounded, data-only snapshot. Date-valued properties are enumerable
 * clone-on-read accessors: repeated reads intentionally return distinct Date
 * instances so a caller can never mutate the snapshot's authoritative time.
 */
export function snapshotData<T>(value: T, options: SnapshotDataOptions = {}): T {
  const label = options.label ?? "Snapshot"
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || !Number.isSafeInteger(maxNodes) || maxNodes < 1) throw new RangeError("Snapshot limits are invalid")

  const seen = new WeakMap<object, object>()
  const active = new WeakSet<object>()
  let nodes = 0

  const dateTimestamp = (date: Date): number => {
    const timestamp = Date.prototype.getTime.call(date)
    if (Number.isNaN(timestamp)) throw new TypeError(`${label} contains an invalid date`)
    return timestamp
  }

  const copy = (current: unknown, depth: number): unknown => {
    if (current === null || typeof current === "string" || typeof current === "boolean" || typeof current === "undefined") return current
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError(`${label} contains a non-finite number`)
      return current
    }
    if (typeof current === "bigint") return current
    if (typeof current !== "object") throw new TypeError(`${label} must contain data only`)
    if (depth > maxDepth) throw new RangeError(`${label} exceeds the maximum nesting depth`)
    if (current instanceof Date) return new Date(dateTimestamp(current))

    const prototype = Object.getPrototypeOf(current) as object | null
    if (Array.isArray(current) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must contain plain data only`)
    if (Array.isArray(current) && current.length > maxNodes) throw new RangeError(`${label} exceeds the maximum array length`)
    if (active.has(current)) throw new TypeError(`${label} cannot contain cycles`)
    const prior = seen.get(current)
    if (prior) return prior
    if (++nodes > maxNodes) throw new RangeError(`${label} exceeds the maximum node count`)

    // Preserve trailing holes. Starting from [] would silently turn
    // `new Array(3)` into an empty array and change snapshot semantics.
    const target: unknown[] | Record<string, unknown> = Array.isArray(current) ? new Array(current.length) : Object.create(prototype) as Record<string, unknown>
    seen.set(current, target)
    active.add(current)
    const defineDateProperty = (key: PropertyKey, timestamp: number, enumerable: boolean): void => {
      let properties = snapshotDateProperties.get(target)
      if (!properties) {
        properties = new Map<PropertyKey, number>()
        snapshotDateProperties.set(target, properties)
      }
      properties.set(key, timestamp)
      Object.defineProperty(target, key, {
        enumerable,
        configurable: true,
        get: () => new Date(timestamp),
      })
    }
    try {
      for (const key of Reflect.ownKeys(current)) {
        if (Array.isArray(current) && key === "length") continue
        if (typeof key === "symbol") throw new TypeError(`${label} cannot contain symbol keys`)
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        if (!descriptor) continue
        if (!("value" in descriptor)) {
          const timestamp = snapshotDateProperties.get(current)?.get(key)
          if (timestamp === undefined) throw new TypeError(`${label} cannot contain accessors`)
          defineDateProperty(key, timestamp, descriptor.enumerable ?? false)
        } else if (descriptor.value instanceof Date) {
          const timestamp = dateTimestamp(descriptor.value)
          defineDateProperty(key, timestamp, descriptor.enumerable ?? false)
        } else {
          Object.defineProperty(target, key, {
            value: copy(descriptor.value, depth + 1),
            enumerable: descriptor.enumerable ?? false,
            writable: true,
            configurable: true,
          })
        }
      }
    } finally {
      active.delete(current)
    }
    return Object.freeze(target)
  }

  return copy(value, 0) as T
}
