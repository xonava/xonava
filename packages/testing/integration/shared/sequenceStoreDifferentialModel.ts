import { encodeExecutionScopeId } from "@xonava/core/domain"
import type { Rng } from "../../../core/src/__tests__/differential/harness.js"

/**
 * Pure reference model of the sequence capability (docs/spec/sequence.md), independent of both the core implementation
 * and the stores: counters keyed by (scope, name, period) compared byte-for-byte, reset periods computed with the
 * offset-arithmetic oracle of primitiveSequence.differential.test.ts (zone offset read through
 * `timeZoneName: "longOffset"`, local date from plain Date arithmetic), and formatting written out from the spec.
 */

export const HOUR = 3_600_000

export type Reset = "never" | "year" | "month" | "day"
export type PeriodFormat = "none" | "compact" | "iso"

export interface DefSpec {
  reset: Reset
  periodFormat: PeriodFormat
  padding: number
  prefix?: string
  periodSeparator?: string
  timeZone: string
}

export interface AllocSpec { scope: string; name: string; def: DefSpec; at: number }

export type Op =
  | ({ k: "alloc" } & AllocSpec)
  /** Several allocations inside one database transaction that is committed or rolled back as a whole. */
  | { k: "tx"; commit: boolean; allocs: AllocSpec[] }

export interface Counter { scope: string; name: string; period: string; value: number }

export type RefOutcome = { ok: { scope: string; name: string; period: string; value: number; formatted: string } } | { error: "ConfigurationError" }

export const ZONES = [
  "UTC", "Asia/Kolkata", "Asia/Kathmandu", "America/New_York", "America/St_Johns", "Europe/London", "Europe/Berlin", "Australia/Lord_Howe",
  "Pacific/Kiritimati", "Pacific/Pago_Pago", "Pacific/Apia", "America/Sao_Paulo", "America/Havana", "Asia/Beirut", "Pacific/Auckland", "Etc/GMT+12", "Etc/GMT-14",
] as const

/** Instants near historical and current daylight-saving transitions and skipped days, as [zone, instant]. */
const ANCHORS: ReadonlyArray<readonly [string, number]> = [
  ["America/New_York", Date.UTC(2026, 2, 8, 7)], ["America/New_York", Date.UTC(2026, 10, 1, 6)],
  ["Europe/London", Date.UTC(2026, 2, 29, 1)], ["Europe/London", Date.UTC(2026, 9, 25, 1)],
  ["Europe/Berlin", Date.UTC(2026, 9, 25, 1)], ["Australia/Lord_Howe", Date.UTC(2026, 9, 3, 15, 30)], ["Australia/Lord_Howe", Date.UTC(2026, 3, 4, 15)],
  ["Pacific/Auckland", Date.UTC(2026, 3, 4, 14)], ["America/Sao_Paulo", Date.UTC(2018, 10, 4, 3)], ["America/Sao_Paulo", Date.UTC(2019, 1, 17, 2)],
  ["America/Havana", Date.UTC(2026, 2, 8, 5)], ["Asia/Beirut", Date.UTC(2026, 2, 28, 22)], ["Pacific/Apia", Date.UTC(2011, 11, 30, 10)],
  ["Pacific/Kiritimati", Date.UTC(1994, 11, 31, 10)], ["America/St_Johns", Date.UTC(2026, 2, 8, 5, 30)], ["Asia/Kolkata", Date.UTC(2026, 2, 31, 18, 30)],
  ["Asia/Kathmandu", Date.UTC(1985, 11, 31, 18, 30)], ["Etc/GMT-14", Date.UTC(2026, 11, 31, 10)], ["Etc/GMT+12", Date.UTC(2026, 0, 1, 12)],
]

/**
 * Scope identities as the framework produces them (`fscope:v1:` + base64url of the canonical scope JSON): case-sensitive ASCII
 * without spaces, from a few characters up to several hundred.
 */
export const SCOPES: readonly string[] = [
  { kind: "tenant", tenantId: "tenant-a" }, { kind: "tenant", tenantId: "Tenant-A" }, { kind: "tenant", tenantId: "tenant-b" }, { kind: "tenant", tenantId: "t" },
  { kind: "platform", platformKey: "default" }, { kind: "system", systemKey: "framework" }, { kind: "tenant", tenantId: "x".repeat(300) },
].map((scope) => encodeExecutionScopeId(scope as never))

/** Scope strings outside what the framework produces that the capability still accepts (any string up to 1024 characters without NUL/CR/LF). */
export const EXOTIC_SCOPES = {
  caseAndTab: ["tenant-a", "Tenant-A", "tenant-a\t", "tenant-a\tb"],
  trailingSpace: ["tenant-a", "tenant-a ", "tenant-a  "],
  nonAscii: ["\u00df", "ss", "\u65e5\u672c\u8a9e", "\u65e5\u672c", "\u00e9", "e\u0301"],
} as const
/** Scopes the core refuses before the store is called. */
export const INVALID_SCOPES = ["", "a\0b", "a\nb", "a\rb", "x".repeat(1025)] as const
export const NAMES = ["invoice", "Invoice", "inv.2", "a:b-c", "N".repeat(128)] as const

