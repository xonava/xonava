import type { ExecutionScope } from "../../domain/executionScope"
import type { CursorPayloadV1, CursorValue } from "../../query/cursor"
import type { Rng } from "./harness"

/**
 * Generators for identity, key and serialization encodings. The atoms are
 * chosen to break naive encodings: every separator the framework uses (":",
 * "/", "|", ".", NUL), the words those encodings reserve ("tenant", "fscope",
 * "plan", "__generation__", "$type", "__proto__"), escaped forms of the same
 * text ("%3A" vs ":"), Unicode normalization pairs that render identically
 * but differ in code units, astral characters, lone surrogates, and numbers
 * whose decimal spellings are ambiguous (-0, 1e21, unsafe integers).
 */

/** Precomposed U+00E9 and its canonical decomposition "e" + U+0301. */
export const E_ACUTE_NFC = "é"
export const E_ACUTE_NFD = "é"
/** U+00C5 and U+212B ANGSTROM SIGN (NFC maps the latter to the former). */
export const A_RING = "Å"
export const ANGSTROM = "Å"
export const LONE_HIGH = "\ud83d"
export const LONE_LOW = "\ude00"

export const SEPARATOR_ATOMS = [":", "::", "/", "|", ".", "\u0000", ",", ";", "=", "&", "?", "#", " ", "\t", "\n"] as const

export const RESERVED_ATOMS = [
  "tenant", "tenant:", "tenant:1:", "tenant:01:", "tenant:0:", "fscope:v1:", "fscope", "v1", "plan", "plan:", "all-plans",
  "all-principals", "human", "service", "system", "__generation__", "__generation__:", "local:0", "$type", "__proto__",
  "constructor", "prototype", "toString", "global", "public", "abac", "framework:idempotency:v1:", "null", "true", "{}", "[]",
] as const

export const TEXT_ATOMS = [
  "a", "b", "c", "x", "t1", "t1x", "A", "0", "1", "01", "10", "-0", "1e21", "%", "%3A", "%3a", "%25", "%2F", "%00", "\"", "\\", "\\u0041",
  E_ACUTE_NFC, E_ACUTE_NFD, A_RING, ANGSTROM, "\u{1F600}", "\u{1F468}‍\u{1F469}", " ", "﻿", "İ", "ß", "￿", "\u{10ffff}",
] as const

export const ALL_ATOMS: readonly string[] = [...SEPARATOR_ATOMS, ...RESERVED_ATOMS, ...TEXT_ATOMS]

export function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

export interface StringOptions {
  /** Permit lone surrogates (default false: most encoders must reject them). */
  loneSurrogates?: boolean
  /** Maximum atoms concatenated (default 4). */
  maxAtoms?: number
  /** Probability of a long string, a few KiB (default 0.02). */
  longRate?: number
  /** Never return a blank (empty or whitespace-only) string. */
  nonBlank?: boolean
  /** Maximum length of a long string in code points (default 3000). */
  maxLength?: number
}

/** Code-point-safe slice: never splits a surrogate pair (which would mint a lone surrogate). */
export function sliceCodePoints(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join("")
}

function randomCodeUnitText(rng: Rng, loneSurrogates: boolean): string {
  const length = 1 + rng.int(3)
  let out = ""
  for (let index = 0; index < length; index++) {
    const roll = rng.int(10)
    if (roll < 4) out += String.fromCharCode(0x20 + rng.int(0x5f))
    else if (roll < 6) out += String.fromCharCode(rng.int(0x20))
    else if (roll < 8) out += String.fromCharCode(0xa0 + rng.int(0xd800 - 0xa0))
    else if (roll < 9) out += String.fromCodePoint(0x10000 + rng.int(0x10ffff - 0x10000))
    else out += loneSurrogates ? String.fromCharCode(0xd800 + rng.int(0x800)) : String.fromCharCode(0xe000 + rng.int(0x2000))
  }
  return out
}

