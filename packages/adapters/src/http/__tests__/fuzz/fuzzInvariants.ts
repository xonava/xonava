import { FAULT_TEXT, FOREIGN_TENANT, OWN_TENANT, SEED_ROWS, type FaultOperation, type FuzzRow } from "./fuzzFixture"
import { DEFAULT_MAX_JSON_BODY_BYTES } from "../../requestBody"
import type { FuzzRequest, FuzzResponse } from "./fuzzTransports"

/** Every 4xx status the HTTP layer documents, with the public codes it may carry (docs/typescript/http-adapters.md, docs/spec/errors.md). */
export const DOCUMENTED_4XX: Readonly<Record<number, readonly string[]>> = Object.freeze({
  400: ["VALIDATION_ERROR", "BAD_REQUEST", "INVALID_JSON", "REQUIRED_HEADER_MISSING"],
  401: ["UNAUTHORIZED"],
  403: ["FORBIDDEN", "CAPABILITY_REQUIRED"],
  404: ["NOT_FOUND"],
  409: ["CONFLICT", "OPTIMISTIC_CONCURRENCY_FAILED", "STALE_CLAIM"],
  413: ["REQUEST_BODY_TOO_LARGE"],
  415: ["UNSUPPORTED_MEDIA_TYPE", "BODY_NOT_ACCEPTED"],
  428: ["PRECONDITION_REQUIRED"],
  429: ["RATE_LIMIT_EXCEEDED"],
})

/** Text that only appears when internal error detail, a stack frame or a source location reached the client. */
const LEAK_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["injected fault text", /FAULT_SENTINEL|hunter2|secret-repository/],
  ["stack frame", /\n\s+at\s+\S+|\bat\s+(?:async\s+)?[\w.<>$]+\s+\([^)]*:\d+:\d+\)|\bat\s+file:\/\//],
  ["source location", /\.(?:ts|js|mjs|cjs):\d+(?::\d+)?\b/],
  ["module path", /node_modules|\/home\/|\/srv\/|\/usr\/|packages\/(?:core|adapters|testing)|[A-Za-z]:\\\\/],
  ["JavaScript error name", /\b(?:TypeError|ReferenceError|RangeError|SyntaxError|EvalError|URIError|AggregateError)\b/],
  ["engine message", /Maximum call stack|Cannot read propert|is not a function|is not iterable|Unexpected token|in JSON at position|is not defined|undefined is not|JSON\.parse|\[object Object\]/],
  ["driver message", /SQLSTATE|ECONNREFUSED|ECONNRESET|ENOENT|syntax error at or near/],
]

export interface Observation {
  transport: string
  request: FuzzRequest
  response: FuzzResponse
  rowsBefore: string
  rowsAfter: string
  rows: ReadonlyMap<string, FuzzRow>
  fault: FaultOperation | null
}

export function responseCode(response: FuzzResponse): string | undefined {
  try {
    const parsed: unknown = JSON.parse(response.text)
    if (parsed !== null && typeof parsed === "object" && typeof (parsed as { code?: unknown }).code === "string") return (parsed as { code: string }).code
  } catch { /* not JSON */ }
  return undefined
}

const KNOWN_FIELDS = new Set(["id", "tenantId", "name", "status", "version"])

function pollutionProblems(): string[] {
  const problems: string[] = []
  const inherited = Object.keys(Object.prototype)
  if (inherited.length > 0) problems.push(`Object.prototype gained enumerable keys: ${inherited.join(", ")}`)
  const probe = {} as Record<string, unknown>
  for (const key of ["polluted", "isAdmin", "role", "tenantId"]) if (probe[key] !== undefined) problems.push(`Object.prototype.${key} was set`)
  if (Object.getPrototypeOf(Object.prototype) !== null) problems.push("Object.prototype's prototype changed")
  return problems
}

