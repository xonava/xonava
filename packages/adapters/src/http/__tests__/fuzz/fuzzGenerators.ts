import type { Rng } from "../../../../../core/src/__tests__/differential/harness"
import type { FuzzRequest } from "./fuzzTransports"
import { BASE_PATH, CUSTOM_PATH } from "./fuzzTransports"

const encoder = new TextEncoder()

/** Names that must never be settable or readable through request input. */
export const PROTOTYPE_KEYS = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "__defineGetter__", "valueOf"] as const

const HOSTILE_STRINGS = [
  "", " ", "\t", "0", "-1", "null", "undefined", "NaN", "true", "false", "[]", "{}", "*", "%", "%00", "%zz", "&", "=", "?", "#", ";", ",", ".", "..", "../../etc/passwd", "..\\..\\windows",
  "a'; DROP TABLE people; --", "\" OR 1=1 --", "${7*7}", "{{7*7}}", "<script>alert(1)</script>", "javascript:alert(1)", "\u0000", "a\u0000b", "‮evil", "​‍", "﻿", "  ",
  "𝔘𝔫𝔦𝔠𝔬𝔡𝔢", "😀".repeat(40), "é".repeat(300), "\uD800", "\uDC00x", "__proto__", "constructor", "Infinity", "-0", "1e999", "0x10", "9007199254740993", "00001",
  "row-1", "row-2", "foreign-1", "tenant-2", "' OR tenantId='tenant-2",
]

export function hostileString(rng: Rng): string {
  const roll = rng.int(10)
  if (roll < 5) return rng.pick(HOSTILE_STRINGS)
  if (roll < 7) return Array.from({ length: rng.int(24) }, () => String.fromCodePoint(rng.pick([rng.int(0x80), 0x20 + rng.int(0x5f), 0x100 + rng.int(0x500), 0x1f300 + rng.int(0x300), rng.int(0x20)]))).join("")
  if (roll < 8) return "a".repeat(rng.pick([10, 100, 499, 500, 501, 1000, 4096, 70_000]))
  if (roll < 9) return rng.pick(HOSTILE_STRINGS) + rng.pick(HOSTILE_STRINGS)
  return "Ünï" + "x".repeat(rng.int(600)) + rng.pick(HOSTILE_STRINGS)
}

/** A string safe for a URL component or a header value: well-formed Unicode only. */
export function wellFormed(text: string): string {
  return text.toWellFormed()
}

export function hostileNumber(rng: Rng): unknown {
  return rng.pick([0, -1, 1, 2, 1.5, -0, 1e21, 1e-7, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2, 2 ** 53, 2 ** 31, 2 ** 32, -(2 ** 31), 0.1 + 0.2, 99999999999999999999])
}

export function hostileValue(rng: Rng, depth = 0): unknown {
  const roll = rng.int(depth >= 3 ? 7 : 10)
  switch (roll) {
    case 0: return null
    case 1: return rng.bool()
    case 2: return hostileNumber(rng)
    case 3: case 4: return hostileString(rng)
    case 5: return ""
    case 6: return rng.pick(["active", "archived", "ACTIVE", "active ", "Ada"])
    case 7: return Array.from({ length: rng.int(5) }, () => hostileValue(rng, depth + 1))
    default: {
      const entries: Array<[string, unknown]> = Array.from({ length: rng.int(4) }, () => [rng.bool(0.5) ? rng.pick(PROTOTYPE_KEYS) : hostileString(rng), hostileValue(rng, depth + 1)])
      const object: Record<string, unknown> = {}
      for (const [key, value] of entries) Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true })
      return object
    }
  }
}

const FIELD_NAMES = ["name", "status", "version", "id", "tenantId", "createdAt", "isAdmin", "role"] as const