/** An adversarial string: a concatenation of separator, reserved, escaped and Unicode atoms. */
export function adversarialString(rng: Rng, options: StringOptions = {}): string {
  const loneSurrogates = options.loneSurrogates ?? false
  let out = ""
  if (rng.bool(options.longRate ?? 0.02)) {
    const unit = rng.pick(ALL_ATOMS) || "x"
    const maxLength = options.maxLength ?? 3000
    out = sliceCodePoints(unit.repeat(Math.ceil((Math.min(512, maxLength) + rng.int(Math.max(1, maxLength - 512))) / unit.length)), 0, maxLength)
  } else {
    const atoms = rng.int((options.maxAtoms ?? 4) + 1)
    for (let index = 0; index < atoms; index++) {
      const roll = rng.int(20)
      if (roll === 0) out += randomCodeUnitText(rng, loneSurrogates)
      else if (roll === 1 && loneSurrogates) out += rng.pick([LONE_HIGH, LONE_LOW, `${LONE_LOW}${LONE_HIGH}`])
      else out += rng.pick(ALL_ATOMS)
    }
  }
  if (options.nonBlank && out.trim().length === 0) out += rng.pick(["a", "t1", E_ACUTE_NFC, "%3A", ":x", "0"])
  return out
}

export function nonBlankString(rng: Rng, options: Omit<StringOptions, "nonBlank"> = {}): string {
  return adversarialString(rng, { ...options, nonBlank: true })
}

/**
 * A tuple with the same arity whose naive `join(separator)` is identical but
 * whose parts differ: ["a:b","c"] -> ["a","b:c"]. Returns undefined when the
 * joined text has no alternative split.
 */
export function resplit(parts: readonly string[], separator: string): string[] | undefined {
  if (parts.length < 2 || separator.length === 0) return undefined
  const joined = parts.join(separator)
  const positions: number[] = []
  for (let index = joined.indexOf(separator); index !== -1; index = joined.indexOf(separator, index + 1)) positions.push(index)
  if (positions.length < parts.length) return undefined
  // Choose the cut points greedily from the right; distinct from the original whenever possible.
  const cuts = positions.slice(positions.length - (parts.length - 1))
  const out: string[] = []
  let start = 0
  for (const cut of cuts) {
    out.push(joined.slice(start, cut))
    start = cut + separator.length
  }
  out.push(joined.slice(start))
  return out.every((part, index) => part === parts[index]) ? undefined : out
}

/** Tuples built to collide under naive concatenation: shared prefixes and moved separators. */
export function collidingStringPair(rng: Rng, arity: number, options: StringOptions = {}): [string[], string[]] {
  const separator = rng.pick([":", "/", "|", ".", "\u0000", "::"])
  const parts = Array.from({ length: arity }, () => adversarialString(rng, options))
  // Force the separator into some parts so a different split exists.
  const left = parts.map((part, index) => (index < arity - 1 && rng.bool(0.6) ? `${part}${separator}${adversarialString(rng, { ...options, maxAtoms: 1 })}` : part))
  if (options.nonBlank) for (let index = 0; index < left.length; index++) if (left[index]!.trim() === "") left[index] = `x${left[index]}`
  const alternative = resplit(left, separator)
  if (alternative && (!options.nonBlank || alternative.every((part) => part.trim() !== ""))) return [left, alternative]
  // Fallback: prefix extension ("t1" + "x" vs "t1x" + "").
  const right = [...left]
  const index = rng.int(arity)
  right[index] = `${right[index]}${rng.pick(ALL_ATOMS) || "x"}`
  return [left, right]
}

