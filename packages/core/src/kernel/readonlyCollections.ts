/** Snapshot collections without exposing the mutable backing collection to callbacks. */
export function readonlyMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  const map = new Map(entries)
  const view: ReadonlyMap<K, V> = {
    get: map.get.bind(map), has: map.has.bind(map),
    forEach: (callback, thisArg) => map.forEach((value, key) => callback.call(thisArg, value, key, view)),
    entries: map.entries.bind(map), keys: map.keys.bind(map), values: map.values.bind(map),
    get size() { return map.size }, [Symbol.iterator]: map[Symbol.iterator].bind(map),
  }
  return Object.freeze(view)
}

export function readonlySet<T>(values: Iterable<T>): ReadonlySet<T> {
  const set = new Set(values)
  const view: ReadonlySet<T> = {
    has: set.has.bind(set),
    forEach: (callback, thisArg) => set.forEach(value => callback.call(thisArg, value, value, view)),
    entries: set.entries.bind(set), keys: set.keys.bind(set), values: set.values.bind(set),
    get size() { return set.size }, [Symbol.iterator]: set[Symbol.iterator].bind(set),
  }
  return Object.freeze(view)
}
