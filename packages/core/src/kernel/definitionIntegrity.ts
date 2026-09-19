const MAX_DEFINITION_DEPTH = 64
const MAX_DEFINITION_NODES = 10_000

export function cloneAndFreezeDefinition<T>(value: T, dataOnly = false): T {
  const seen = new WeakMap<object, object>()
  let nodes = 0
  const clone = (current: unknown, depth: number): unknown => {
    if (current === null || typeof current !== "object") return current
    if (!isFrameworkOwnedObject(current)) {
      if (dataOnly) throw new TypeError("Security snapshot requires plain data objects.")
      return current
    }
    if (depth > MAX_DEFINITION_DEPTH) throw new RangeError("Framework definition exceeds the maximum nesting depth.")
    const existing = seen.get(current)
    if (existing) return existing
    if (++nodes > MAX_DEFINITION_NODES) throw new RangeError("Framework definition exceeds the maximum node count.")
    const copy = (Array.isArray(current) ? [] : Object.create(Object.getPrototypeOf(current) as object | null)) as object
    seen.set(current, copy)
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (!descriptor) continue
      if (dataOnly && !("value" in descriptor)) throw new TypeError("Security snapshot cannot contain accessors.")
      if ("value" in descriptor) descriptor.value = clone(descriptor.value, depth + 1)
      Object.defineProperty(copy, key, descriptor)
    }
    return copy
  }
  const cloned = clone(value, 0) as T
  const frozen = new WeakSet<object>()
  const freeze = (current: unknown, depth: number): void => {
    if (current === null || typeof current !== "object" || !isFrameworkOwnedObject(current) || frozen.has(current)) return
    if (depth > MAX_DEFINITION_DEPTH) throw new RangeError("Framework definition exceeds the maximum nesting depth.")
    frozen.add(current)
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor && "value" in descriptor) freeze(descriptor.value, depth + 1)
    }
    Object.freeze(current)
  }
  freeze(cloned, 0)
  return cloned
}

function isFrameworkOwnedObject(value: object): boolean {
  if (Array.isArray(value)) return true
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}