/** Numbers that canonical JSON accepts, including the boundary spellings. */
export const CANONICAL_NUMBERS = [
  0, -0, 1, -1, 0.1, 0.5, -0.5, 1e-7, 1e-6, 123.456, 1e15, 5e-324, -5e-324, 2.5e-308, 1e-300, 1.5, 9007199254740991, -9007199254740991, 4503599627370495.5, 0.30000000000000004, 4.35,
] as const
/** Numbers canonical JSON rejects: non-finite and integral values outside the safe range. */
export const REJECTED_NUMBERS = [Number.NaN, Infinity, -Infinity, 9007199254740992, -9007199254740992, 1e21, 1e300, Number.MAX_VALUE, 2 ** 64] as const

export function canonicalNumber(rng: Rng): number {
  const roll = rng.int(4)
  if (roll === 0) return rng.int(2_000_001) - 1_000_000
  if (roll === 1) return (rng.int(2_000_001) - 1_000_000) / (1 + rng.int(1000))
  return rng.pick(CANONICAL_NUMBERS)
}

export interface JsonOptions {
  maxDepth?: number
  /** Include keys like "constructor"/"prototype" (never "__proto__", which canonical JSON rejects). */
  adversarialKeys?: boolean
}

/** A JSON value canonical JSON accepts (finite safe numbers, well-formed strings, plain objects). */
export function jsonValue(rng: Rng, options: JsonOptions = {}, depth = 0): unknown {
  const maxDepth = options.maxDepth ?? 4
  const roll = rng.int(12)
  if (depth >= maxDepth || roll < 6) {
    return rng.pick([() => null, () => true, () => false, () => canonicalNumber(rng), () => adversarialString(rng, { longRate: 0.005 }), () => adversarialString(rng, { maxAtoms: 1 })])()
  }
  if (roll < 9) return Array.from({ length: rng.int(5) }, () => jsonValue(rng, options, depth + 1))
  const out: Record<string, unknown> = {}
  const members = rng.int(6)
  for (let index = 0; index < members; index++) {
    let key = options.adversarialKeys === false ? `k${rng.int(20)}` : adversarialString(rng, { maxAtoms: 2, longRate: 0 })
    if (key === "__proto__") key = "__proto__x"
    out[key] = jsonValue(rng, options, depth + 1)
  }
  return out
}

/** Deep copy with every object's insertion order shuffled. Values are unchanged. */
export function permuteKeys(rng: Rng, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => permuteKeys(rng, item))
  if (value === null || typeof value !== "object") return value
  const out: Record<string, unknown> = {}
  for (const key of rng.shuffle(Object.keys(value))) out[key] = permuteKeys(rng, (value as Record<string, unknown>)[key])
  return out
}

/** Deep copy replacing every 0 with -0 and vice versa (canonically equal). */
export function flipZeroSigns(value: unknown): unknown {
  if (typeof value === "number") return value === 0 ? (Object.is(value, -0) ? 0 : -0) : value
  if (Array.isArray(value)) return value.map(flipZeroSigns)
  if (value === null || typeof value !== "object") return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) out[key] = flipZeroSigns(item)
  return out
}

/** JSON.parse(JSON.stringify(v)) with -0 normalised to 0: the documented canonical normalisation. */
export function jsonModel(value: unknown): unknown {
  return normaliseZero(JSON.parse(JSON.stringify(value)) as unknown)
}

export function normaliseZero(value: unknown): unknown {
  if (typeof value === "number") return Object.is(value, -0) ? 0 : value
  if (Array.isArray(value)) return value.map(normaliseZero)
  if (value === null || typeof value !== "object") return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    Object.defineProperty(out, key, { value: normaliseZero((value as Record<string, unknown>)[key]), enumerable: true, writable: true, configurable: true })
  }
  return out
}

/** Structural equality on JSON models: Object.is on numbers, ordered arrays, key-set equal objects (prototype ignored). */
export function jsonEqual(left: unknown, right: unknown): boolean {
  if (typeof left === "number" && typeof right === "number") return Object.is(left, right)
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return left === right
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]))
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false
  return leftKeys.every((key) => jsonEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
}

