import { ConfigurationError } from "@xonava/core/domain"

/**
 * Tagged JSON codec shared by every cache adapter so a value round-trips
 * identically in tests (in-memory) and production (KV).
 *
 * Supported: JSON primitives, plain objects, arrays, Date, BigInt, Map, Set,
 * NaN/Infinity/-Infinity, and objects exposing toJSON(). Following JSON,
 * `undefined` object properties are dropped and `undefined` array items become
 * `null`. A top-level `undefined`, functions, symbols, cycles, invalid Dates
 * and other class instances are rejected with a ConfigurationError.
 */
const TAG = "$cache"

type Encoded = null | boolean | number | string | Encoded[] | { [key: string]: Encoded }

function reject(message: string): never {
  throw new ConfigurationError(`Cache value is not serializable: ${message}`)
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

function encodeNode(value: unknown, seen: Set<object>, inArray: boolean): Encoded | undefined {
  switch (typeof value) {
    case "undefined":
      return inArray ? null : undefined
    case "string":
    case "boolean":
      return value
    case "number":
      if (Number.isFinite(value)) return value
      return { [TAG]: "Number", v: String(value) }
    case "bigint":
      return { [TAG]: "BigInt", v: value.toString() }
    case "function":
    case "symbol":
      return reject(`${typeof value} values are not supported`)
  }
  if (value === null) return null
  const object = value as object
  if (seen.has(object)) reject("cyclic structures are not supported")
  seen.add(object)
  try {
    if (object instanceof Date) {
      const time = object.getTime()
      if (Number.isNaN(time)) reject("invalid Date")
      return { [TAG]: "Date", v: new Date(time).toISOString() }
    }
    if (Array.isArray(object)) {
      return object.map((item) => encodeNode(item, seen, true) ?? null)
    }
    if (object instanceof Map) {
      return { [TAG]: "Map", v: Array.from(object.entries(), ([k, v]) => [encodeNode(k, seen, true) ?? null, encodeNode(v, seen, true) ?? null]) }
    }
    if (object instanceof Set) {
      return { [TAG]: "Set", v: Array.from(object.values(), (item) => encodeNode(item, seen, true) ?? null) }
    }
    if (!isPlainObject(object)) {
      const toJSON = (object as { toJSON?: unknown }).toJSON
      if (typeof toJSON === "function") return encodeNode((toJSON as () => unknown).call(object), seen, inArray)
      reject(`instances of ${object.constructor?.name ?? "unknown class"} are not supported`)
    }
    const out: Record<string, Encoded> = {}
    for (const [key, item] of Object.entries(object)) {
      const encoded = encodeNode(item, seen, false)
      if (encoded !== undefined) out[key] = encoded
    }
    // Escape plain objects that could be mistaken for a tagged node.
    return Object.hasOwn(out, TAG) ? { [TAG]: "Object", v: out } : out
  } finally {
    seen.delete(object)
  }
}

function decodeNode(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node
  if (Array.isArray(node)) return node.map(decodeNode)
  const record = node as Record<string, unknown>
  if (Object.hasOwn(record, TAG)) {
    const v = record.v
    switch (record[TAG]) {
      case "Number": return Number(v)
      case "BigInt": return BigInt(v as string)
      case "Date": return new Date(v as string)
      case "Map": return new Map((v as [unknown, unknown][]).map(([k, item]) => [decodeNode(k), decodeNode(item)]))
      case "Set": return new Set((v as unknown[]).map(decodeNode))
      case "Object": return decodePlain(v as Record<string, unknown>)
    }
  }
  return decodePlain(record)
}

function decodePlain(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) out[key] = decodeNode(item)
  return out
}

/** Encode a cache value into a JSON-safe tree. Throws ConfigurationError for unsupported values. */
export function encodeCacheValue(value: unknown): Encoded {
  if (value === undefined) reject("top-level undefined cannot be cached")
  return encodeNode(value, new Set(), false) as Encoded
}

export function decodeCacheValue<T>(encoded: unknown): T {
  return decodeNode(encoded) as T
}

/** Validates a cache TTL: `undefined` means no TTL, otherwise a positive safe integer of milliseconds. */
export function assertCacheTtl(ttlMs: number | undefined): void {
  if (ttlMs === undefined) return
  if (typeof ttlMs !== "number" || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new ConfigurationError("Cache ttlMs must be a positive safe integer of milliseconds (or undefined for no TTL)")
  }
}