/** A JSON text for a create or update body: valid, wrongly typed, hostile, or textually corrupted. */
export function bodyText(rng: Rng, kind: "create" | "update"): string {
  const roll = rng.int(100)
  const validName = rng.pick(["Ada", "Grace", "Linus", "Margaret"])
  if (roll < 12) return JSON.stringify(kind === "create" ? { name: validName } : { name: validName })
  if (roll < 30) {
    const body: Record<string, unknown> = {}
    for (const field of rng.subset(FIELD_NAMES, 0.5)) body[field] = hostileValue(rng)
    if (kind === "create" && rng.bool(0.6)) body.name = hostileValue(rng)
    return JSON.stringify(body)
  }
  if (roll < 42) {
    // Prototype keys as own JSON keys, at several depths, next to a valid name.
    const key = rng.pick(PROTOTYPE_KEYS)
    const payload = rng.pick(['{"isAdmin":true,"polluted":"yes"}', '{"prototype":{"polluted":"yes"}}', '{"constructor":{"prototype":{"polluted":"yes"}}}', "[]", "null", '"x"'])
    return rng.pick([
      `{"${key}":${payload},"name":"${validName}"}`,
      `{"name":"${validName}","${key}":${payload}}`,
      `{"name":{"${key}":${payload}}}`,
      `{"name":"${validName}","status":{"${key}":${payload}}}`,
      `{"${key}":${payload}}`,
    ])
  }
  if (roll < 54) {
    // Deep nesting (and wide arrays) in a field the schema rejects or strips.
    const depth = rng.pick([10, 100, 1000, 10_000, 100_000, 400_000])
    const nest = rng.bool() ? "[".repeat(depth) + "]".repeat(depth) : '{"a":'.repeat(depth) + "1" + "}".repeat(depth)
    return rng.pick([`{"name":"${validName}","extra":${nest}}`, `{"name":${nest}}`, nest, `{"extra":${nest},"name":"${validName}"}`])
  }
  if (roll < 64) {
    // Huge strings: around the field limit and around the body limit.
    const length = rng.pick([499, 500, 501, 5000, 100_000, 1_048_000, 1_048_500, 1_100_000, 2_000_000])
    return rng.pick([`{"name":"${"a".repeat(length)}"}`, `{"name":"${validName}","status":"${"b".repeat(length)}"}`, `{"name":"${"é".repeat(Math.ceil(length / 2))}"}`, "x".repeat(length)])
  }
  // Textual corruption of a valid body.
  const valid = JSON.stringify({ name: validName, status: "active" })
  const cut = rng.int(valid.length + 1)
  return rng.pick([
    valid.slice(0, cut),
    valid.slice(0, cut) + rng.pick(["\u0000", "\u0001", "\u007f", "﻿", "'", "}", "]", ",", "//", "/*"]) + valid.slice(cut),
    "﻿" + valid,
    valid + valid,
    valid + "\u0000",
    ` ${valid} `,
    `{"name":"${validName}","name":"${hostileString(rng).replace(/["\\\u0000-\u001f]/g, "")}"}`,
    `{"name":"${validName}",}`,
    `{'name':'${validName}'}`,
    `{"name":NaN}`, `{"name":Infinity}`, `{"name":undefined}`, `{"name":1e999}`, `{"name":-0}`,
    `{"name":"\\ud800"}`, `{"name":"\\u0000"}`, `{"name":"\\x41"}`, `{"name":"a\nb"}`,
    "", " ", "\n", "null", "true", "0", '""', "[]", "[{}]", "{}", '{"name":null}', "{", "}", "[", "{{", '{"":""}', '{"name":"a"}\n{"name":"b"}',
  ])
}

/** Body bytes: UTF-8 text, optionally with bytes that are not valid UTF-8 spliced in. */
export function bodyBytes(rng: Rng, text: string): Uint8Array {
  const bytes = encoder.encode(text)
  if (!rng.bool(0.15)) return bytes
  const invalid = rng.pick([[0xc0, 0xaf], [0xff], [0xfe, 0xff], [0x80], [0xed, 0xa0, 0x80], [0xe2, 0x82], [0xf0, 0x9f, 0x98], [0xf8, 0x88, 0x80, 0x80, 0x80], [0xc3, 0x28]])
  const at = rng.int(bytes.length + 1)
  const out = new Uint8Array(bytes.length + invalid.length)
  out.set(bytes.subarray(0, at))
  out.set(invalid, at)
  out.set(bytes.subarray(at), at + invalid.length)
  return out
}

const HEADER_SAFE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 !#$%&'*+-.^_`|~\"\\/:;<=>?@[]{}(),"