/** A small structural mutation that (usually) changes meaning; used to create near-miss pairs. */
export function mutateJson(rng: Rng, value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length === 0 || rng.bool(0.2)) return [...value, jsonValue(rng, { maxDepth: 1 })]
    const index = rng.int(value.length)
    if (rng.bool(0.2)) return value.filter((_, position) => position !== index)
    return value.map((item, position) => (position === index ? mutateJson(rng, item) : item))
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value)
    const record = value as Record<string, unknown>
    if (keys.length === 0 || rng.bool(0.2)) return { ...record, [`${adversarialString(rng, { maxAtoms: 1, longRate: 0 })}~`]: null }
    const key = rng.pick(keys)
    if (rng.bool(0.2)) {
      const { [key]: _removed, ...rest } = record
      return rest
    }
    if (rng.bool(0.15)) {
      // Rename the key to a normalization twin / escaped spelling: must be a different value.
      const renamed = key.includes(E_ACUTE_NFC) ? key.replace(E_ACUTE_NFC, E_ACUTE_NFD) : `${key}%3A`
      if (!Object.hasOwn(record, renamed) && renamed !== "__proto__") {
        const { [key]: moved, ...rest } = record
        return { ...rest, [renamed]: moved }
      }
    }
    return { ...record, [key]: mutateJson(rng, record[key]) }
  }
  if (typeof value === "string") return rng.pick([`${value}x`, sliceCodePoints(value, 1), value.replace(E_ACUTE_NFC, E_ACUTE_NFD) === value ? `${value}:` : value.replace(E_ACUTE_NFC, E_ACUTE_NFD), value.toUpperCase() === value ? `${value}a` : value.toUpperCase()])
  if (typeof value === "number") return rng.pick([value + 1, -value === value ? 1 : -value, String(value)])
  if (typeof value === "boolean") return rng.pick([!value, String(value), null])
  return rng.pick([false, 0, "", "null"])
}

/** Smaller JSON values for shrinking. */
export function* shrinkJson(value: unknown): Generator<unknown> {
  if (Array.isArray(value)) {
    for (const item of value) yield item
    for (let index = 0; index < value.length; index++) yield value.filter((_, position) => position !== index)
    for (let index = 0; index < value.length; index++) for (const inner of shrinkJson(value[index])) yield value.map((item, position) => (position === index ? inner : item))
    return
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) yield record[key]
    for (const key of Object.keys(record)) {
      const { [key]: _removed, ...rest } = record
      yield rest
    }
    for (const key of Object.keys(record)) for (const inner of shrinkJson(record[key])) yield { ...record, [key]: inner }
    return
  }
  if (typeof value === "string" && value.length > 0) yield* shrinkString(value)
}

export function* shrinkString(value: string): Generator<string> {
  const points = Array.from(value)
  if (points.length === 0) return
  yield ""
  if (points.length > 1) {
    const half = Math.floor(points.length / 2)
    yield points.slice(0, half).join("")
    yield points.slice(half).join("")
    yield points.slice(1).join("")
    yield points.slice(0, -1).join("")
  }
}

/** A compact, replay-friendly case description: long strings are abbreviated. */
export function describeCompact(value: unknown): string {
  const seen = new WeakSet<object>()
  const replacer = (_key: string, item: unknown): unknown => {
    if (typeof item === "string" && item.length > 120) return `<${item.length} chars: ${JSON.stringify(item.slice(0, 40))}...>`
    if (typeof item === "bigint") return `${item}n`
    if (item === undefined) return "<undefined>"
    if (typeof item === "number" && !Number.isFinite(item)) return String(item)
    if (Object.is(item, -0)) return "-0"
    if (item instanceof Map) return { "<Map>": [...item.entries()] }
    if (item instanceof Set) return { "<Set>": [...item] }
    if (item !== null && typeof item === "object") {
      if (seen.has(item)) return "<cycle>"
      seen.add(item)
    }
    return item
  }
  try {
    return JSON.stringify(value, function (this: Record<string, unknown>, key, item: unknown) {
      const original = this[key]
      return replacer(key, original instanceof Date ? `Date(${Number.isNaN(original.getTime()) ? "invalid" : original.toISOString()})` : item)
    }, 1)
  } catch {
    return String(value)
  }
}