const offsetFormatters = new Map<string, Intl.DateTimeFormat>()

/** Zone offset in ms at the instant, parsed from "GMT", "GMT+05:30" or "GMT-03:30:12". */
function offsetMs(timeZone: string, at: number): number {
  let formatter = offsetFormatters.get(timeZone)
  if (!formatter) { formatter = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }); offsetFormatters.set(timeZone, formatter) }
  const name = formatter.formatToParts(at).find((part) => part.type === "timeZoneName")!.value
  if (name === "GMT") return 0
  const match = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(name.replace("−", "-"))
  if (!match) throw new Error(`unparseable offset ${name}`)
  const total = (Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4] ?? 0)) * 1000
  return match[1] === "-" ? -total : total
}

/** The reset period of the instant in the zone; null when the local year is outside 1..9999 (the core rejects it). */
export function oraclePeriod(reset: Reset, at: number, timeZone: string): string | null {
  if (reset === "never") return "all"
  const local = new Date(at + offsetMs(timeZone, at))
  const year = local.getUTCFullYear()
  if (year < 1 || year > 9999) return null
  const pad = (n: number, width: number): string => String(n).padStart(width, "0")
  const y = pad(year, 4)
  if (reset === "year") return y
  if (reset === "month") return `${y}-${pad(local.getUTCMonth() + 1, 2)}`
  return `${y}-${pad(local.getUTCMonth() + 1, 2)}-${pad(local.getUTCDate(), 2)}`
}

/** First instant (to the millisecond) after `near` whose period differs from the period at `near`, or undefined. */
export function nextBoundary(reset: Reset, timeZone: string, near: number): number | undefined {
  if (reset === "never") return undefined
  const first = oraclePeriod(reset, near, timeZone)
  if (first === null) return undefined
  const step = 6 * HOUR
  const limit = reset === "year" ? 1500 : reset === "month" ? 130 : 8
  for (let i = 1; i <= limit; i++) {
    const t = near + i * step
    const period = oraclePeriod(reset, t, timeZone)
    if (period === null) return undefined
    if (period === first) continue
    let lo = t - step
    let hi = t
    while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (oraclePeriod(reset, mid, timeZone) === first) lo = mid; else hi = mid }
    return hi
  }
  return undefined
}

export function scopeIsValid(scope: string): boolean { return scope.length > 0 && scope.length <= 1024 && !/[\0\r\n]/.test(scope) }

export function counterKey(scope: string, name: string, period: string): string { return `${scope}\u0001${name}\u0001${period}` }

/** The documented formatted value: prefix + (period token + separator) + zero-padded number. */
export function oracleFormat(def: DefSpec, period: string, value: number): string {
  const token = def.periodFormat === "none" ? "" : `${def.periodFormat === "compact" ? period.split("-").join("") : period}${def.periodSeparator ?? "-"}`
  return `${def.prefix ?? ""}${token}${String(value).padStart(def.padding, "0")}`
}

export class RefSequence {
  readonly counters = new Map<string, Counter>()

  /** Allocates against `counters` (the committed state by default, or a transaction overlay). */
  alloc(spec: AllocSpec, counters: Map<string, Counter> = this.counters): RefOutcome {
    if (!scopeIsValid(spec.scope)) return { error: "ConfigurationError" }
    const period = oraclePeriod(spec.def.reset, spec.at, spec.def.timeZone)
    if (period === null) return { error: "ConfigurationError" }
    const key = counterKey(spec.scope, spec.name, period)
    const current = counters.get(key)
    const value = (current?.value ?? 0) + 1
    counters.set(key, { scope: spec.scope, name: spec.name, period, value })
    return { ok: { scope: spec.scope, name: spec.name, period, value, formatted: oracleFormat(spec.def, period, value) } }
  }

  /** Runs a transaction: committed allocations persist, rolled-back ones leave the counters untouched. */
  tx(op: Extract<Op, { k: "tx" }>): RefOutcome[] {
    const overlay = new Map(this.counters)
    const outcomes = op.allocs.map((spec) => this.alloc(spec, overlay))
    if (op.commit) for (const [key, counter] of overlay) this.counters.set(key, counter)
    return outcomes
  }

  dump(): Counter[] { return [...this.counters.values()].sort(compareCounters) }
}

export function compareCounters(a: Counter, b: Counter): number {
  const left = counterKey(a.scope, a.name, a.period)
  const right = counterKey(b.scope, b.name, b.period)
  return left < right ? -1 : left > right ? 1 : 0
}

// ---------------------------------------------------------------------------------------------------------------
// Generation

export function generateDef(rng: Rng, forceReset?: Reset): DefSpec {
  const reset = forceReset ?? rng.pick(["never", "year", "month", "day", "day", "month"] as const)
  const periodFormat: PeriodFormat = reset === "never" ? "none" : rng.pick(["none", "compact", "iso", "iso"] as const)
  return {
    reset, periodFormat, padding: rng.pick([0, 0, 1, 3, 6]), timeZone: rng.pick(ZONES),
    ...(rng.bool(0.5) ? { prefix: rng.pick(["INV-", "A", "9", "X/", "Q 3:"]) } : {}),
    ...(rng.bool(0.4) ? { periodSeparator: rng.pick(["", "-", "/", "ab", "0"]) } : {}),
  }
}