/** A header value that every HTTP/1.1 transport accepts: visible ASCII, spaces and tabs inside. */
export function headerValue(rng: Rng, maxLength = 200): string {
  const length = rng.pick([0, 1, 2, 5, 40, maxLength])
  let out = ""
  for (let index = 0; index < length; index++) out += HEADER_SAFE[rng.int(HEADER_SAFE.length)]
  return out.trim()
}

export function ifMatchValue(rng: Rng): string {
  return rng.pick(["1", "2", "3", "0", "-1", '"1"', '"2"', '"3"', 'W/"1"', 'W/"3"', "*", '"1", "2"', "1, 2", "1.5", "1e3", "0x1", "+1", "01", " 1 ", '""', '"', "NaN", "Infinity", "99999999999999999999", "9007199254740993", "-0", "abc", "\"abc\"", headerValue(rng), "1".repeat(300), "9".repeat(4000)])
}

export function idempotencyKeyValue(rng: Rng): string {
  return rng.pick(["key-1", "key-2", "k".repeat(255), "k".repeat(256), "k".repeat(300), "k".repeat(4000), "", " ", "  padded  ", "a b", "key\tkey", "../key", "%00", "ключ".length > 0 ? "key-ascii" : "", headerValue(rng, 300), `key-${rng.int(3)}`])
}

export const CONTENT_TYPES = [
  "application/json", "application/json; charset=utf-8", "application/json;charset=UTF-8", "application/json; charset=utf-16", "application/json; charset=latin1", "application/json; charset=\"utf-8\"",
  "APPLICATION/JSON", "application/vnd.api+json", "application/+json", "application/json-patch+json", "application/jsonx", "text/plain", "text/json", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/octet-stream", "*/*", "", "json", "application/json, text/plain", "application/json; charset=utf-8; charset=utf-16",
] as const

const EXTRA_HEADER_NAMES = ["x-correlation-id", "user-agent", "x-request-id", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip", "accept", "accept-language", "origin", "referer", "cookie", "authorization", "x-http-method-override", "x-custom"] as const

/** Headers a client may legitimately send, with hostile values, duplicates and oversize values. */
export function extraHeaders(rng: Rng): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (let count = rng.int(4); count > 0; count--) {
    const name = rng.pick(EXTRA_HEADER_NAMES)
    const value = headerValue(rng, rng.pick([40, 300, 2500]))
    out.push([name, value])
    if (rng.bool(0.3)) out.push([name, headerValue(rng, 60)])
  }
  return out
}

function encode(text: string): string {
  return encodeURIComponent(wellFormed(text))
}

/** Longest request target the fuzzer sends (Node's default header budget is 16 KiB for the whole head). */
const MAX_TARGET_LENGTH = 8000