/** Shrinks a tuple of strings one component at a time. */
export function* shrinkStrings(values: readonly string[]): Generator<string[]> {
  for (let index = 0; index < values.length; index++) for (const smaller of shrinkString(values[index]!)) yield values.map((item, position) => (position === index ? smaller : item))
}

// ---------------------------------------------------------------- identities

export const SCOPE_KINDS = ["application", "tenant", "platform", "system"] as const

export function executionScope(rng: Rng, kind: ExecutionScope["kind"] = rng.pick(SCOPE_KINDS)): ExecutionScope {
  // Keys stay within the 4 KiB scope-identity limit even for 6-byte JSON escapes.
  const key = nonBlankString(rng, { maxAtoms: 3, longRate: 0.01, maxLength: 300 })
  switch (kind) {
    case "application": return { kind, applicationKey: key }
    case "tenant": return { kind, tenantId: key }
    case "platform": return { kind, platformKey: key }
    case "system": return { kind, systemKey: key }
  }
}

export function scopeKey(scope: ExecutionScope): string {
  switch (scope.kind) {
    case "application": return scope.applicationKey
    case "tenant": return scope.tenantId
    case "platform": return scope.platformKey
    case "system": return scope.systemKey
  }
}

export function withScopeKey(scope: ExecutionScope, key: string): ExecutionScope {
  switch (scope.kind) {
    case "application": return { kind: "application", applicationKey: key }
    case "tenant": return { kind: "tenant", tenantId: key }
    case "platform": return { kind: "platform", platformKey: key }
    case "system": return { kind: "system", systemKey: key }
  }
}

export function* shrinkScope(scope: ExecutionScope): Generator<ExecutionScope> {
  for (const key of shrinkString(scopeKey(scope))) if (key.trim()) yield withScopeKey(scope, key)
}

// ---------------------------------------------------------------- cache key parts

export interface CacheValueOptions { maxDepth?: number }

/** A value accepted by `serializeCacheKeyPart`: JSON plus the tagged extensions. */
export function cacheValue(rng: Rng, options: CacheValueOptions = {}, depth = 0): unknown {
  const maxDepth = options.maxDepth ?? 3
  const roll = rng.int(16)
  if (depth >= maxDepth || roll < 8) {
    return rng.pick<() => unknown>([
      () => null, () => undefined, () => true, () => false,
      () => canonicalNumber(rng), () => rng.pick([Number.NaN, Infinity, -Infinity, -0, 0, 2 ** 53, 1e21]),
      () => adversarialString(rng, { maxAtoms: 2, loneSurrogates: rng.bool(0.1), longRate: 0 }),
      () => rng.pick(["{\"$type\":\"undefined\"}", "{\"$type\":\"Date\",\"value\":\"1970-01-01T00:00:00.000Z\"}", "1970-01-01T00:00:00.000Z", "NaN", "undefined", "1"]),
      () => new Date(rng.pick([0, 1, -1, 1_700_000_000_000, 8.64e15, -8.64e15])),
      () => BigInt(rng.int(5) - 2) * (rng.bool() ? 1n : 10n ** 30n),
    ])()
  }
  if (roll < 10) return Array.from({ length: rng.int(4) }, () => cacheValue(rng, options, depth + 1))
  if (roll < 12) return new Set(Array.from({ length: rng.int(4) }, () => cacheValue(rng, options, depth + 1)))
  if (roll < 14) return new Map(Array.from({ length: rng.int(4) }, () => [cacheValue(rng, options, depth + 1), cacheValue(rng, options, depth + 1)] as const))
  const out: Record<string, unknown> = {}
  for (let index = rng.int(4); index > 0; index--) {
    let key = adversarialString(rng, { maxAtoms: 2, longRate: 0 })
    if (key === "$type") key = "$type2"
    if (key === "__proto__") Object.defineProperty(out, key, { value: cacheValue(rng, options, depth + 1), enumerable: true, writable: true, configurable: true })
    else out[key] = cacheValue(rng, options, depth + 1)
  }
  return out
}