/** The invariants every observed exchange must satisfy; returns one message per violation. */
export function observationProblems(observation: Observation): string[] {
  const { transport, response, request } = observation
  const problems: string[] = []
  const fail = (message: string) => problems.push(`[${transport}] ${message}`)
  const injected = observation.fault !== null

  if (response.status >= 500 && !injected) fail(`status ${response.status} without an injected fault: ${response.text.slice(0, 300)}`)
  if (response.status >= 500 && injected && response.status !== 500 && response.status !== 503) fail(`injected fault answered ${response.status}`)
  if (response.status < 200 || response.status >= 600) fail(`impossible status ${response.status}`)

  if (response.text.includes(FAULT_TEXT.slice(0, 20))) fail("response contains the injected fault text")
  for (const [label, pattern] of LEAK_PATTERNS) {
    const match = pattern.exec(response.text)
    if (match) fail(`response leaks ${label} (${JSON.stringify(match[0])}): ${response.text.slice(0, 300)}`)
  }
  if (response.text.includes("FOREIGN_ROW_NAME_7e1")) fail("response contains another tenant's row")

  if (response.status >= 400) {
    const contentType = response.headers.get("content-type") ?? ""
    if (!/^application\/json\b/i.test(contentType)) fail(`error response is not JSON (content-type ${JSON.stringify(contentType)}): ${response.text.slice(0, 200)}`)
    const code = responseCode(response)
    if (code === undefined) fail(`error response has no code: ${response.text.slice(0, 200)}`)
    if (response.status < 500) {
      const allowed = DOCUMENTED_4XX[response.status]
      if (!allowed) fail(`undocumented status ${response.status}: ${response.text.slice(0, 200)}`)
      else if (code !== undefined && !allowed.includes(code)) fail(`status ${response.status} carries undocumented code ${code}`)
    }
  }

  const changed = observation.rowsBefore !== observation.rowsAfter
  if (changed && (response.status < 200 || response.status >= 300)) fail(`state changed with status ${response.status} (${request.method} ${request.target.slice(0, 120)})`)
  if (request.method === "GET" && changed) fail("a GET changed state")

  // Exchanges without a row store (the custom write handler) report no rows and skip the tenant checks.
  for (const seeded of observation.rows.size === 0 ? [] : SEED_ROWS) {
    if (seeded.tenantId !== FOREIGN_TENANT) continue
    const current = observation.rows.get(seeded.id)
    if (JSON.stringify(current) !== JSON.stringify(seeded)) fail(`another tenant's row ${seeded.id} changed: ${JSON.stringify(current)}`)
  }
  for (const row of observation.rows.values()) {
    if (row.tenantId !== OWN_TENANT && row.tenantId !== FOREIGN_TENANT) fail(`row ${row.id} has tenant ${String(row.tenantId)}`)
    const extra = Object.keys(row).filter((key) => !KNOWN_FIELDS.has(key))
    if (extra.length > 0) fail(`row ${row.id} gained unknown fields ${extra.join(", ")}`)
    if (Object.getPrototypeOf(row) !== Object.prototype) fail(`row ${row.id} has a foreign prototype`)
    if (typeof row.name !== "string" || typeof row.version !== "number") fail(`row ${row.id} has wrongly typed fields: ${JSON.stringify(row)}`)
  }
  for (const problem of pollutionProblems()) fail(problem)
  return problems
}

/** All transports must answer one input with the same status and public code, and leave the same state behind. */
export function parityProblems(observations: readonly Observation[]): string[] {
  const [first, ...rest] = observations
  if (!first) return []
  const summary = (observation: Observation) => `${observation.response.status}/${responseCode(observation.response) ?? "-"}`
  const problems: string[] = []
  // Node transports buffer and refuse a body over the limit (413) before the handler runs; a Fetch handler validates
  // path and query parameters first (docs/typescript/http-adapters.md, "Method and body matrix"), so on such a body
  // Hono may answer an earlier 4xx. Express and Fastify must still agree with each other.
  const oversize = (first.request.body?.byteLength ?? 0) > DEFAULT_MAX_JSON_BODY_BYTES
  for (const other of rest) {
    if (oversize && other.transport === "hono" && other.response.status !== 413 && other.response.status < 500) continue
    if (summary(other) !== summary(first)) problems.push(`adapters disagree: ${first.transport} answered ${summary(first)} but ${other.transport} answered ${summary(other)}`)
    else if (other.rowsAfter !== first.rowsAfter) problems.push(`adapters left different state: ${first.transport} vs ${other.transport}`)
  }
  return problems
}