/** Percent-encodes everything outside visible ASCII, so any generated text is a legal request target. */
export function legalTarget(target: string): string {
  const encoded = wellFormed(target).replace(/[^\x21-\x7e]/gu, (character) => encodeURIComponent(character)).replace(/#/g, "%23")
  if (encoded.length <= MAX_TARGET_LENGTH) return encoded
  // Node's HTTP server refuses request lines past its header budget (431) before any adapter runs; stay under it
  // and never cut inside a percent escape.
  return encoded.slice(0, MAX_TARGET_LENGTH).replace(/%[0-9A-Fa-f]?$/, "")
}

const VALID_IDS = ["row-1", "row-2", "row-3"]
export function pathId(rng: Rng, includeForeign = true): string {
  const roll = rng.int(10)
  if (roll < 4) return rng.pick(VALID_IDS)
  if (roll < 5 && includeForeign) return "foreign-1"
  // A single path segment. "." and ".." (also when percent-encoded) are normalised away by URL parsing before any handler runs.
  const text = hostileString(rng)
  const segment = encode(text)
  return /^(?:\.|%2e){1,2}$/i.test(segment) || segment === "" ? "row-%2E" : segment
}

export interface FuzzContext {
  /** Cursors the live list endpoint issued, for forging and truncating. */
  cursors: readonly string[]
}

function mutateCursor(rng: Rng, cursors: readonly string[]): string {
  const cursor = rng.pick(cursors)
  const [prefix = "", payload = "", signature = ""] = cursor.split(".")
  switch (rng.int(12)) {
    case 0: return cursor
    case 1: return cursor.slice(0, rng.int(cursor.length))
    case 2: return cursor.slice(0, cursor.length - 1 - rng.int(4))
    case 3: return `${prefix}.${payload}`
    case 4: return `${prefix}.${signature}.${payload}`
    case 5: return `${prefix}.${payload}.${signature}.${signature}`
    case 6: { const at = rng.int(cursor.length); const flipped = cursor[at] === "A" ? "B" : "A"; return cursor.slice(0, at) + flipped + cursor.slice(at + 1) }
    case 7: return `${prefix}.${btoa(JSON.stringify({ format: "framework.cursor", version: 1, direction: "after", values: ["row-1"], routeHash: "x", queryHash: "x", scopeHash: "x", sortHash: "x" })).replace(/=+$/, "")}.${signature}`
    case 8: return `v1.${"A".repeat(rng.pick([10, 9000, 40_000]))}.${"A".repeat(rng.pick([10, 100]))}`
    case 9: return `v2.${payload}.${signature}`
    case 10: return cursor.replace(/[A-Za-z0-9_-]/g, (c, offset: number) => (offset % 7 === 0 ? "%" : c))
    default: return wellFormed(hostileString(rng))
  }
}

const SORT_FIELDS = ["id", "name", "status", "tenantId", "version", "__proto__", "constructor", "missing", ""]
function sortingParam(rng: Rng): string {
  const entry = () => rng.pick<unknown>([{ id: "id" }, { id: "name", desc: true }, { id: "status", desc: false }, { id: rng.pick(SORT_FIELDS), desc: rng.pick([true, false, "yes", 1, null]) }, { field: "name" }, "name", null, [], { id: ["id"] }])
  return rng.pick([
    JSON.stringify([entry()]), JSON.stringify([entry(), entry(), entry(), entry()]), JSON.stringify({ id: "name" }), "name", "[", "null", "[[]]", "[{}]", '[{"id":"id","id":"name"}]', "[" + '{"id":"id"},'.repeat(rng.int(20)) + '{"id":"id"}]',
    JSON.stringify([{ id: "id" }]), JSON.stringify([{ id: "name" }, { id: "id" }]), JSON.stringify([{ id: "name", desc: true }, { id: "id", desc: true }]), hostileString(rng),
  ])
}

function condition(rng: Rng): unknown {
  return {
    field: rng.pick([...SORT_FIELDS, "name", "status"]),
    operator: rng.pick(["eq", "neq", "contains", "startsWith", "endsWith", "isEmpty", "isNotEmpty", "gt", "lt", "gte", "lte", "isNull", "in", "notIn", "between", "regex", "like", "__proto__", "", "EQ", 7, null]),
    ...(rng.bool(0.85) ? { value: rng.bool(0.5) ? hostileValue(rng, 2) : rng.pick(["Ada", "active", ["Ada", "Grace"], { from: "A", to: "H" }, [1, 2], ["a"]]) } : {}),
  }
}

function group(rng: Rng, depth: number): unknown {
  return {
    ...(rng.bool(0.7) ? { logic: rng.pick(["AND", "OR", "XOR", "and", 1, null]) } : {}),
    conditions: Array.from({ length: rng.int(depth > 3 ? 2 : 5) }, () => (depth < 8 && rng.bool(0.25) ? group(rng, depth + 1) : condition(rng))),
    ...(rng.bool(0.3) ? { search: hostileString(rng) } : {}),
  }
}

function filtersParam(rng: Rng): string {
  const roll = rng.int(10)
  if (roll < 2) return JSON.stringify({ search: hostileString(rng) })
  if (roll < 7) return JSON.stringify(group(rng, 0))
  if (roll < 8) {
    // Deep group nesting beyond any sane query budget.
    let nested: unknown = { conditions: [condition(rng)] }
    for (let depth = rng.pick([20, 100, 2000]); depth > 0; depth--) nested = { conditions: [nested] }
    return JSON.stringify(nested)
  }
  if (roll < 9) return JSON.stringify({ conditions: Array.from({ length: rng.pick([30, 300, 3000]) }, () => ({ field: "name", operator: "eq", value: "Ada" })) })
  return rng.pick(["{", "[]", "null", '"x"', "1", "", "{}", '{"search":null}', '{"conditions":"x"}', '{"conditions":[null]}', '{"conditions":[[]]}', '{"__proto__":{"conditions":[]}}', hostileString(rng)])
}

function numberParam(rng: Rng): string {
  return rng.pick(["0", "1", "2", "3", "10", "50", "100", "101", "-1", "1.5", "1e2", "0x10", "abc", "", " ", "NaN", "Infinity", "-0", "+1", "01", "1000000", "1000001", "99999999999999999999", "9007199254740993", "１２", hostileString(rng)])
}

/** A list query string made of hostile, repeated and unknown parameters. */
export function listQuery(rng: Rng, context: FuzzContext): string {
  const params: Array<[string, string]> = []
  const known: Record<string, () => string> = {
    page: () => numberParam(rng), pageSize: () => numberParam(rng), limit: () => numberParam(rng),
    sorting: () => sortingParam(rng), filters: () => filtersParam(rng),
    fields: () => rng.pick(["id", "id,name", "name,name", "id,,name", ",", "id,tenantId", "tenantId", "version", "__proto__", "constructor,id", "missing", "", ` id , name `, hostileString(rng), "name,".repeat(rng.pick([5, 2000]))]),
    consistency: () => rng.pick(["strong", "session", "eventual", "STRONG", "weak", "", "strong,eventual"]),
    cursor: () => (context.cursors.length > 0 ? mutateCursor(rng, context.cursors) : hostileString(rng)),
    before: () => (context.cursors.length > 0 ? mutateCursor(rng, context.cursors) : hostileString(rng)),
  }
  const names = Object.keys(known)
  for (const name of rng.subset(names, 0.4)) {
    params.push([name, known[name]!()])
    // The same parameter again, with the same or another value.
    if (rng.bool(0.15)) params.push([name, rng.bool() ? params.at(-1)![1] : known[name]!()])
  }
  for (let extra = rng.int(3); extra > 0; extra--) {
    params.push([rng.pick([...PROTOTYPE_KEYS, "tenantId", "tenant", "scope", "x", "a[]", "a[b]", "", "filters[]", "page ", "Page", "PAGE", hostileString(rng)]), hostileString(rng)])
  }
  if (rng.bool(0.1)) params.push(["tenantId", "tenant-2"])
  const rendered = rng.shuffle(params).map(([name, value]) => (rng.bool(0.05) ? `${name}=${value}` : `${encode(name)}=${encode(value)}`))
  if (rng.bool(0.05)) rendered.push(rng.pick(["", "&", "=", "&&", "%", "%zz", "a", "=b", "?", ";", "%00", "+", "a=%ff"]))
  return rendered.length === 0 ? "" : `?${rendered.join("&")}`
}

export type FuzzFocus = "body" | "headers" | "query" | "path" | "scope" | "any"

function jsonHeaders(rng: Rng, focus: FuzzFocus): Array<[string, string]> {
  const headers: Array<[string, string]> = []
  const hostileTypes = focus === "headers" || focus === "any" ? 0.4 : 0.05
  headers.push(["content-type", rng.bool(hostileTypes) ? rng.pick(CONTENT_TYPES) : "application/json"])
  if (rng.bool(hostileTypes * 0.5)) headers.push(["content-type", rng.pick(CONTENT_TYPES)])
  return headers
}

/** One hostile request against the CRUD routes. `focus` weights which input family is attacked hardest. */
export function crudRequest(rng: Rng, context: FuzzContext, focus: FuzzFocus = "any"): FuzzRequest {
  const operation = rng.pick(["list", "list", "detail", "create", "create", "update", "update", "delete"] as const)
  const headers: Array<[string, string]> = []
  const hostileHeaders = focus === "headers" || focus === "any"
  if (rng.bool(hostileHeaders ? 0.6 : 0.1)) headers.push(...extraHeaders(rng))
  if (focus === "scope" || rng.bool(0.05)) {
    headers.push(...rng.subset([["x-tenant-id", "tenant-2"], ["x-tenant", "tenant-2"], ["x-forwarded-host", "tenant-2.example.test"], ["x-scope", "platform"], ["x-forwarded-for", "10.0.0.2"], ["host", "tenant-2.example.test"]] as Array<[string, string]>, 0.6))
  }
  const idempotency = (): void => {
    if (rng.bool(hostileHeaders ? 0.5 : 0.15)) {
      headers.push(["idempotency-key", idempotencyKeyValue(rng)])
      if (rng.bool(hostileHeaders ? 0.2 : 0.03)) headers.push(["idempotency-key", idempotencyKeyValue(rng)])
    }
  }
  const precondition = (): void => {
    if (rng.bool(hostileHeaders ? 0.8 : 0.6)) {
      headers.push(["if-match", ifMatchValue(rng)])
      if (rng.bool(hostileHeaders ? 0.2 : 0.03)) headers.push(["if-match", ifMatchValue(rng)])
    }
    if (rng.bool(0.05)) headers.push(["if-none-match", ifMatchValue(rng)])
  }
  const id = focus === "path" || focus === "scope" || rng.bool(0.5) ? pathId(rng) : rng.pick(VALID_IDS)
  const query = focus === "query" || rng.bool(0.15) ? listQuery(rng, context) : ""
  switch (operation) {
    case "list": return { method: "GET", target: legalTarget(`${BASE_PATH}${focus === "query" || focus === "any" || focus === "scope" ? listQuery(rng, context) : query}`), headers }
    case "detail": return { method: "GET", target: legalTarget(`${BASE_PATH}/${id}${query}`), headers }
    case "create": {
      idempotency()
      return { method: "POST", target: legalTarget(`${BASE_PATH}${query}`), headers: [...jsonHeaders(rng, focus), ...headers], body: bodyBytes(rng, scopedBody(rng, focus, bodyText(rng, "create"))) }
    }
    case "update": {
      idempotency(); precondition()
      return { method: "PATCH", target: legalTarget(`${BASE_PATH}/${id}${query}`), headers: [...jsonHeaders(rng, focus), ...headers], body: bodyBytes(rng, scopedBody(rng, focus, bodyText(rng, "update"))) }
    }
    default: {
      idempotency(); precondition()
      const withBody = rng.bool(0.15)
      return { method: "DELETE", target: legalTarget(`${BASE_PATH}/${id}${query}`), headers: withBody ? [...jsonHeaders(rng, focus), ...headers] : headers, ...(withBody ? { body: bodyBytes(rng, bodyText(rng, "update")) } : {}) }
    }
  }
}

/** For the scope focus, inject tenant-switching fields into a JSON body. */
function scopedBody(rng: Rng, focus: FuzzFocus, text: string): string {
  if (focus !== "scope" || !rng.bool(0.7)) return text
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return text
    return JSON.stringify({ ...(parsed as Record<string, unknown>), [rng.pick(["tenantId", "tenant", "scope", "scopeId", "tenant_id"])]: rng.pick(["tenant-2", "tenant-1", "*", null]) })
  } catch {
    return text
  }
}