/** Deep copy with object keys, Set items and Map entries reordered (same cache-key meaning). */
export function permuteCacheValue(rng: Rng, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => permuteCacheValue(rng, item))
  if (value instanceof Set) return new Set(rng.shuffle([...value]).map((item) => permuteCacheValue(rng, item)))
  if (value instanceof Map) return new Map(rng.shuffle([...value.entries()]).map(([key, item]) => [permuteCacheValue(rng, key), permuteCacheValue(rng, item)] as const))
  if (value instanceof Date) return new Date(value.getTime())
  if (value === null || typeof value !== "object") return typeof value === "number" && value === 0 ? (rng.bool() ? 0 : -0) : value
  const out: Record<string, unknown> = {}
  for (const key of rng.shuffle(Object.keys(value))) {
    Object.defineProperty(out, key, { value: permuteCacheValue(rng, (value as Record<string, unknown>)[key]), enumerable: true, writable: true, configurable: true })
  }
  return out
}

/**
 * Independent reference model of cache-key-part meaning: a type-tagged,
 * length-prefixed token stream. Two key parts must serialise equally exactly
 * when their reference tokens are equal. Sets and Maps are multisets ordered by
 * the reference encoding of their members; -0 equals 0 (JSON numbers).
 */
export function cacheReference(value: unknown): string {
  const text = (tag: string, body: string): string => `${tag}${body.length}:${body}`
  if (value === undefined) return "u"
  if (value === null) return "n"
  if (typeof value === "boolean") return value ? "T" : "F"
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "N"
    if (!Number.isFinite(value)) return value > 0 ? "I+" : "I-"
    return text("d", String(value === 0 ? 0 : value))
  }
  if (typeof value === "string") return text("s", value)
  if (typeof value === "bigint") return text("i", value.toString())
  if (value instanceof Date) return text("t", value.toISOString())
  if (Array.isArray(value)) return text("a", value.map(cacheReference).join(""))
  if (value instanceof Set) return text("S", [...value].map(cacheReference).sort().join(""))
  if (value instanceof Map) return text("M", [...value.entries()].map(([key, item]) => text("e", cacheReference(key) + cacheReference(item))).sort().join(""))
  const record = value as Record<string, unknown>
  return text("o", Object.keys(record).sort().map((key) => text("k", key) + cacheReference(record[key])).join(""))
}

// ---------------------------------------------------------------- cursors

export function cursorValue(rng: Rng): CursorValue {
  return rng.pick<() => CursorValue>([
    () => null, () => rng.bool(), () => canonicalNumber(rng),
    () => adversarialString(rng, { maxAtoms: 3, longRate: 0 }),
    () => rng.pick(["v1.", ".", "..", "v1.a.b", "=", "+/", "-_", "2026-01-01T00:00:00.000Z"]),
  ])()
}

export function cursorPayload(rng: Rng): CursorPayloadV1 {
  const hash = (): string => rng.pick([() => nonBlankString(rng, { maxAtoms: 2, longRate: 0 }), () => (rng.next().toString(16) + rng.next().toString(16)).padStart(16, "0")])()
  return {
    format: "framework.cursor",
    version: 1,
    direction: rng.pick(["after", "before"] as const),
    values: Array.from({ length: rng.int(5) }, () => cursorValue(rng)),
    routeHash: hash(),
    queryHash: hash(),
    scopeHash: hash(),
    sortHash: hash(),
    ...(rng.bool(0.4) ? { expiresAt: rng.int(2_000_000_000) + 1 } : {}),
  }
}