/** 0001-01-01T00:00:00Z (Date.UTC maps years 0..99 to 1900..1999, so the year is set explicitly). */
const yearOne = new Date(Date.UTC(2000, 0, 1)).setUTCFullYear(1)

export function generateInstant(rng: Rng): number {
  const roll = rng.int(10)
  if (roll === 0) return rng.pick([yearOne, yearOne - 1, yearOne - 365 * 24 * HOUR, Date.UTC(9999, 11, 31, 23, 59, 59, 999), Date.UTC(10000, 0, 1), Date.UTC(1969, 11, 31, 23, 59, 59, 999), 0])
  if (roll < 4) return Date.UTC(2024, 0, 1) + rng.int(3 * 365 * 24) * HOUR + rng.int(HOUR)
  return Date.UTC(1950, 0, 1) + rng.int(110 * 365 * 24) * HOUR + rng.int(HOUR)
}

/** A key (scope, name) plus a definition whose zone/reset puts `at` around a period boundary, as 3 allocations (before, on, after). */
function boundaryBundle(rng: Rng): AllocSpec[] {
  const anchored = rng.bool(0.5)
  const [zone, anchor] = anchored ? rng.pick(ANCHORS) : [rng.pick(ZONES), generateInstant(rng)] as const
  const def = { ...generateDef(rng, rng.pick(["day", "day", "month", "year"] as const)), timeZone: zone }
  const boundary = nextBoundary(def.reset, zone, anchor - rng.int(30) * HOUR)
  const scope = rng.pick(SCOPES)
  const name = rng.pick(NAMES)
  if (boundary === undefined) return [{ scope, name, def, at: anchor }]
  return [-1, 0, 1].map((delta) => ({ scope, name, def, at: boundary + delta }))
}

function generateAlloc(rng: Rng): AllocSpec[] {
  if (rng.bool(0.3)) return boundaryBundle(rng)
  const scope = rng.bool(0.04) ? rng.pick(INVALID_SCOPES) : rng.pick(SCOPES)
  // Few distinct keys so counters actually advance.
  const def = rng.bool(0.5) ? { reset: "never" as const, periodFormat: "none" as const, padding: 3, timeZone: "UTC" } : generateDef(rng)
  const at = rng.bool(0.5) ? Date.UTC(2026, 5, 1) + rng.int(4) * 12 * HOUR : generateInstant(rng)
  return [{ scope, name: rng.pick(NAMES.slice(0, 3)), def, at }]
}

export interface GenerateOptions { transactional: boolean; min?: number; max?: number }

export function generateOps(rng: Rng, options: GenerateOptions): Op[] {
  const target = (options.min ?? 5) + rng.int((options.max ?? 24) - (options.min ?? 5) + 1)
  const ops: Op[] = []
  while (ops.length < target) {
    if (options.transactional && rng.bool(0.25)) {
      const allocs = Array.from({ length: 1 + rng.int(3) }, () => generateAlloc(rng)).flat()
      ops.push({ k: "tx", commit: rng.bool(0.5), allocs })
    } else for (const spec of generateAlloc(rng)) ops.push({ k: "alloc", ...spec })
  }
  return ops
}

export function* shrinkOps(ops: Op[]): Iterable<Op[]> {
  for (let i = 0; i < ops.length; i++) yield [...ops.slice(0, i), ...ops.slice(i + 1)]
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    if (op.k === "tx") {
      yield [...ops.slice(0, i), ...op.allocs.map((spec) => ({ k: "alloc", ...spec }) as Op), ...ops.slice(i + 1)]
      if (op.allocs.length > 1) for (let j = 0; j < op.allocs.length; j++) yield [...ops.slice(0, i), { ...op, allocs: op.allocs.filter((_, index) => index !== j) }, ...ops.slice(i + 1)]
    }
  }
}

export function describeAlloc(spec: AllocSpec): string {
  const d = spec.def
  return `${JSON.stringify(spec.scope.length > 24 ? `${spec.scope.slice(0, 8)}...(${spec.scope.length})` : spec.scope)}/${spec.name.length > 24 ? `${spec.name.slice(0, 8)}...(${spec.name.length})` : spec.name} ` +
    `${d.reset}/${d.periodFormat}/pad${d.padding}/${d.timeZone}${d.prefix === undefined ? "" : `/prefix=${JSON.stringify(d.prefix)}`}${d.periodSeparator === undefined ? "" : `/sep=${JSON.stringify(d.periodSeparator)}`} ` +
    `at ${Number.isFinite(spec.at) && Math.abs(spec.at) <= 8.64e15 ? new Date(spec.at).toISOString() : String(spec.at)}`
}

export function describeOps(ops: Op[]): string {
  return ops.map((op, index) => op.k === "alloc" ? `${index}: alloc ${describeAlloc(op)}` : `${index}: tx ${op.commit ? "commit" : "rollback"} [${op.allocs.map(describeAlloc).join(" | ")}]`).join("\n")
}