/** A hostile request against the custom write handler mounted at `${CUSTOM_PATH}/:id`. */
export function customWriteRequest(rng: Rng, bodyKind: "create" | "update" = "create"): FuzzRequest {
  const headers: Array<[string, string]> = [...jsonHeaders(rng, "any")]
  if (rng.bool(0.5)) headers.push(...extraHeaders(rng))
  if (rng.bool(0.5)) headers.push(["idempotency-key", idempotencyKeyValue(rng)])
  if (rng.bool(0.3)) headers.push(["if-match", ifMatchValue(rng)])
  const query = rng.bool(0.3) ? listQuery(rng, { cursors: [] }) : ""
  return { method: rng.pick(["POST", "PATCH", "DELETE"] as const), target: legalTarget(`${CUSTOM_PATH}/${pathId(rng, false)}${query}`), headers, body: bodyBytes(rng, bodyText(rng, bodyKind)) }
}

/** Cheap, readable description for a failing case (large bodies and headers are shortened). */
export function describeRequest(request: FuzzRequest): string {
  const clip = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max)}…(${text.length} chars)` : text)
  const body = request.body === undefined ? undefined : clip(new TextDecoder("utf-8", { fatal: false }).decode(request.body))
  return JSON.stringify({ method: request.method, target: clip(request.target, 500), headers: request.headers.map(([name, value]) => [name, clip(value, 120)]), body, bodyBytes: request.body?.byteLength }, null, 2)
}
